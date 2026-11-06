import { describe, expect, test } from "bun:test";
import { DomainError, InvalidTransactionStateError } from "../../src/domain/domain-error.ts";
import { Money } from "../../src/domain/money.ts";
import { LedgerDirection, TransactionKind, TransactionStatus } from "../../src/domain/types.ts";
import { WagerTransaction } from "../../src/domain/wager-transaction.ts";
import type { CreateWagerTransactionProps } from "../../src/domain/wager-transaction.ts";

function props(kind = TransactionKind.Bet): CreateWagerTransactionProps {
  return { id: "t-1", providerId: "provider-a", externalTransactionId: "external-1", idempotencyKey: "key-1",
    payloadHash: "hash-1", walletId: "w-1", playerId: "p-1", roundId: "r-1", gameId: "g-1", kind,
    money: Money.from({ amount: kind === TransactionKind.Loss ? "0.00" : "25.00", currency: "BRL" }),
    ...([TransactionKind.Refund, TransactionKind.Rollback].includes(kind) ? { referenceExternalTransactionId: "external-0" } : {}) };
}
const create = (kind = TransactionKind.Bet) => WagerTransaction.create(props(kind));

describe("WagerTransaction — regras de criação e direção financeira", () => {
  test.each([TransactionKind.Bet, TransactionKind.Win, TransactionKind.Loss, TransactionKind.Refund, TransactionKind.Rollback])(
    "%s nasce em PENDING e mantém identidade imutável do comando", (kind) => {
      const transaction = create(kind);
      expect(transaction.status).toBe(TransactionStatus.Pending);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.matchesPayload("hash-1")).toBe(true);
      expect(transaction.matchesPayload("hash-divergente")).toBe(false);
    });

  test.each([TransactionKind.Bet, TransactionKind.Win, TransactionKind.Refund, TransactionKind.Rollback])(
    "%s exige valor positivo", (kind) => {
      expect(() => WagerTransaction.create({ ...props(kind), money: Money.zero("BRL") })).toThrow(DomainError);
      expect(() => WagerTransaction.create({ ...props(kind), money: props(kind).money.negate() })).toThrow(DomainError);
    });

  test("LOSS exige zero e não produz ledger", () => {
    expect(() => WagerTransaction.create({ ...props(TransactionKind.Loss), money: props().money })).toThrow(DomainError);
    expect(create(TransactionKind.Loss).affectsBalance()).toBe(false);
    expect(() => create(TransactionKind.Loss).ledgerDirectionFor()).toThrow(DomainError);
  });

  test("BET debita e WIN/REFUND creditam", () => {
    expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create(TransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create(TransactionKind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("OPENING só existe por factory interna", () => {
    expect(() => WagerTransaction.create(props(TransactionKind.Opening))).toThrow(DomainError);
    const opening = WagerTransaction.opening(props());
    expect(opening.kind).toBe(TransactionKind.Opening);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test.each([TransactionKind.Refund, TransactionKind.Rollback])("%s exige referência externa e referência resolvida ao processar", (kind) => {
    expect(() => WagerTransaction.create({ ...props(kind), referenceExternalTransactionId: undefined })).toThrow(DomainError);
    expect(() => create(kind).markProcessed(undefined, new Date())).toThrow(DomainError);
    expect(create(kind).requiresReference()).toBe(true);
  });

  test("WIN pode carregar uma referência e aguardar sua chegada", () => {
    const transaction = WagerTransaction.create({ ...props(TransactionKind.Win), referenceExternalTransactionId: "bet-0" });
    transaction.markPendingReference();
    expect(transaction.status).toBe(TransactionStatus.PendingReference);
  });

  test("recusa auto referência e referência em uma BET", () => {
    expect(() => WagerTransaction.create({ ...props(TransactionKind.Refund), referenceExternalTransactionId: "external-1" }))
      .toThrow(DomainError);
    expect(() => WagerTransaction.create({ ...props(), referenceExternalTransactionId: "external-0" })).toThrow(DomainError);
  });

  test("ROLLBACK inverte BET, WIN e REFUND e recusa tipos indevidos", () => {
    const rollback = create(TransactionKind.Rollback);
    expect(rollback.ledgerDirectionFor(create(TransactionKind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(create(TransactionKind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(create(TransactionKind.Refund))).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor(create(TransactionKind.Loss))).toThrow(DomainError);
    expect(() => rollback.ledgerDirectionFor(create(TransactionKind.Rollback))).toThrow(DomainError);
    expect(() => rollback.ledgerDirectionFor()).toThrow(DomainError);
  });
});

describe("WagerTransaction — transições", () => {
  test("uma referência pendente pode processar depois sem reconstruir o comando", () => {
    const transaction = create(TransactionKind.Refund);
    transaction.markPendingReference();
    expect(transaction.isTerminal()).toBe(false);
    const at = new Date("2026-11-05T11:00:00.000Z");
    transaction.markProcessed("internal-bet-0", at);
    expect(transaction.referenceTransactionId).toBe("internal-bet-0");
    expect(transaction.status).toBe(TransactionStatus.Processed);
    expect(transaction.processedAt?.toISOString()).toBe(at.toISOString());
    at.setUTCFullYear(2000);
    transaction.processedAt?.setUTCFullYear(2001);
    expect(transaction.processedAt?.getUTCFullYear()).toBe(2026);
  });

  test.each([TransactionStatus.Processed, TransactionStatus.Rejected, TransactionStatus.Failed])(
    "estado terminal %s não permite mais transições", (status) => {
      const transaction = create(TransactionKind.Refund);
      if (status === TransactionStatus.Processed) transaction.markProcessed("reference-0", new Date());
      if (status === TransactionStatus.Rejected) transaction.reject("REFERENCE_EXPIRED");
      if (status === TransactionStatus.Failed) transaction.fail("PERMANENT_INFRASTRUCTURE_ERROR");
      expect(transaction.isTerminal()).toBe(true);
      for (const run of [() => transaction.markProcessed("r", new Date()), () => transaction.markPendingReference(),
        () => transaction.reject("x"), () => transaction.fail("x")]) {
        expect(run).toThrow(InvalidTransactionStateError);
      }
      expect(transaction.status).toBe(status);
    });

  test("rejeições e falhas preservam código estável e têm data terminal", () => {
    const rejected = create();
    rejected.reject("INSUFFICIENT_FUNDS");
    expect(rejected.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(rejected.processedAt).toBeInstanceOf(Date);
    const failed = create();
    failed.fail("PERMANENT_INFRASTRUCTURE_ERROR");
    expect(failed.failureCode).toBe("PERMANENT_INFRASTRUCTURE_ERROR");
    expect(() => create().reject(" ")).toThrow(DomainError);
  });

  test("reidrata um estado terminal sem executar transições novamente", () => {
    const transaction = WagerTransaction.rehydrate({ ...props(TransactionKind.Refund), status: TransactionStatus.Rejected,
      failureCode: "REFERENCE_EXPIRED", processedAt: new Date("2026-11-05T11:00:00.000Z") });
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe("REFERENCE_EXPIRED");
    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});
