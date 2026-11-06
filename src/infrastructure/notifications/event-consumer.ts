import type { Message } from "@aws-sdk/client-sqs";
import { AppError } from "../../application/errors.ts";
import type { SqsGateway } from "../messaging/sqs-gateway.ts";
import type { WorkerTelemetry } from "../messaging/background-workers.ts";
import type { EventProjector } from "./event-projector.ts";
import { changeVisibilityWithin, visibilityHeartbeat } from "../messaging/visibility-heartbeat.ts";

type ProjectionResult = Awaited<ReturnType<EventProjector["process"]>>;
export interface EventConsumerOptions {
  pollWaitSeconds?: number;
  shutdownGraceMs?: number;
  cleanupTimeoutMs?: number;
  beforeAck?: (context: { message: Message; result: ProjectionResult }) => void | Promise<void>;
}

/** Internal in-app records and read projections; no external notification delivery. */
export class SqsEventConsumer {
  private running = false;
  private task: Promise<void> | undefined;
  private readonly polls = new Set<AbortController>();
  private readonly active = new Map<string, () => Promise<void>>();
  private readonly inFlight = new Set<Promise<number>>();

  constructor(private readonly projector: Pick<EventProjector, "process">,
    private readonly gateway: SqsGateway, private readonly telemetry: WorkerTelemetry,
    private readonly options: EventConsumerOptions = {}) {}

  start(): void {
    if (this.running) return;
    if (!this.gateway.eventDlqUrl) throw new Error("Initialize the event consumer queue before starting.");
    this.running = true;
    this.task = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const controller of this.polls) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      Promise.allSettled([this.task ?? Promise.resolve(), ...this.inFlight]).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.options.shutdownGraceMs ?? 25_000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!finished) await Promise.allSettled([...this.active].map(async ([receipt, stop]) => {
      await stop();
      await changeVisibilityWithin(signal => this.gateway.changeEventVisibility(receipt, 0, signal), this.options.cleanupTimeoutMs ?? 2000);
    }));
  }

  pollOnce(waitTimeSeconds = this.options.pollWaitSeconds ?? 10): Promise<number> {
    const work = this.poll(waitTimeSeconds);
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }

  private async poll(waitTimeSeconds: number): Promise<number> {
    const controller = new AbortController();
    this.polls.add(controller);
    let messages: Message[];
    try { messages = await this.gateway.receiveEvents(waitTimeSeconds, controller.signal); }
    finally { this.polls.delete(controller); }
    await Promise.all(messages.map(message => this.processMessage(message)));
    return messages.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try { await this.pollOnce(); }
      catch (error) {
        if (this.running) this.telemetry.log("event_consumer_error", { failureCode: errorCode(error) });
      }
      if (this.running) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    const stopHeartbeat = visibilityHeartbeat(signal => this.gateway.changeEventVisibility(receipt, this.gateway.visibilityTimeout, signal),
      Math.max(200, Math.floor(this.gateway.visibilityTimeout * 1000 / 3)), this.options.cleanupTimeoutMs ?? 2000,
      error => this.telemetry.log("event_visibility_error", { failureCode: errorCode(error) }));
    this.active.set(receipt, stopHeartbeat);
    const receives = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? "1") || 1);
    try {
      let body: unknown;
      try { body = JSON.parse(message.Body ?? ""); }
      catch { throw new AppError(400, "INVALID_FINANCIAL_EVENT"); }
      const result = await this.projector.process(body);
      await this.options.beforeAck?.({ message, result });
      await stopHeartbeat();
      await this.gateway.acknowledgeEvent(receipt);
      this.telemetry.increment("integration_events_total", { status: result.duplicate ? "duplicate" : "processed" });
    } catch (error) {
      await stopHeartbeat();
      const permanent = error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && ![408, 429].includes(error.statusCode);
      if (permanent || receives >= this.gateway.maxReceives) {
        await this.gateway.deadLetterEvent(message, errorCode(error), receives);
        await this.gateway.acknowledgeEvent(receipt);
        this.telemetry.increment("dlq_messages_total");
      } else {
        await this.gateway.changeEventVisibility(receipt, Math.min(300, 2 ** Math.min(receives, 9)));
        this.telemetry.increment("retries_total", { worker: "event_consumer" });
      }
      this.telemetry.log("event_consumer_retry_or_dlq", { failureCode: errorCode(error), receiveCount: receives });
    } finally {
      await stopHeartbeat();
      this.active.delete(receipt);
    }
  }
}

export { SqsEventConsumer as EventConsumer };

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}
