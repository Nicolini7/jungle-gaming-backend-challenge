import { DomainError } from "./domain-error.ts";
import type { Money } from "./money.ts";
import { LedgerDirection } from "./types.ts";
export { LedgerDirection } from "./types.ts";

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) { Object.freeze(this); }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new DomainError("INVALID_LEDGER_IDENTITY", "Ledger identities are required.");
    }
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new DomainError("INVALID_LEDGER_DIRECTION", "Ledger direction is invalid.");
    }
    if (!props.money.isPositive() || props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError("INVALID_LEDGER_AMOUNT", "A ledger movement is positive and its balances nonnegative.");
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new DomainError("UNBALANCED_LEDGER_ENTRY", "Ledger amount does not match its balance change.");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state.id, state.walletId, state.transactionId, state.direction,
      state.money, state.balanceBefore, state.balanceAfter, new Date(state.createdAt));
  }

  get createdAt(): Date { return new Date(this._createdAt); }

  isBalanced(): boolean {
    const calculated = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return calculated.equals(this.balanceAfter);
  }
}
