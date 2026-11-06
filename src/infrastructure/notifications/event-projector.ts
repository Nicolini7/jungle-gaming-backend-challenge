import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EntityManager } from "typeorm";
import { payloadHash, requireUuid } from "../../application/contracts.ts";
import { AppError } from "../../application/errors.ts";
import { Money } from "../../domain/money.ts";
import type { Database } from "../database/database.ts";
import { canonicalAmount } from "../database/rows.ts";

const CONSUMER = "financial-read-models-v1";
const identifier = z.string().min(1).max(255);
const money = z.object({ amount: z.string().max(21), currency: z.enum(["BRL", "USD", "EUR"]) }).strict();
const envelope = {
  eventId: z.uuid(), aggregateId: z.uuid(), correlationId: identifier,
  causationId: identifier.optional(), occurredAt: z.iso.datetime({ offset: true }), version: z.literal(1),
};
const operation = {
  transactionId: z.uuid(), walletId: z.uuid(), providerId: identifier,
  kind: z.enum(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]), money, balance: money,
};
const eventSchema = z.discriminatedUnion("eventType", [
  z.object({ ...envelope, eventType: z.literal("WagerTransactionProcessed"),
    data: z.object({ ...operation, status: z.literal("PROCESSED") }).strict() }).strict(),
  z.object({ ...envelope, eventType: z.literal("WagerTransactionRejected"),
    data: z.object({ ...operation, status: z.literal("REJECTED"), failureCode: identifier }).strict() }).strict(),
  z.object({ ...envelope, eventType: z.literal("WagerTransactionPendingReference"),
    data: z.object({ ...operation, status: z.literal("PENDING_REFERENCE") }).strict() }).strict(),
  z.object({ ...envelope, eventType: z.literal("WalletBalanceChanged"),
    data: z.object({ walletId: z.uuid(), transactionId: z.uuid(), direction: z.enum(["DEBIT", "CREDIT"]),
      money, balanceBefore: money, balanceAfter: money, walletVersion: z.number().int().min(1).max(2_147_483_647) }).strict() }).strict(),
]);

export type FinancialIntegrationEvent = z.infer<typeof eventSchema>;
export interface EventProjectionResult { duplicate: boolean; projectionApplied: boolean; notificationApplied: boolean }
export interface NotificationView {
  id: string; transactionId: string; recipientId: string; channel: "in_app";
  status: "PENDING_REFERENCE" | "PROCESSED" | "REJECTED"; eventId: string; createdAt: string; updatedAt: string;
}
export interface BalanceProjectionView {
  walletId: string; balance: { amount: string; currency: string }; walletVersion: number; eventId: string; updatedAt: string;
}

/** Only the versioned producer contract is accepted; transport metadata is not event identity. */
export function parseIntegrationEvent(raw: unknown): FinancialIntegrationEvent {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "INVALID_INTEGRATION_EVENT");
  const event = parsed.data;
  if (event.aggregateId !== event.data.walletId) throw new AppError(400, "EVENT_AGGREGATE_MISMATCH");
  try {
    const value = Money.from(event.data.money);
    if (event.eventType === "WalletBalanceChanged") {
      if (!value.isPositive()) throw new Error("Balance changes require a positive movement.");
      const before = Money.from(event.data.balanceBefore);
      const after = Money.from(event.data.balanceAfter);
      const calculated = event.data.direction === "DEBIT" ? before.subtract(value) : before.add(value);
      if (!calculated.equals(after)) throw new Error("Unbalanced snapshot.");
    } else {
      Money.from(event.data.balance);
      if (event.data.kind === "LOSS" ? !value.isZero() : !value.isPositive()) throw new Error("Invalid amount by kind.");
    }
  } catch { throw new AppError(400, "INVALID_EVENT_MONEY"); }
  return event;
}

/** Local in-app cards and balance snapshots are read models, never a second financial processor. */
export class EventProjector {
  constructor(private readonly db: Database) {}

