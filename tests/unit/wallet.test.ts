import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/domain-error.ts";
import { Money } from "../../src/domain/money.ts";
import { Wallet } from "../../src/domain/wallet.ts";
import { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry.ts";
import { LedgerDirection } from "../../src/domain/types.ts";

const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const open = () => Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: money("100.00") });

describe("Wallet", () => {
  test("abre com versão 1, inclusive para saldo inicial positivo ou zero", () => {
    expect(open().version).toBe(1);
    expect(open().balance.toString()).toBe("100.00");
    const empty = Wallet.open({ id: "wallet-2", playerId: "player-2", initialBalance: Money.zero("BRL") });
    expect(empty.version).toBe(1);
    expect(empty.balance.isZero()).toBe(true);
  });

  test("rejeita saldo inicial negativo", () => {
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: money("1.00").negate() }))
      .toThrow(DomainError);
  });

  test("debita e credita incrementando versão somente quando muda o saldo", () => {
    const wallet = open();
    const at = new Date("2026-11-05T11:00:00.000Z");
    wallet.debit(money("80.00"), at);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(at.toISOString());
    wallet.credit(money("30.00"), at);
    expect(wallet.balance.toString()).toBe("50.00");
    expect(wallet.version).toBe(3);
    wallet.debit(Money.zero("BRL"));
    wallet.credit(Money.zero("BRL"));
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt.toISOString()).toBe(at.toISOString());
  });

  test("recusa débito sem saldo e mantém todo o estado anterior", () => {
    const wallet = open();
    wallet.debit(money("80.00"));
    const date = wallet.updatedAt.toISOString();
    expect(() => wallet.debit(money("80.00"))).toThrow("insufficient");
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(date);
  });

  test("não permite movimentos negativos nem moeda divergente", () => {
    const wallet = open();
    for (const method of [wallet.debit.bind(wallet), wallet.credit.bind(wallet)]) {
      expect(() => method(money("1.00").negate())).toThrow(DomainError);
      expect(() => method(money("1.00", "USD"))).toThrow(DomainError);
    }
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("reidratação restaura saldo e versão sem gerar outra movimentação", () => {
    const at = new Date("2026-11-05T11:00:00.000Z");
    const wallet = Wallet.rehydrate({ id: "w", playerId: "p", currency: "BRL", balance: money("20.00"),
      version: 42, createdAt: at, updatedAt: at });
    at.setUTCFullYear(2000);
    expect(wallet.version).toBe(42);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.createdAt.getUTCFullYear()).toBe(2026);
    wallet.updatedAt.setUTCFullYear(2001);
    expect(wallet.updatedAt.getUTCFullYear()).toBe(2026);
  });
});

describe("WalletLedgerEntry", () => {
  const entry = (direction: LedgerDirection, before: string, after: string, amount = "20.00") =>
    WalletLedgerEntry.create({ id: "entry-1", walletId: "wallet-1", transactionId: "transaction-1",
      direction, money: money(amount), balanceBefore: money(before), balanceAfter: money(after), createdAt: new Date() });

  test("confere aritmética de débito e crédito", () => {
    expect(entry(LedgerDirection.Debit, "100.00", "80.00").isBalanced()).toBe(true);
    expect(entry(LedgerDirection.Credit, "80.00", "100.00").isBalanced()).toBe(true);
  });

  test("rejeita lançamento com saldos incompatíveis", () => {
    expect(() => entry(LedgerDirection.Debit, "100.00", "90.00")).toThrow(DomainError);
    expect(() => entry(LedgerDirection.Credit, "100.00", "90.00")).toThrow(DomainError);
  });

  test("rejeita movimento zero e saldos negativos", () => {
    expect(() => entry(LedgerDirection.Debit, "100.00", "100.00", "0.00")).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ id: "e", walletId: "w", transactionId: "t",
      direction: LedgerDirection.Debit, money: money("20.00"), balanceBefore: money("10.00"),
      balanceAfter: money("10.00").negate(), createdAt: new Date() })).toThrow(DomainError);
  });

  test("rejeita mistura de moedas no lançamento", () => {
    expect(() => WalletLedgerEntry.create({ id: "e", walletId: "w", transactionId: "t",
      direction: LedgerDirection.Credit, money: money("20.00", "USD"), balanceBefore: money("80.00"),
      balanceAfter: money("100.00"), createdAt: new Date() })).toThrow(DomainError);
  });

  test("o lançamento e sua data não podem ser alterados por quem o recebeu", () => {
    const result = entry(LedgerDirection.Credit, "80.00", "100.00");
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => Object.assign(result, { direction: LedgerDirection.Debit })).toThrow(TypeError);
    const originalYear = result.createdAt.getUTCFullYear();
    result.createdAt.setUTCFullYear(2000);
    expect(result.createdAt.getUTCFullYear()).toBe(originalYear);
  });
});
