import type { Message } from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { DomainError } from "../../domain/domain-error.ts";
import type { Database } from "../database/database.ts";
import { OutboxRow } from "../database/rows.ts";
import { SqsGateway } from "./sqs-gateway.ts";
import { changeVisibilityWithin, visibilityHeartbeat } from "./visibility-heartbeat.ts";

export interface SubmissionResult {
  transactionId: string;
  status: string;
}

export interface WorkerProcessor {
  submit(
    data: unknown,
    idempotencyKey: string,
    context: {
      correlationId: string;
      inbox?: { consumerName: string; messageId: string; payloadHash: string };
    },
  ): Promise<SubmissionResult>;
  retryPending(limit?: number): Promise<number>;
}

export interface WorkerTelemetry {
  increment(name: string, labels?: Record<string, string>): void;
  observe(name: string, value: number): void;
  log(event: string, context?: Record<string, unknown>): void;
}

export interface BackgroundWorkerOptions {
  publishIntervalMs?: number;
  referenceIntervalMs?: number;
  pollWaitSeconds?: number;
  shutdownGraceMs?: number;
  publisherBatchSize?: number;
  visibilityCleanupTimeoutMs?: number;
  beforeAck?: (context: { message: Message; result: SubmissionResult }) => Promise<void> | void;
}

interface PendingEvent {
  id: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

interface ActiveMessage {
  receipt: string;
  stopHeartbeat(): Promise<void>;
}

/** Independent loops are safe to run in every app process. */
export class BackgroundWorkers {
  private running = false;
  private tasks: Promise<void>[] = [];
  private readonly polls = new Set<AbortController>();
  private readonly active = new Map<string, ActiveMessage>();
  private readonly options: Required<Omit<BackgroundWorkerOptions, "beforeAck">> & Pick<BackgroundWorkerOptions, "beforeAck">;

  constructor(
    private readonly database: Database,
    private readonly gateway: SqsGateway,
    private readonly processor: WorkerProcessor,
    private readonly telemetry: WorkerTelemetry,
    options: BackgroundWorkerOptions = {},
  ) {
    this.options = {
      publishIntervalMs: options.publishIntervalMs ?? 1000,
      referenceIntervalMs: options.referenceIntervalMs ?? 1000,
      pollWaitSeconds: options.pollWaitSeconds ?? 10,
      shutdownGraceMs: options.shutdownGraceMs ?? 25_000,
      publisherBatchSize: options.publisherBatchSize ?? 10,
      visibilityCleanupTimeoutMs: options.visibilityCleanupTimeoutMs ?? 2000,
      ...(options.beforeAck ? { beforeAck: options.beforeAck } : {}),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tasks = [
      this.loop("sqs_consumer", () => this.pollOnce(), 100),
      this.loop("outbox_publisher", () => this.publishOnce(), this.options.publishIntervalMs),
      this.loop("reference_worker", () => this.retryReferencesOnce(), this.options.referenceIntervalMs),
    ];
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const poll of this.polls) poll.abort();
    const completed = Promise.allSettled(this.tasks).then(() => true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.options.shutdownGraceMs);
    });
    const drained = await Promise.race([completed, expired]);
    if (timeout) clearTimeout(timeout);
    if (!drained) {
      this.telemetry.log("worker_shutdown_visibility_returned", { inFlight: this.active.size });
      await Promise.allSettled([...this.active.values()].map(async (message) => {
        await message.stopHeartbeat();
        await changeVisibilityWithin(signal => this.gateway.changeVisibility(message.receipt, 0, signal), this.options.visibilityCleanupTimeoutMs);
      }));
    }
  }

  async publishOnce(): Promise<number> {
    return this.database.transaction(async (em) => {
      // A publisher owns these rows until commit. An abrupt exit releases the locks.
      const events = await em.query<PendingEvent[]>(`
        SELECT id, aggregate_id AS "aggregateId", payload,
               occurred_at AS "occurredAt", attempts
          FROM outbox
         WHERE published_at IS NULL AND next_attempt_at <= now()
         ORDER BY occurred_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      `, [this.options.publisherBatchSize]);
      let published = 0;
      for (const event of events) {
        this.telemetry.observe("outbox_lag_seconds", Math.max(0, Date.now() - new Date(event.occurredAt).getTime()) / 1000);
        try {
          await this.gateway.sendEvent(event.payload, event.id, event.aggregateId);
        } catch (error) {
          const attempts = event.attempts + 1;
          const retrySeconds = Math.min(300, 2 ** Math.min(attempts, 9));
          await em.update(OutboxRow, { id: event.id }, {
            attempts,
            nextAttemptAt: new Date(Date.now() + retrySeconds * 1000),
          });
          this.telemetry.increment("retries_total", { worker: "outbox" });
          this.telemetry.log("outbox_publish_retry", {
            eventId: event.id,
            walletId: event.aggregateId,
            attempts,
            failureCode: errorCode(error),
          });
          continue;
        }
        // The broker can accept and the process can die before this update. eventId is stable.
        await em.update(OutboxRow, { id: event.id }, { publishedAt: new Date() });
        this.telemetry.increment("outbox_published_total");
        published += 1;
      }
      return published;
    });
  }

  async pollOnce(waitTimeSeconds = this.options.pollWaitSeconds): Promise<number> {
    const abort = new AbortController();
    this.polls.add(abort);
    let messages: Message[];
    try {
      messages = await this.gateway.receive(waitTimeSeconds, abort.signal);
    } finally {
      this.polls.delete(abort);
    }
    await Promise.all(messages.map((message) => this.processMessage(message)));
    return messages.length;
  }

  async retryReferencesOnce(): Promise<number> {
    return this.processor.retryPending(20);
  }

  private async loop(name: string, action: () => Promise<unknown>, intervalMs: number): Promise<void> {
    while (this.running) {
      try {
        await action();
      } catch (error) {
        if (this.running) {
          this.telemetry.increment("worker_errors_total", { worker: name });
          this.telemetry.log("worker_error", { worker: name, failureCode: errorCode(error) });
        }
      }
      if (this.running) await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    const receiveCount = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? "1"));
    const stopHeartbeat = visibilityHeartbeat(signal => this.gateway.changeVisibility(receipt, this.gateway.visibilityTimeout, signal),
      Math.max(250, Math.floor(this.gateway.visibilityTimeout * 1000 / 3)), this.options.visibilityCleanupTimeoutMs, (error: unknown) => {
        this.telemetry.log("visibility_extension_failed", {
          messageId: message.MessageId,
          failureCode: errorCode(error),
        });
      });
    this.active.set(receipt, { receipt, stopHeartbeat });
    const started = performance.now();
    let context: Record<string, unknown> = { messageId: message.MessageId };
    try {
      const envelope = parseEnvelope(message.Body);
      const { idempotencyKey, ...command } = envelope.data;
      const correlationId = envelope.correlationId ?? envelope.messageId;
      context = {
        correlationId,
        messageId: envelope.messageId,
        walletId: typeof command.walletId === "string" ? command.walletId : undefined,
        providerId: typeof command.providerId === "string" ? command.providerId : undefined,
      };
      const result = await this.processor.submit(command, idempotencyKey, {
        correlationId,
        inbox: {
          consumerName: "wager-transactions-v1",
          messageId: envelope.messageId,
          payloadHash: createHash("sha256").update(canonicalJson(envelope)).digest("hex"),
        },
      });
      context.transactionId = result.transactionId;
      await this.options.beforeAck?.({ message, result });
      this.crashAfterCommitIfRequested(result, context);
      await stopHeartbeat();
      // submit() only resolves after the database commit, even for a business rejection.
      await this.gateway.acknowledge(receipt);
      this.telemetry.increment("sqs_messages_total", { status: result.status });
      this.telemetry.log("sqs_message_acknowledged", context);
    } catch (error) {
      await stopHeartbeat();
      if (isPermanent(error) || receiveCount >= this.gateway.maxReceives) {
        // Confirm to the source only after durable DLQ publication succeeds.
        await this.gateway.deadLetter(message, errorCode(error), receiveCount);
        await this.gateway.acknowledge(receipt);
        this.telemetry.increment("dlq_messages_total");
        this.telemetry.log("sqs_message_dead_lettered", { ...context, receiveCount, failureCode: errorCode(error) });
      } else {
        const seconds = Math.min(300, 2 ** Math.min(receiveCount, 9));
        await this.gateway.changeVisibility(receipt, seconds);
        this.telemetry.increment("retries_total", { worker: "consumer" });
        this.telemetry.log("sqs_message_retry", { ...context, receiveCount, failureCode: errorCode(error) });
      }
    } finally {
      await stopHeartbeat();
      this.active.delete(receipt);
      this.telemetry.observe("sqs_processing_duration_seconds", (performance.now() - started) / 1000);
    }
  }

  private crashAfterCommitIfRequested(result: SubmissionResult, context: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== "test" || process.env.CHAOS_AFTER_COMMIT_BEFORE_ACK !== "1") return;
    const marker = process.env.CHAOS_MARKER_FILE;
    if (marker && existsSync(marker)) return;
    if (marker) writeFileSync(marker, JSON.stringify({ transactionId: result.transactionId, committed: true }));
    this.telemetry.log("chaos_exit_after_commit_before_ack", context);
    process.exit(137);
  }
}

