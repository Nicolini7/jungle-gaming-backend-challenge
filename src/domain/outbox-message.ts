import { DomainError } from "./domain-error.ts";
import { immutableJSON } from "./integration-event.ts";
import type { IntegrationEvent } from "./integration-event.ts";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export class OutboxMessage {
  public readonly id: string;
  public readonly aggregateId: string;
  public readonly eventType: string;
  public readonly payload: Readonly<Record<string, unknown>>;
  private readonly _occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _publishedAt: Date | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = immutableJSON(state.payload);
    this._occurredAt = new Date(state.occurredAt);
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined;
    this._publishedAt = state.publishedAt ? new Date(state.publishedAt) : undefined;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({ id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: { ...event.toJSON() }, occurredAt: event.occurredAt, attempts: 0 });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get occurredAt(): Date { return new Date(this._occurredAt); }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined; }
  get publishedAt(): Date | undefined { return this._publishedAt ? new Date(this._publishedAt) : undefined; }

  isPending(): boolean { return this._publishedAt === undefined; }
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Backoff exponencial de 1s até 60s; eventos confirmados não expiram silenciosamente. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this._attempts - 1, 6));
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  private assertPending(): void {
    if (!this.isPending()) throw new DomainError("INVALID_OUTBOX_STATE", "Published event cannot transition again.");
  }
}
