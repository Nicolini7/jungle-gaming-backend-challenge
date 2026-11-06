import { DomainError, InvalidTransactionStateError } from "./domain-error.ts";
import type { Money } from "./money.ts";
import { LedgerDirection, TransactionKind, TransactionStatus } from "./types.ts";
export { TransactionKind, TransactionStatus } from "./types.ts";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt?: Date | undefined;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: TransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: string | undefined;
  processedAt?: Date | undefined;
}

/** Encapsula o ciclo de vida; referências e concorrência são coordenadas no caso de uso. */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: TransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  private readonly _createdAt: Date;
  private _status: TransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: string | undefined;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this._createdAt = new Date(state.createdAt ?? new Date());
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt ? new Date(state.processedAt) : undefined;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === TransactionKind.Opening) {
      throw new DomainError("INTERNAL_TRANSACTION_KIND", "OPENING cannot be submitted externally.");
    }
    return WagerTransaction.createValidated(props);
  }

  /** Único caminho para uma OPENING interna; o adaptador público nunca o utiliza. */
  static opening(props: Omit<CreateWagerTransactionProps, "kind" | "referenceExternalTransactionId">): WagerTransaction {
    return WagerTransaction.createValidated({ ...props, kind: TransactionKind.Opening });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): TransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): string | undefined { return this._failureCode; }
  get createdAt(): Date { return new Date(this._createdAt); }
  get processedAt(): Date | undefined { return this._processedAt ? new Date(this._processedAt) : undefined; }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (this.requiresReference() && !referenceTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", "A reversal must resolve its reference before processing.");
    }
    this._referenceTransactionId = referenceTransactionId;
    this._status = TransactionStatus.Processed;
    this._processedAt = new Date(at);
    this._failureCode = undefined;
  }

  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", "Pending reference requires an external reference identity.");
    }
    this._status = TransactionStatus.PendingReference;
  }

  reject(code: string): void {
    this.finish(TransactionStatus.Rejected, code);
  }

  fail(code: string): void {
    this.finish(TransactionStatus.Failed, code);
  }

  isTerminal(): boolean {
    return this._status === TransactionStatus.Processed || this._status === TransactionStatus.Rejected ||
      this._status === TransactionStatus.Failed;
  }

  affectsBalance(): boolean { return this.kind !== TransactionKind.Loss; }
  requiresReference(): boolean { return this.kind === TransactionKind.Refund || this.kind === TransactionKind.Rollback; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case TransactionKind.Bet: return LedgerDirection.Debit;
      case TransactionKind.Opening:
      case TransactionKind.Win:
      case TransactionKind.Refund: return LedgerDirection.Credit;
      case TransactionKind.Rollback:
        if (!reference) throw new DomainError("REFERENCE_REQUIRED", "A rollback needs a resolved reference.");
        if (![TransactionKind.Bet, TransactionKind.Win, TransactionKind.Refund].includes(reference.kind)) {
          throw new DomainError("INVALID_REFERENCE_KIND", "ROLLBACK can only reference BET, WIN or REFUND.");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      case TransactionKind.Loss:
        throw new DomainError("NO_LEDGER_FOR_TRANSACTION", "LOSS never produces a ledger entry.");
    }
  }

  private static createValidated(props: CreateWagerTransactionProps): WagerTransaction {
    const identities = [props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId];
    if (identities.some(value => typeof value !== "string" || value.trim().length === 0)) {
      throw new DomainError("INVALID_TRANSACTION_IDENTITY", "All transaction identities are required.");
    }
    if (!Object.values(TransactionKind).includes(props.kind)) {
      throw new DomainError("INVALID_TRANSACTION_KIND", "Transaction kind is invalid.");
    }
    if (props.kind === TransactionKind.Loss ? !props.money.isZero() : !props.money.isPositive()) {
      throw new DomainError("INVALID_TRANSACTION_AMOUNT", "LOSS requires zero; financial movements require positive amounts.");
    }
    if ((props.kind === TransactionKind.Refund || props.kind === TransactionKind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()) {
      throw new DomainError("REFERENCE_REQUIRED", "REFUND and ROLLBACK require an external reference.");
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new DomainError("INVALID_REFERENCE", "A transaction cannot reference itself.");
    }
    if (props.referenceExternalTransactionId &&
      (props.kind === TransactionKind.Bet || props.kind === TransactionKind.Opening)) {
      throw new DomainError("INVALID_REFERENCE_KIND", "BET and OPENING cannot reference another transaction.");
    }
    return new WagerTransaction({ ...props, status: TransactionStatus.Pending });
  }

  private finish(status: TransactionStatus.Rejected | TransactionStatus.Failed, code: string): void {
    this.assertMutable();
    if (!code.trim()) throw new DomainError("INVALID_FAILURE_CODE", "Terminal failures require a stable failure code.");
    this._status = status;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status);
  }
}
