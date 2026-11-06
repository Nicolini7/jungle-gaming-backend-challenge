import { EntitySchema } from "typeorm";
import type { ValueTransformer } from "typeorm";

/** pg returns NUMERIC as strings. Only pad the scale; never use Number/parseFloat. */
export function canonicalAmount(value: string): string {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Unexpected exact NUMERIC representation from PostgreSQL");
  }
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

const exactDecimal: ValueTransformer = {
  to: (value: string | null): string | null => value,
  from: (value: string | null): string | null => value === null ? null : canonicalAmount(value),
};

export class WalletRow {
  declare id: string;
  declare tenantId: string;
  declare playerId: string;
  declare currency: string;
  declare balance: string;
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

export class TransactionRow {
  declare id: string;
  declare providerId: string;
  declare externalTransactionId: string;
  declare idempotencyKey: string;
  declare payloadHash: string;
  declare walletId: string;
  declare playerId: string;
  declare roundId: string;
  declare gameId: string;
  declare kind: string;
  declare status: string;
  declare amount: string;
  declare currency: string;
  declare referenceExternalTransactionId: string | null;
  declare referenceTransactionId: string | null;
  declare failureCode: string | null;
  declare balanceAfter: string | null;
  declare createdAt: Date;
  declare processedAt: Date | null;
  declare referenceAttempts: number;
  declare nextAttemptAt: Date | null;
  declare correlationId: string;
}

export class LedgerRow {
  declare id: string;
  declare walletId: string;
  declare transactionId: string;
  declare direction: string;
  declare amount: string;
  declare currency: string;
  declare balanceBefore: string;
  declare balanceAfter: string;
  declare walletVersion: number;
  declare createdAt: Date;
}

export class InboxRow {
  declare consumerName: string;
  declare messageId: string;
  declare payloadHash: string;
  declare transactionId: string | null;
  declare receivedAt: Date;
  declare processedAt: Date | null;
}

export class OutboxRow {
  declare id: string;
  declare aggregateId: string;
  declare eventType: string;
  declare payload: Record<string, unknown>;
  declare occurredAt: Date;
  declare attempts: number;
  declare nextAttemptAt: Date;
  declare publishedAt: Date | null;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: "WalletRow", target: WalletRow, tableName: "wallets",
  columns: {
    id: { type: "uuid", primary: true },
    tenantId: { name: "tenant_id", type: "varchar", length: 180, default: "__internal__" },
    playerId: { name: "player_id", type: "uuid" },
    currency: { type: "varchar", length: 3 },
    balance: { type: "numeric", transformer: exactDecimal },
    version: { type: "integer", default: 1 },
    createdAt: { name: "created_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
    updatedAt: { name: "updated_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
  },
});

export const TransactionSchema = new EntitySchema<TransactionRow>({
  name: "TransactionRow", target: TransactionRow, tableName: "wager_transactions",
  columns: {
    id: { type: "uuid", primary: true },
    providerId: { name: "provider_id", type: "varchar", length: 255 },
    externalTransactionId: { name: "external_transaction_id", type: "varchar", length: 255 },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 512 },
    payloadHash: { name: "payload_hash", type: "varchar", length: 64 },
    walletId: { name: "wallet_id", type: "uuid" },
    playerId: { name: "player_id", type: "uuid" },
    roundId: { name: "round_id", type: "varchar", length: 255 },
    gameId: { name: "game_id", type: "varchar", length: 255 },
    kind: { type: "varchar", length: 16 },
    status: { type: "varchar", length: 32, default: "PENDING" },
    amount: { type: "numeric", transformer: exactDecimal },
    currency: { type: "varchar", length: 3 },
    referenceExternalTransactionId: { name: "reference_external_transaction_id", type: "varchar", length: 255, nullable: true },
    referenceTransactionId: { name: "reference_transaction_id", type: "uuid", nullable: true },
    failureCode: { name: "failure_code", type: "varchar", length: 100, nullable: true },
    balanceAfter: { name: "balance_after", type: "numeric", nullable: true, transformer: exactDecimal },
    createdAt: { name: "created_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
    processedAt: { name: "processed_at", type: "timestamptz", nullable: true },
    referenceAttempts: { name: "reference_attempts", type: "integer", default: 0 },
    nextAttemptAt: { name: "next_attempt_at", type: "timestamptz", nullable: true },
    correlationId: { name: "correlation_id", type: "varchar", length: 255 },
  },
});

export const LedgerSchema = new EntitySchema<LedgerRow>({
  name: "LedgerRow", target: LedgerRow, tableName: "wallet_ledger",
  columns: {
    id: { type: "uuid", primary: true },
    walletId: { name: "wallet_id", type: "uuid" },
    transactionId: { name: "transaction_id", type: "uuid" },
    direction: { type: "varchar", length: 6 },
    amount: { type: "numeric", transformer: exactDecimal },
    currency: { type: "varchar", length: 3 },
    balanceBefore: { name: "balance_before", type: "numeric", transformer: exactDecimal },
    balanceAfter: { name: "balance_after", type: "numeric", transformer: exactDecimal },
    walletVersion: { name: "wallet_version", type: "integer" },
    createdAt: { name: "created_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
  },
});

export const InboxSchema = new EntitySchema<InboxRow>({
  name: "InboxRow", target: InboxRow, tableName: "inbox",
  columns: {
    consumerName: { name: "consumer_name", type: "varchar", length: 255, primary: true },
    messageId: { name: "message_id", type: "varchar", length: 255, primary: true },
    payloadHash: { name: "payload_hash", type: "varchar", length: 64 },
    transactionId: { name: "transaction_id", type: "uuid", nullable: true },
    receivedAt: { name: "received_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
    processedAt: { name: "processed_at", type: "timestamptz", nullable: true },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRow>({
  name: "OutboxRow", target: OutboxRow, tableName: "outbox",
  columns: {
    id: { type: "uuid", primary: true },
    aggregateId: { name: "aggregate_id", type: "uuid" },
    eventType: { name: "event_type", type: "varchar", length: 100 },
    payload: { type: "jsonb" },
    occurredAt: { name: "occurred_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { name: "next_attempt_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" },
    publishedAt: { name: "published_at", type: "timestamptz", nullable: true },
  },
});

export const schemas = [WalletSchema, TransactionSchema, LedgerSchema, InboxSchema, OutboxSchema];
