import { describe, expect, test } from "bun:test";
import { payloadHash } from "../../src/application/contracts.ts";
import { AppError } from "../../src/application/errors.ts";
import { assertSameRequest } from "../../src/application/idempotency.ts";

const request = { providerId: "provider-a", externalTransactionId: "transaction-1",
  kind: "BET", money: { amount: "25.00", currency: "BRL" } };
const original = Object.freeze({ idempotencyKey: "provider-a:transaction-1", payloadHash: payloadHash(request) });

function rejectedIdentity(key: string, hash: string): AppError {
  try { assertSameRequest(original, key, hash); } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an idempotency conflict");
}

describe("Idempotência — classificação de replay", () => {
  test("mesma key e mesmo payload são replay válido", () => {
    expect(() => assertSameRequest(original, original.idempotencyKey, payloadHash(request))).not.toThrow();
  });

  test("mesma idempotency key com valor divergente gera409 e não replay", () => {
    const changed = { ...request, money: { ...request.money, amount: "26.00" } };
    const failure = rejectedIdentity(original.idempotencyKey, payloadHash(changed));
    expect(failure.statusCode).toBe(409);
    expect(failure.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(original.payloadHash).toBe(payloadHash(request));
  });

  test("mesma key com outro campo de negócio também é conflito", () => {
    const failure = rejectedIdentity(original.idempotencyKey, payloadHash({ ...request, kind: "WIN" }));
    expect(failure.statusCode).toBe(409);
    expect(failure.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("outra key para a operação externa existente é conflito mesmo com payload igual", () => {
    const failure = rejectedIdentity("provider-a:another-key", payloadHash(request));
    expect(failure.statusCode).toBe(409);
    expect(failure.code).toBe("EXTERNAL_TRANSACTION_CONFLICT");
  });

  test("a identidade externa continua em conflito quando key e payload são divergentes", () => {
    const failure = rejectedIdentity("provider-a:another-key", payloadHash({ ...request, kind: "WIN" }));
    expect(failure.statusCode).toBe(409);
    expect(failure.code).toBe("EXTERNAL_TRANSACTION_CONFLICT");
  });

  test("reordenar chaves recursivamente não transforma o mesmo pedido em conflito", () => {
    const reordered = { money: { currency: "BRL", amount: "25.00" }, kind: "BET",
      externalTransactionId: "transaction-1", providerId: "provider-a" };
    expect(payloadHash(reordered)).toBe(original.payloadHash);
    expect(() => assertSameRequest(original, original.idempotencyKey, payloadHash(reordered))).not.toThrow();
  });
});
