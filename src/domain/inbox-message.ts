import { DomainError } from "./domain-error.ts";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date | undefined;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/** Persistido com o efeito financeiro: uma entrega incompleta não ganha ack. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if ([props.messageId, props.consumerName, props.payloadHash].some(value => !value?.trim())) {
      throw new DomainError("INVALID_INBOX_IDENTITY", "Inbox identity and payload hash are required.");
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash,
      new Date(props.receivedAt ?? new Date()), undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash,
      new Date(state.receivedAt ?? new Date()), state.processedAt ? new Date(state.processedAt) : undefined);
  }

  get receivedAt(): Date { return new Date(this._receivedAt); }
  get processedAt(): Date | undefined { return this._processedAt ? new Date(this._processedAt) : undefined; }
  isProcessed(): boolean { return this._processedAt !== undefined; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new DomainError("INVALID_INBOX_STATE", "Inbox message was already processed.");
    this._processedAt = new Date(at);
  }
}
