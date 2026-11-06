import { DomainError } from "./domain-error.ts";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventJSON<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Readonly<T>;
}

/** Copia o payload JSON antes de congelá-lo, sem congelar objetos do chamador. */
export function immutableJSON<T>(value: T): Readonly<T> {
  let copy: T;
  try {
    copy = JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new DomainError("INVALID_EVENT_PAYLOAD", "Integration payload must be JSON serializable.");
  }
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object") {
      for (const nested of Object.values(item)) freeze(nested);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    if (!props.eventId || !props.aggregateId || !props.correlationId || !Number.isFinite(props.occurredAt.getTime())) {
      throw new DomainError("INVALID_EVENT_ENVELOPE", "Event identity, correlation and occurrence date are required.");
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt);
    this.data = immutableJSON(props.data);
  }

  get occurredAt(): Date { return new Date(this._occurredAt); }

  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export class WagerTransactionProcessed<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionProcessed<T> {
    return new WagerTransactionProcessed(props);
  }
  static rehydrate<T>(props: IntegrationEventProps<T>): WagerTransactionProcessed<T> {
    return new WagerTransactionProcessed(props);
  }
}

export class WagerTransactionRejected<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionRejected<T> {
    return new WagerTransactionRejected(props);
  }
  static rehydrate<T>(props: IntegrationEventProps<T>): WagerTransactionRejected<T> {
    return new WagerTransactionRejected(props);
  }
}

export class WagerTransactionPendingReference<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionPendingReference<T> {
    return new WagerTransactionPendingReference(props);
  }
  static rehydrate<T>(props: IntegrationEventProps<T>): WagerTransactionPendingReference<T> {
    return new WagerTransactionPendingReference(props);
  }
}

export class WalletBalanceChanged<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WalletBalanceChanged<T> {
    return new WalletBalanceChanged(props);
  }
  static rehydrate<T>(props: IntegrationEventProps<T>): WalletBalanceChanged<T> {
    return new WalletBalanceChanged(props);
  }
}