  async process(raw: unknown): Promise<EventProjectionResult> {
    const event = parseIntegrationEvent(raw);
    const hash = payloadHash(event);
    return this.db.transaction(async em => {
      // Outbox is immutable to the app. It is the authority for this internal consumer's events.
      const [source] = await em.query<Array<{ aggregateId: string; eventType: string; payload: unknown }>>(
        'SELECT aggregate_id AS "aggregateId",event_type AS "eventType",payload FROM outbox WHERE id=$1', [event.eventId]);
      if (!source) throw new AppError(409, "EVENT_NOT_COMMITTED");
      if (source.aggregateId !== event.aggregateId || source.eventType !== event.eventType || payloadHash(source.payload) !== hash) {
        throw new AppError(409, "EVENT_PAYLOAD_CONFLICT");
      }
      const [owner] = await em.query<Array<{ recipientId: string; tenantId: string; currency: string; status: string }>>(`
        SELECT w.player_id AS "recipientId",w.tenant_id AS "tenantId",w.currency,t.status
        FROM wallets w JOIN wager_transactions t ON t.wallet_id=w.id
        WHERE w.id=$1 AND t.id=$2
      `, [event.data.walletId, event.data.transactionId]);
      if (!owner || owner.currency !== (event.eventType === "WalletBalanceChanged" ? event.data.balanceAfter.currency : event.data.balance.currency)) {
        throw new AppError(409, "EVENT_RESOURCE_MISMATCH");
      }
      if (event.eventType === "WalletBalanceChanged") {
        const [snapshot] = await em.query<Array<{ direction: string; amount: string; before: string; after: string; currency: string }>>(`
          SELECT direction,amount::TEXT,balance_before::TEXT AS before,balance_after::TEXT AS after,currency
          FROM wallet_ledger WHERE wallet_id=$1 AND wallet_version=$2 AND transaction_id=$3
        `, [event.data.walletId, event.data.walletVersion, event.data.transactionId]);
        if (!snapshot || snapshot.direction !== event.data.direction || snapshot.currency !== event.data.money.currency ||
          canonicalAmount(snapshot.amount) !== event.data.money.amount || canonicalAmount(snapshot.before) !== event.data.balanceBefore.amount ||
          canonicalAmount(snapshot.after) !== event.data.balanceAfter.amount) throw new AppError(409, "EVENT_RESOURCE_MISMATCH");
      }

      // The unique receipt is claimed in this transaction, so a crash rolls back the claim and effects together.
      const inserted = await em.query<Array<{ event_id: string }>>(`
        INSERT INTO event_receipts(consumer_name,event_id,payload_hash,event_type,aggregate_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(consumer_name,event_id) DO NOTHING RETURNING event_id
      `, [CONSUMER, event.eventId, hash, event.eventType, event.aggregateId]);
      if (!inserted.length) {
        const [receipt] = await em.query<Array<{ payload_hash: string }>>(
          "SELECT payload_hash FROM event_receipts WHERE consumer_name=$1 AND event_id=$2", [CONSUMER, event.eventId]);
        if (!receipt || receipt.payload_hash !== hash) throw new AppError(409, "EVENT_PAYLOAD_CONFLICT");
        return { duplicate: true, projectionApplied: false, notificationApplied: false };
      }
      if (event.eventType === "WalletBalanceChanged") {
        const projectionApplied = await this.applyBalance(em, event);
        return { duplicate: false, projectionApplied, notificationApplied: false };
      }
      // An obsolete pending event must not create a pending card after the financial transaction is already terminal.
      if (event.data.status === "PENDING_REFERENCE" && owner.status !== "PENDING_REFERENCE") {
        return { duplicate: false, projectionApplied: false, notificationApplied: false };
      }
      const changed = await em.query<Array<{ id: string }>>(`
        INSERT INTO in_app_notifications(id,wallet_id,transaction_id,recipient_id,tenant_id,channel,status,source_event_id)
        VALUES($1,$2,$3,$4,$5,'in_app',$6,$7)
        ON CONFLICT(transaction_id,recipient_id,channel) DO UPDATE SET
          status=EXCLUDED.status,source_event_id=EXCLUDED.source_event_id,updated_at=CURRENT_TIMESTAMP
        WHERE in_app_notifications.status='PENDING_REFERENCE' AND EXCLUDED.status IN ('PROCESSED','REJECTED')
        RETURNING id
      `, [randomUUID(), event.data.walletId, event.data.transactionId, owner.recipientId, owner.tenantId, event.data.status, event.eventId]);
      return { duplicate: false, projectionApplied: false, notificationApplied: changed.length > 0 };
    });
  }

  private async applyBalance(em: EntityManager, event: Extract<FinancialIntegrationEvent, { eventType: "WalletBalanceChanged" }>): Promise<boolean> {
    const data = event.data;
    const rows = await em.query<Array<{ wallet_id: string }>>(`
      INSERT INTO wallet_balance_projections(wallet_id,currency,balance,wallet_version,source_event_id)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(wallet_id) DO UPDATE SET balance=EXCLUDED.balance,wallet_version=EXCLUDED.wallet_version,
        source_event_id=EXCLUDED.source_event_id,updated_at=CURRENT_TIMESTAMP
      WHERE wallet_balance_projections.wallet_version < EXCLUDED.wallet_version
      RETURNING wallet_id
    `, [data.walletId, data.balanceAfter.currency, data.balanceAfter.amount, data.walletVersion, event.eventId]);
    if (!rows.length) {
      const [current] = await em.query<Array<{ wallet_version: number; currency: string; balance: string }>>(
        "SELECT wallet_version,currency,balance::text FROM wallet_balance_projections WHERE wallet_id=$1", [data.walletId]);
      if (current?.wallet_version === data.walletVersion &&
        (current.currency !== data.balanceAfter.currency || canonicalAmount(current.balance) !== data.balanceAfter.amount)) {
        throw new AppError(409, "EVENT_VERSION_CONFLICT");
      }
    }
    return rows.length > 0;
  }

  async listNotifications(walletId: string, limit?: string): Promise<{ walletId: string; items: NotificationView[] }> {
    requireUuid(walletId);
    const pageSize = limit === undefined ? 50 : /^\d{1,3}$/.test(limit) ? Number(limit) : 0;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AppError(400, "INVALID_PAGINATION");
    const rows = await this.db.source.query<Array<Omit<NotificationView, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date }>>(`
      SELECT id,transaction_id AS "transactionId",recipient_id AS "recipientId",channel,status,
        source_event_id AS "eventId",created_at AS "createdAt",updated_at AS "updatedAt"
      FROM in_app_notifications WHERE wallet_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2
    `, [walletId, pageSize]);
    return { walletId, items: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })) };
  }

  async balanceProjection(walletId: string): Promise<BalanceProjectionView | null> {
    requireUuid(walletId);
    const [row] = await this.db.source.query<Array<{ currency: string; balance: string; walletVersion: number; eventId: string; updatedAt: Date }>>(`
      SELECT currency,balance::text,wallet_version AS "walletVersion",source_event_id AS "eventId",updated_at AS "updatedAt"
      FROM wallet_balance_projections WHERE wallet_id=$1
    `, [walletId]);
    return row ? { walletId, balance: { amount: canonicalAmount(row.balance), currency: row.currency },
      walletVersion: row.walletVersion, eventId: row.eventId, updatedAt: row.updatedAt.toISOString() } : null;
  }
}
