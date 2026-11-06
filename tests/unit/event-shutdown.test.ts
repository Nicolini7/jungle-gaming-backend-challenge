import { describe, expect, test } from "bun:test";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway.ts";
import type { WorkerTelemetry } from "../../src/infrastructure/messaging/background-workers.ts";
import { SqsEventConsumer } from "../../src/infrastructure/notifications/event-consumer.ts";

describe("Event consumer shutdown under stalled transport I/O", () => {
  test("bounds cleanup when both heartbeat and visibility restoration ignore cancellation", async () => {
    let releaseProcess = () => {};
    let releaseHeartbeat = () => {};
    let releaseVisibility = () => {};
    let heartbeatStarted = () => {};
    const processing = new Promise<void>(resolve => { releaseProcess = resolve; });
    const heartbeat = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
    const visibility = new Promise<void>(resolve => { releaseVisibility = resolve; });
    const started = new Promise<void>(resolve => { heartbeatStarted = resolve; });
    let restorationAttempted = false;
    let heartbeatSignal: AbortSignal | undefined;
    let restorationSignal: AbortSignal | undefined;
    const gateway = {
      eventDlqUrl: "test-dlq", visibilityTimeout: 1, maxReceives: 5,
      receiveEvents: async () => [{ ReceiptHandle: "test-receipt", Body: "{}" }],
      changeEventVisibility: async (_receipt: string, seconds: number, signal?: AbortSignal) => {
        if (seconds === 1) {
          heartbeatSignal = signal;
          heartbeatStarted();
          await heartbeat;
        } else {
          restorationAttempted = true;
          restorationSignal = signal;
          await visibility;
        }
      },
      acknowledgeEvent: async () => {},
    } as unknown as SqsGateway;
    const telemetry: WorkerTelemetry = { increment() {}, observe() {}, log() {} };
    const worker = new SqsEventConsumer({ process: async () => {
      await processing;
      return { duplicate: false, projectionApplied: false, notificationApplied: false };
    } }, gateway, telemetry, { shutdownGraceMs: 10, cleanupTimeoutMs: 20 });
    const polling = worker.pollOnce(0);
    let closing: Promise<void> | undefined;
    let startTimeout: ReturnType<typeof setTimeout> | undefined;
    let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => {
        startTimeout = setTimeout(() => reject(new Error("Heartbeat did not begin")), 2000);
      })]);
      if (startTimeout) { clearTimeout(startTimeout); startTimeout = undefined; }
      closing = worker.stop();
      const returned = await Promise.race([closing.then(() => true), new Promise<false>(resolve => {
        shutdownTimeout = setTimeout(() => resolve(false), 200);
      })]);
      expect(returned).toBe(true);
      expect(restorationAttempted).toBe(true);
      expect(heartbeatSignal?.aborted).toBe(true);
      expect(restorationSignal?.aborted).toBe(true);
    } finally {
      if (startTimeout) clearTimeout(startTimeout);
      if (shutdownTimeout) clearTimeout(shutdownTimeout);
      releaseProcess();
      releaseHeartbeat();
      releaseVisibility();
      await Promise.allSettled([polling, closing ?? worker.stop()]);
    }
  }, 5000);
});
