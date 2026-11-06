import { DomainError } from "./domain-error.ts";
import { Money } from "./money.ts";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Aggregate financeiro. O caso de uso persiste seu ledger na mesma transação SQL. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (!props.id || !props.playerId) {
      throw new DomainError("INVALID_WALLET_IDENTITY", "Wallet and player identities are required.");
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainError("NEGATIVE_INITIAL_BALANCE", "Initial balance cannot be negative.");
    }
    const now = new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstitui estado persistido sem repetir transições financeiras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version,
      new Date(state.createdAt), new Date(state.updatedAt));
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get createdAt(): Date { return new Date(this._createdAt); }
  get updatedAt(): Date { return new Date(this._updatedAt); }

  debit(money: Money, at: Date = new Date()): void {
    this.assertAmount(money);
    if (this._balance.isLessThan(money)) {
      throw new DomainError("INSUFFICIENT_FUNDS", "Wallet balance is insufficient.");
    }
    this.apply(this._balance.subtract(money), money, at);
  }

  credit(money: Money, at: Date = new Date()): void {
    this.assertAmount(money);
    this.apply(this._balance.add(money), money, at);
  }

  private apply(balance: Money, change: Money, at: Date): void {
    if (change.isZero()) return;
    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date(at);
  }

  private assertAmount(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "Wallet and operation currencies must match.");
    }
    if (money.isNegative()) {
      throw new DomainError("INVALID_MOVEMENT_AMOUNT", "Movement amount cannot be negative.");
    }
  }
}
