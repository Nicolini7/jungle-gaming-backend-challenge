import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseIntegrationEvent } from "../../src/infrastructure/notifications/event-projector.ts";

function event(type = "WagerTransactionProcessed") {
  const walletId = randomUUID();
  const transactionId = randomUUID();
  return {
    eventId: randomUUID(), aggregateId: walletId, correlationId: randomUUID(), causationId: transactionId,
    occurredAt: new Date().toISOString(), version: 1, eventType: type,
    data: type === "WalletBalanceChanged"
      ? { walletId, transactionId, direction: "DEBIT", money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" }, balanceAfter: { amount: "75.00", currency: "BRL" }, walletVersion: 2 }
      : { walletId, transactionId, providerId: "provider-a", kind: type === "WagerTransactionPendingReference" ? "REFUND" : "BET",
        money: { amount: "25.00", currency: "BRL" }, balance: { amount: "75.00", currency: "BRL" },
        status: type === "WagerTransactionRejected" ? "REJECTED" : type === "WagerTransactionPendingReference" ? "PENDING_REFERENCE" : "PROCESSED",
        ...(type === "WagerTransactionRejected" ? { failureCode: "INSUFFICIENT_FUNDS" } : {}) },
  };
}

describe("Financial integration event contract", () => {
  test.each(["WagerTransactionProcessed", "WagerTransactionRejected", "WagerTransactionPendingReference", "WalletBalanceChanged"])(
    "accepts the versioned %s producer envelope", type => {
      const input = event(type);
      expect(parseIntegrationEvent(input) as unknown).toEqual(input);
    });

  test.each([
    ["unknown type", (value: ReturnType<typeof event>) => ({ ...value, eventType: "SendEmail" })],
    ["unknown schema version", (value: ReturnType<typeof event>) => ({ ...value, version: 2 })],
    ["invalid event identity", (value: ReturnType<typeof event>) => ({ ...value, eventId: "not-an-id" })],
    ["invalid occurrence date", (value: ReturnType<typeof event>) => ({ ...value, occurredAt: "yesterday" })],
    ["aggregate substitution", (value: ReturnType<typeof event>) => ({ ...value, aggregateId: randomUUID() })],
    ["recipient injection", (value: ReturnType<typeof event>) => ({ ...value, data: { ...value.data, recipientId: randomUUID() } })],
    ["transport fields inside the envelope", (value: ReturnType<typeof event>) => ({ ...value, receiptHandle: "transport-only" })],
    ["wrong status for the event type", (value: ReturnType<typeof event>) => ({ ...value, data: { ...value.data, status: "PENDING_REFERENCE" } })],
  ] as const)("rejects %s", (_name, mutate) => {
    expect(() => parseIntegrationEvent(mutate(event()))).toThrow();
  });

  test.each(["1.005", "NaN", "1e2", "-1.00", "0.00"])("rejects invalid positive movement %s", amount => {
    const input = event("WalletBalanceChanged");
    expect(() => parseIntegrationEvent({ ...input, data: { ...input.data, money: { amount, currency: "BRL" } } })).toThrow();
  });

  test("rejects unbalanced arithmetic and cross-currency snapshots", () => {
    const input = event("WalletBalanceChanged");
    expect(() => parseIntegrationEvent({ ...input, data: { ...input.data, balanceAfter: { amount: "74.00", currency: "BRL" } } })).toThrow();
    expect(() => parseIntegrationEvent({ ...input, data: { ...input.data, balanceBefore: { amount: "100.00", currency: "USD" } } })).toThrow();
  });

  test.each([0, -1, 1.5, 2_147_483_648])("rejects invalid wallet version %d", walletVersion => {
    const input = event("WalletBalanceChanged");
    expect(() => parseIntegrationEvent({ ...input, data: { ...input.data, walletVersion } })).toThrow();
  });

  test("accepts a zero-value LOSS without a balance movement", () => {
    const input = event();
    const loss = { ...input, data: { ...input.data, kind: "LOSS", money: { amount: "0.00", currency: "BRL" } } };
    expect(parseIntegrationEvent(loss) as unknown).toEqual(loss);
    expect(() => parseIntegrationEvent({ ...loss, data: { ...loss.data, money: { amount: "0.01", currency: "BRL" } } })).toThrow();
  });
});