interface Envelope {
  messageId: string;
  type: "WagerTransactionRequested";
  occurredAt: string;
  correlationId?: string;
  data: Record<string, unknown> & { idempotencyKey: string };
}

class PermanentMessageError extends Error {
  readonly permanent = true;
  readonly code = "INVALID_MESSAGE_ENVELOPE";
}

const occurredAtSchema = z.iso.datetime({ offset: true });

function parseEnvelope(body: string | undefined): Envelope {
  let value: unknown;
  try { value = JSON.parse(body ?? ""); } catch { throw new PermanentMessageError("Message is not valid JSON."); }
  if (!isRecord(value) || typeof value.messageId !== "string" || value.messageId.length < 1 || value.messageId.length > 255 || value.messageId.includes("\0") ||
      value.type !== "WagerTransactionRequested" || typeof value.occurredAt !== "string" ||
      !occurredAtSchema.safeParse(value.occurredAt).success || !isRecord(value.data) ||
      typeof value.data.idempotencyKey !== "string" || value.data.idempotencyKey.length < 1 ||
      value.data.idempotencyKey.length > 180 || value.data.idempotencyKey.includes("\0") ||
      (value.correlationId !== undefined && (typeof value.correlationId !== "string" || value.correlationId.length < 1 || value.correlationId.length > 180 || value.correlationId.includes("\0")))) {
    throw new PermanentMessageError("Invalid WagerTransactionRequested envelope.");
  }
  return value as unknown as Envelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonical ordering is shared recursively by financial envelope hashes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.name;
  return "UNKNOWN_ERROR";
}

function isPermanent(error: unknown): boolean {
  if (error instanceof DomainError) return true;
  if (!isRecord(error)) return false;
  if (error.permanent === true) return true;
  const status = error.statusCode ?? error.httpStatus ?? error.status;
  return typeof status === "number" && [400, 401, 403, 404, 409, 422].includes(status);
}
