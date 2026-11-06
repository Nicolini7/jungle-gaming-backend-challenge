import { randomUUID } from "node:crypto";
import { MoreThan } from "typeorm";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import {
  DomainError, Money, Wallet, WalletLedgerEntry, WagerTransaction,
  LedgerDirection, TransactionKind, TransactionStatus,
  WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../domain/index.ts";
import type { IntegrationEvent, MoneyProps } from "../domain/index.ts";
import { Database } from "../infrastructure/database/database.ts";
import { WalletRow, TransactionRow, LedgerRow, InboxRow, OutboxRow, canonicalAmount } from "../infrastructure/database/rows.ts";
import { Telemetry } from "../infrastructure/telemetry.ts";
import { AppError, databaseCode } from "./errors.ts";
import { assertSameRequest } from "./idempotency.ts";
import { parseWager, parseWallet, payloadHash, requireKey, requireUuid } from "./contracts.ts";
import type { ProcessingContext, WagerInput } from "./contracts.ts";

export interface TransactionResult {
  transactionId: string;
  status: `${TransactionStatus}`;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface ServiceOptions {
  referenceBaseDelayMs?: number;
  referenceMaxAttempts?: number;
  referenceTtlMs?: number;
}

export class WagerService {
  private readonly referenceBaseDelayMs: number;
  private readonly referenceMaxAttempts: number;
  private readonly referenceTtlMs: number;

  constructor(readonly db: Database, readonly telemetry: Telemetry, options: ServiceOptions = {}) {
    this.referenceBaseDelayMs = options.referenceBaseDelayMs ?? 1000;
    this.referenceMaxAttempts = options.referenceMaxAttempts ?? 20;
    this.referenceTtlMs = options.referenceTtlMs ?? 86_400_000;
  }

  async createWallet(raw: unknown, ownership?: { tenantId: string }) {
    const input = parseWallet(raw);
    const initialBalance = Money.from(input.initialBalance);
    const wallet = Wallet.open({ id: randomUUID(), playerId: input.playerId, initialBalance });
    try {
      await this.db.transaction(async (em) => {
      await em.insert(WalletRow, {
        id: wallet.id, playerId: wallet.playerId, currency: wallet.currency, tenantId: ownership?.tenantId ?? "__internal__",
        balance: wallet.balance.toString(), version: wallet.version,
        createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
      });
      if (initialBalance.isPositive()) {
        const transaction = WagerTransaction.opening({
          id: randomUUID(), providerId: "system", externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `system:opening:${wallet.id}`, payloadHash: payloadHash(input),
          walletId: wallet.id, playerId: wallet.playerId, roundId: `opening:${wallet.id}`,
          gameId: "internal", money: initialBalance, createdAt: wallet.createdAt,
        });
        const row = this.newRow(transaction, wallet.id);
        await em.insert(TransactionRow, row);
        transaction.markProcessed(undefined, wallet.createdAt);
        const entry = WalletLedgerEntry.create({
          id: randomUUID(), walletId: wallet.id, transactionId: transaction.id,
          direction: LedgerDirection.Credit, money: initialBalance,
          balanceBefore: Money.zero(wallet.currency), balanceAfter: initialBalance, createdAt: wallet.createdAt,
        });
        await this.insertLedger(em, entry, wallet.version);
        await this.persistState(em, row, transaction, wallet);
        await this.enqueueEvents(em, transaction, wallet, entry, { correlationId: wallet.id });
      }
      });
    } catch (error) {
      if (databaseCode(error) === "23505") throw new AppError(409, "WALLET_ALREADY_EXISTS");
      throw error;
    }
    this.telemetry.increment("wallets_opened_total");
    return this.walletView(wallet);
  }

  async submit(raw: unknown, key: string, context: ProcessingContext): Promise<TransactionResult> {
    const start = performance.now();
    const input = parseWager(raw);
    requireKey(key);
    const hash = payloadHash(input);
    const transaction = WagerTransaction.create({
      ...input, id: randomUUID(), idempotencyKey: key, payloadHash: hash,
      kind: input.kind as TransactionKind, money: Money.from(input.money),
    });
    let result: TransactionResult;
    try {
      result = await this.db.transaction(async (em) => {
        // Every code path acquires the wallet first: HTTP, SQS and reference retries.
        const wallet = await this.lockWallet(em, input.walletId);
        await this.checkInbox(em, context);
        const existing = await em.findOne(TransactionRow, {
          where: [{ idempotencyKey: key }, { providerId: input.providerId, externalTransactionId: input.externalTransactionId }],
        });
        if (existing) {
          this.assertReplay(existing, key, hash);
          await this.recordInbox(em, context, existing.id);
          return this.result(existing, wallet.currency, true);
        }
        const row = this.newRow(transaction, context.correlationId);
        await em.insert(TransactionRow, row);
        await this.apply(em, row, transaction, wallet, context);
        await this.recordInbox(em, context, transaction.id);
        return this.result(row, wallet.currency, false);
      });
    } catch (error) {
      if (databaseCode(error) === "23505") {
        // A key or external identity may race across *different* wallet locks.
        // Re-enter after rollback; committed uniqueness determines the winner.
        result = await this.db.transaction(async (em) => {
          const wallet = await this.lockWallet(em, input.walletId);
          await this.checkInbox(em, context);
          const existing = await em.findOne(TransactionRow, {
            where: [{ idempotencyKey: key }, { providerId: input.providerId, externalTransactionId: input.externalTransactionId }],
          });
          if (!existing) throw error;
          this.assertReplay(existing, key, hash);
          await this.recordInbox(em, context, existing.id);
          return this.result(existing, wallet.currency, true);
        });
      } else {
        if (["40P01", "40001", "55P03"].includes(databaseCode(error) ?? "")) this.telemetry.increment("lock_conflicts_total");
        throw error;
      }
    }
    this.telemetry.increment("transactions_total", { status: result.status });
    if (result.idempotentReplay) this.telemetry.increment("duplicates_total");
    this.telemetry.observe("processing_duration_seconds", (performance.now() - start) / 1000);
    this.telemetry.log("transaction_result", {
      ...context, messageId: context.inbox?.messageId ?? null,
      transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId, status: result.status,
    });
    return result;
  }

  async retryPending(limit = 50): Promise<number> {
    const due = await this.db.source.query<Array<{ id: string; wallet_id: string }>>(
      "SELECT id,wallet_id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at <= now() ORDER BY next_attempt_at,id LIMIT $1", [limit],
    );
    let processed = 0;
    for (const item of due) {
      const changed = await this.db.transaction(async (em) => {
        const wallet = await this.lockWallet(em, item.wallet_id);
        const row = await em.findOneByOrFail(TransactionRow, { id: item.id });
        if (row.status !== TransactionStatus.PendingReference || !row.nextAttemptAt || row.nextAttemptAt.getTime() > Date.now()) return false;
        const transaction = this.toTransaction(row);
        row.referenceAttempts += 1;
        // Resolve first, even on the final allowed attempt. Expire only if it is still missing.
        await this.apply(em, row, transaction, wallet, { correlationId: row.correlationId });
        this.telemetry.increment("reference_retries_total");
        return true;
      });
      if (changed) processed += 1;
    }
    return processed;
  }

  async getWallet(id: string) {
    requireUuid(id);
    const row = await this.db.source.manager.findOneBy(WalletRow, { id });
    if (!row) throw new AppError(404, "WALLET_NOT_FOUND");
    return this.walletView(this.toWallet(row));
  }

  async getTransaction(id: string) {
    requireUuid(id);
    const row = await this.db.source.manager.findOneBy(TransactionRow, { id });
    if (!row) throw new AppError(404, "TRANSACTION_NOT_FOUND");
    return this.transactionView(row);
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string) {
    const row = await this.db.source.manager.findOneBy(TransactionRow, { providerId, externalTransactionId });
    if (!row) throw new AppError(404, "TRANSACTION_NOT_FOUND");
    return this.transactionView(row);
  }

  async ledger(walletId: string, cursor?: string, rawLimit = "50") {
    await this.getWallet(walletId);
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw new AppError(400, "INVALID_LIMIT");
    const limit = Number(rawLimit); // Pagination count, never money.
    let after = 0;
    if (cursor) {
      try {
        if (cursor.length > 500 || Buffer.from(cursor, "base64url").toString("base64url") !== cursor) throw new Error();
        const decoded = z.object({ v: z.literal(1), walletId: z.uuid(), after: z.number().int().nonnegative() }).strict()
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        if (decoded.walletId !== walletId) throw new Error();
        after = decoded.after;
      } catch { throw new AppError(400, "INVALID_CURSOR"); }
    }
    const rows = await this.db.source.manager.find(LedgerRow, {
      where: { walletId, walletVersion: MoreThan(after) }, order: { walletVersion: "ASC" }, take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id, walletId: row.walletId, transactionId: row.transactionId, direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balanceBefore, currency: row.currency },
        balanceAfter: { amount: row.balanceAfter, currency: row.currency }, walletVersion: row.walletVersion, createdAt: row.createdAt,
      })),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: 1, walletId, after: last.walletVersion })).toString("base64url") : null,
    };
  }

  async reconcile(walletId: string) {
    requireUuid(walletId);
    return this.db.transaction(async (em) => {
      // Serialize with financial writers, avoiding two-snapshot false positives.
      const wallet = await this.lockWallet(em, walletId);
      const [row] = await em.query<Array<{ balance: string; count: number }>>(
        "SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::text AS balance,count(*)::int AS count FROM wallet_ledger WHERE wallet_id=$1", [walletId],
      );
      if (!row) throw new Error("Missing aggregation");
      const calculated = Money.rehydrate({ amount: canonicalAmount(row.balance), currency: wallet.currency });
      const difference = wallet.balance.subtract(calculated);
      if (!difference.isZero()) {
        this.telemetry.increment("reconciliation_mismatches_total");
        this.telemetry.log("reconciliation_mismatch", { walletId });
      }
      return { walletId, storedBalance: wallet.balance.toJSON(), calculatedBalance: calculated.toJSON(), difference: difference.toJSON(), consistent: difference.isZero(), checkedEntries: row.count };
    });
  }

  private async apply(em: EntityManager, row: TransactionRow, transaction: WagerTransaction, wallet: Wallet, context: ProcessingContext): Promise<void> {
    const previousStatus = transaction.status;
    let reference: TransactionRow | null = null;
    let entry: WalletLedgerEntry | undefined;
    let failure: string | undefined;
    if (transaction.playerId !== wallet.playerId) failure = "PLAYER_MISMATCH";
    else if (transaction.money.currency !== wallet.currency) failure = "CURRENCY_MISMATCH";

    if (!failure && transaction.referenceExternalTransactionId) {
      reference = await em.findOneBy(TransactionRow, { providerId: transaction.providerId, externalTransactionId: transaction.referenceExternalTransactionId });
      if (!reference || [TransactionStatus.Pending, TransactionStatus.PendingReference].includes(reference.status as TransactionStatus)) {
        if (row.referenceAttempts >= this.referenceMaxAttempts || Date.now() - row.createdAt.getTime() >= this.referenceTtlMs) {
          transaction.reject("REFERENCE_NOT_FOUND");
          row.nextAttemptAt = null;
          await this.persistState(em, row, transaction, wallet);
          await this.enqueueEvents(em, transaction, wallet, undefined, context);
          return;
        }
        transaction.markPendingReference();
        row.nextAttemptAt = new Date(Date.now() + Math.min(this.referenceBaseDelayMs * 2 ** row.referenceAttempts, 60_000));
        await this.persistState(em, row, transaction, wallet);
        if (previousStatus !== TransactionStatus.PendingReference) await this.enqueueEvents(em, transaction, wallet, undefined, context);
        return;
      }
      if (reference.status !== TransactionStatus.Processed) failure = "REFERENCE_NOT_PROCESSED";
      else if (reference.walletId !== wallet.id || reference.playerId !== transaction.playerId || reference.currency !== transaction.money.currency || reference.roundId !== transaction.roundId) failure = "REFERENCE_MISMATCH";
      else if (transaction.kind === TransactionKind.Refund && reference.kind !== TransactionKind.Bet) failure = "INVALID_REFERENCE_KIND";
      else if (transaction.kind === TransactionKind.Rollback && ![TransactionKind.Bet, TransactionKind.Win, TransactionKind.Refund].includes(reference.kind as TransactionKind)) failure = "INVALID_REFERENCE_KIND";
      else if ([TransactionKind.Win, TransactionKind.Loss].includes(transaction.kind) && reference.kind !== TransactionKind.Bet) failure = "INVALID_REFERENCE_KIND";
      else if (transaction.requiresReference() && !transaction.money.equals(Money.rehydrate({ amount: reference.amount, currency: reference.currency }))) failure = "REFERENCE_AMOUNT_MISMATCH";
      if (!failure && transaction.requiresReference()) {
        const duplicate = await em.findOneBy(TransactionRow, { referenceTransactionId: reference.id, kind: transaction.kind, status: TransactionStatus.Processed });
        if (duplicate) failure = "REFERENCE_ALREADY_REVERSED";
      }
    }

    if (!failure && transaction.affectsBalance()) {
      const before = wallet.balance;
      const direction = transaction.ledgerDirectionFor(reference ? this.toTransaction(reference) : undefined);
      try {
        if (direction === LedgerDirection.Debit) wallet.debit(transaction.money);
        else wallet.credit(transaction.money);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        failure = error.code === "INSUFFICIENT_FUNDS" && transaction.kind === TransactionKind.Rollback
          ? "REVERSAL_INSUFFICIENT_FUNDS" : error.code;
      }
      if (!failure) {
        entry = WalletLedgerEntry.create({ id: randomUUID(), walletId: wallet.id, transactionId: transaction.id, direction, money: transaction.money, balanceBefore: before, balanceAfter: wallet.balance, createdAt: new Date() });
        await em.update(WalletRow, { id: wallet.id }, { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
        await this.insertLedger(em, entry, wallet.version);
      }
    }
    if (failure) transaction.reject(failure);
    else transaction.markProcessed(reference?.id, new Date());
    row.nextAttemptAt = null;
    await this.persistState(em, row, transaction, wallet);
    await this.enqueueEvents(em, transaction, wallet, entry, context);
  }

  private async lockWallet(em: EntityManager, id: string): Promise<Wallet> {
    const row = await em.findOne(WalletRow, { where: { id }, lock: { mode: "pessimistic_write" } });
    if (!row) throw new AppError(404, "WALLET_NOT_FOUND");
    return this.toWallet(row);
  }

  private toWallet(row: WalletRow): Wallet {
    return Wallet.rehydrate({ ...row, balance: Money.rehydrate({ amount: row.balance, currency: row.currency }) });
  }

  private toTransaction(row: TransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({ ...row, kind: row.kind as TransactionKind, status: row.status as TransactionStatus,
      money: Money.rehydrate({ amount: row.amount, currency: row.currency }), referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined, failureCode: row.failureCode ?? undefined, processedAt: row.processedAt ?? undefined });
  }

  private newRow(transaction: WagerTransaction, correlationId: string): TransactionRow {
    return Object.assign(new TransactionRow(), {
      id: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey, payloadHash: transaction.payloadHash, walletId: transaction.walletId,
      playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId,
      kind: transaction.kind, status: transaction.status, amount: transaction.money.toString(), currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null, referenceTransactionId: null,
      failureCode: null, balanceAfter: null, createdAt: transaction.createdAt, processedAt: null,
      referenceAttempts: 0, nextAttemptAt: null, correlationId,
    });
  }

  private async persistState(em: EntityManager, row: TransactionRow, transaction: WagerTransaction, wallet: Wallet): Promise<void> {
    Object.assign(row, {
      status: transaction.status, referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null, processedAt: transaction.processedAt ?? null, balanceAfter: wallet.balance.toString(),
    });
    await em.update(TransactionRow, { id: row.id }, {
      status: row.status, referenceTransactionId: row.referenceTransactionId, failureCode: row.failureCode,
      processedAt: row.processedAt, balanceAfter: row.balanceAfter, referenceAttempts: row.referenceAttempts, nextAttemptAt: row.nextAttemptAt,
    });
  }

  private async insertLedger(em: EntityManager, entry: WalletLedgerEntry, walletVersion: number): Promise<void> {
    await em.insert(LedgerRow, { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
      amount: entry.money.toString(), currency: entry.money.currency, balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(), walletVersion, createdAt: entry.createdAt });
  }

  private async enqueueEvents(em: EntityManager, transaction: WagerTransaction, wallet: Wallet, entry: WalletLedgerEntry | undefined, context: ProcessingContext): Promise<void> {
    const props = { eventId: randomUUID(), aggregateId: wallet.id, correlationId: context.correlationId,
      causationId: context.inbox?.messageId ?? transaction.id, occurredAt: new Date(), data: {
        transactionId: transaction.id, walletId: wallet.id, providerId: transaction.providerId, kind: transaction.kind,
        status: transaction.status, money: transaction.money.toJSON(), balance: wallet.balance.toJSON(),
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      } };
    const event = transaction.status === TransactionStatus.Processed ? WagerTransactionProcessed.create(props)
      : transaction.status === TransactionStatus.PendingReference ? WagerTransactionPendingReference.create(props)
        : WagerTransactionRejected.create(props);
    await this.enqueue(em, event);
    if (entry && !entry.balanceBefore.equals(entry.balanceAfter)) {
      await this.enqueue(em, WalletBalanceChanged.create({ ...props, eventId: randomUUID(), data: {
        walletId: wallet.id, transactionId: transaction.id, direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
      } }));
    }
  }

  private async enqueue(em: EntityManager, event: IntegrationEvent<object>): Promise<void> {
    await em.save(Object.assign(new OutboxRow(), { id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: event.toJSON() as unknown as Record<string, unknown>, occurredAt: event.occurredAt,
      attempts: 0, nextAttemptAt: event.occurredAt, publishedAt: null }));
  }

  private assertReplay(row: TransactionRow, key: string, hash: string): void {
    assertSameRequest(row, key, hash);
  }

  private async checkInbox(em: EntityManager, context: ProcessingContext): Promise<void> {
    if (!context.inbox) return;
    const inbox = await em.findOneBy(InboxRow, { consumerName: context.inbox.consumerName, messageId: context.inbox.messageId });
    if (inbox && inbox.payloadHash !== context.inbox.payloadHash) throw new AppError(409, "INBOX_PAYLOAD_CONFLICT");
  }

  private async recordInbox(em: EntityManager, context: ProcessingContext, transactionId: string): Promise<void> {
    if (!context.inbox) return;
    const existing = await em.findOneBy(InboxRow, { consumerName: context.inbox.consumerName, messageId: context.inbox.messageId });
    if (existing) {
      if (existing.payloadHash !== context.inbox.payloadHash || existing.transactionId !== transactionId) throw new AppError(409, "INBOX_PAYLOAD_CONFLICT");
      return;
    }
    await em.insert(InboxRow, { ...context.inbox, transactionId, receivedAt: new Date(), processedAt: new Date() });
  }

  private result(row: TransactionRow, currency: string, replay: boolean): TransactionResult {
    return { transactionId: row.id, status: row.status as TransactionStatus,
      balance: { amount: row.balanceAfter ?? "0.00", currency },
      ...(row.failureCode ? { failureCode: row.failureCode } : {}), idempotentReplay: replay };
  }

  private walletView(wallet: Wallet) {
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  private async transactionView(row: TransactionRow) {
    const wallet = await this.db.source.manager.findOneByOrFail(WalletRow, { id: row.walletId });
    return { ...this.result(row, wallet.currency, false), providerId: row.providerId, externalTransactionId: row.externalTransactionId,
      playerId: row.playerId, walletId: row.walletId, roundId: row.roundId, gameId: row.gameId, kind: row.kind,
      money: { amount: row.amount, currency: row.currency }, referenceExternalTransactionId: row.referenceExternalTransactionId,
      referenceTransactionId: row.referenceTransactionId, createdAt: row.createdAt, processedAt: row.processedAt };
  }
}
