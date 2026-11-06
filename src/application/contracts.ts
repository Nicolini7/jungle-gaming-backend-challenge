import { createHash } from "node:crypto";
import { z } from "zod";
import { Money } from "../domain/money.ts";
import { AppError } from "./errors.ts";

const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const moneySchema = z.object({ amount: z.string().max(21), currency: z.string() }).strict();

export const wagerSchema = z.object({
  providerId: identifier.refine((value) => value !== "system", "Reserved provider"),
  externalTransactionId: identifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
}).strict();

export type WagerInput = z.infer<typeof wagerSchema>;

export function parseWager(raw: unknown): WagerInput {
  const parsed = wagerSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "INVALID_PAYLOAD");
  Money.from(parsed.data.money);
  return parsed.data;
}

export function parseWallet(raw: unknown): { playerId: string; initialBalance: { amount: string; currency: string } } {
  const parsed = z.object({ playerId: z.uuid(), initialBalance: moneySchema }).strict().safeParse(raw);
  if (!parsed.success) throw new AppError(400, "INVALID_PAYLOAD");
  Money.from(parsed.data.initialBalance);
  return parsed.data;
}

export function requireUuid(raw: string): string {
  if (!z.uuid().safeParse(raw).success) throw new AppError(400, "INVALID_IDENTIFIER");
  return raw;
}

export function requireKey(raw: string): string {
  if (typeof raw !== "string" || !/^[\x21-\x7e]{1,180}$/.test(raw)) {
    throw new AppError(400, "INVALID_IDEMPOTENCY_KEY");
  }
  return raw;
}

/** Recursively sorted object keys; array order retained; JSON-only validated input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface ProcessingContext {
  correlationId: string;
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}
