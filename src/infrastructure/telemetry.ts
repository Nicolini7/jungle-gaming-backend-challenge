import { Counter, Gauge, Histogram, Registry } from "prom-client";

const LOG_FIELDS = new Set([
  "correlationId", "messageId", "transactionId", "walletId", "providerId", "status",
  "code", "errorCode", "attempt", "attempts", "durationMs", "instance", "port", "count",
  "eventId", "eventType", "consumerName", "reason", "signal", "queue", "operation",
  "failureCode", "receiveCount", "worker", "inFlight",
]);

export class Telemetry {
  readonly registry = new Registry();
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, Gauge>();

  constructor(private readonly silent = false) {
    const definitions: Array<[string, string[], string[]]> = [
      ["transactions_total", ["status"], ["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"]],
      ["sqs_messages_total", ["status"], ["PROCESSED", "REJECTED", "PENDING_REFERENCE"]],
      ["retries_total", ["worker"], ["consumer", "outbox"]],
      ["worker_errors_total", ["worker"], ["sqs_consumer", "outbox_publisher", "reference_worker"]],
    ];
    for (const [name, labels, values] of definitions) {
      const counter = new Counter({ name: this.metricName(name), help: name, labelNames: labels, registers: [this.registry] });
      this.counters.set(this.metricName(name), counter);
      for (const value of values) counter.inc({ [labels[0]!]: value }, 0);
    }
    for (const name of ["duplicates_total", "lock_conflicts_total", "dlq_messages_total", "outbox_published_total", "reference_retries_total", "reconciliation_mismatches_total"]) {
      const counter = new Counter({ name: this.metricName(name), help: name, registers: [this.registry] });
      counter.inc(0);
      this.counters.set(this.metricName(name), counter);
    }
  }

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = this.metricName(name);
    let counter = this.counters.get(key);
    if (!counter) {
      counter = new Counter({ name: key, help: name, labelNames: Object.keys(labels).sort(), registers: [this.registry] });
      this.counters.set(key, counter);
    }
    counter.inc(labels);
  }

  observe(name: string, value: number): void {
    const key = this.metricName(name);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = new Histogram({ name: key, help: name, registers: [this.registry], buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 60, 300] });
      this.histograms.set(key, histogram);
    }
    histogram.observe(value);
  }

  set(name: string, value: number): void {
    const key = this.metricName(name);
    let gauge = this.gauges.get(key);
    if (!gauge) {
      gauge = new Gauge({ name: key, help: name, registers: [this.registry] });
      this.gauges.set(key, gauge);
    }
    gauge.set(value);
  }

  log(event: string, context: Record<string, unknown> = {}): void {
    if (this.silent) return;
    const safe: Record<string, unknown> = {
      timestamp: new Date().toISOString(), event, correlationId: null, messageId: null,
      transactionId: null, walletId: null, providerId: null,
    };
    for (const [key, value] of Object.entries(context)) {
      if (LOG_FIELDS.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))) safe[key] = value;
    }
    console.log(JSON.stringify(safe));
  }

  private metricName(name: string): string {
    return `jungle_${name.replace(/[^a-zA-Z0-9_:]/g, "_")}`;
  }
}
