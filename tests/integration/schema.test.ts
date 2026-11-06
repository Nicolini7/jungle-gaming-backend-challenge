import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { QueryRunner } from "typeorm";
import { Database } from "../../src/infrastructure/database/database.ts";
import { WalletRow } from "../../src/infrastructure/database/rows.ts";
import { InitialFinancialSchema1793865600000 } from "../../src/migrations/1793865600000-initial-financial-schema.ts";
import { TenantAndLeastPrivilege1793865700000 } from "../../src/migrations/1793865700000-tenant-and-least-privilege.ts";

const enabled = process.env.RUN_INTEGRATION === "1";
const url = process.env.MIGRATION_DATABASE_URL ?? "";
if (enabled && !url) throw new Error("MIGRATION_DATABASE_URL is required for the isolated schema harness.");
const hash = "a".repeat(64);

/** This suite owns a generated schema. It never truncates the application's ledger. */
describe.skipIf(!enabled)("PostgreSQL — migrations and schema guarantees", () => {
  let db: Database;
  let runner: QueryRunner;
  const schema = `jw_schema_${crypto.randomUUID().replaceAll("-", "")}`;
  const migration = new InitialFinancialSchema1793865600000();
  const securityMigration = new TenantAndLeastPrivilege1793865700000();

  beforeAll(async () => {
    db = await Database.connect(url);
    runner = db.source.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}"`);
    await migration.up(runner);
    await securityMigration.up(runner);
  }, 30_000);

  afterAll(async () => {
    if (runner) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await runner.release();
    }
    if (db) await db.close();
  }, 30_000);

  async function atomic<T>(fn: () => Promise<T>): Promise<T> {
    await runner.startTransaction("READ COMMITTED");
    try {
      const result = await fn();
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }

  async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
    let caught: unknown;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect((caught as { driverError?: { code?: string } } | undefined)?.driverError?.code).toBe(code);
  }

  async function openZero(playerId: string = crypto.randomUUID()): Promise<{ id: string; playerId: string }> {
    const id = crypto.randomUUID();
    await runner.query(
      "INSERT INTO wallets(id,player_id,currency,balance,version) VALUES($1,$2,'BRL',0.00,1)",
      [id, playerId],
    );
    return { id, playerId };
  }

  async function insertTransaction(props: {
    id: string; walletId: string; playerId: string; kind: string; amount: string;
    status?: string; balanceAfter?: string | null; currency?: string;
    failureCode?: string | null; externalId?: string; key?: string;
    referenceId?: string | null; referenceExternalId?: string | null;
  }): Promise<void> {
    const status = props.status ?? "PROCESSED";
    await runner.query(`
      INSERT INTO wager_transactions(
        id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,
        round_id,game_id,kind,status,amount,currency,balance_after,processed_at,
        failure_code,correlation_id,reference_transaction_id,reference_external_transaction_id
      ) VALUES($1,'schema-provider',$2,$3,$4,$5,$6,'schema-round','schema-game',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      props.id, props.externalId ?? props.id, props.key ?? props.id, hash, props.walletId,
      props.playerId, props.kind, status, props.amount, props.currency ?? "BRL",
      props.balanceAfter ?? null, status === "PROCESSED" ? new Date() : null,
      props.failureCode ?? null, crypto.randomUUID(), props.referenceId ?? null,
      props.referenceExternalId ?? null,
    ]);
  }

  async function insertLedger(props: {
    walletId: string; transactionId: string; amount: string; before: string; after: string;
    version: number; direction?: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await runner.query(`
      INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,
        balance_before,balance_after,wallet_version)
      VALUES($1,$2,$3,$4,$5,'BRL',$6,$7,$8)
    `, [id, props.walletId, props.transactionId, props.direction ?? "CREDIT", props.amount,
      props.before, props.after, props.version]);
    return id;
  }

  async function openFunded(): Promise<{ id: string; playerId: string; openingId: string; ledgerId: string }> {
    return atomic(async () => {
      const id = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const openingId = crypto.randomUUID();
      await runner.query(
        "INSERT INTO wallets(id,player_id,currency,balance,version) VALUES($1,$2,'BRL',100.00,1)",
        [id, playerId],
      );
      await insertTransaction({ id: openingId, walletId: id, playerId, kind: "OPENING", amount: "100.00", balanceAfter: "100.00" });
      const ledgerId = await insertLedger({ walletId: id, transactionId: openingId, amount: "100.00", before: "0.00", after: "100.00", version: 1 });
      return { id, playerId, openingId, ledgerId };
    });
  }

  test("migration can be reversed and reapplied in an isolated schema", async () => {
    const isolated = `jw_reverse_${crypto.randomUUID().replaceAll("-", "")}`;
    const other = db.source.createQueryRunner();
    await other.connect();
    try {
      await other.query(`CREATE SCHEMA "${isolated}"`);
      await other.query(`SET search_path TO "${isolated}"`);
      await migration.up(other);
      await securityMigration.up(other);
      await securityMigration.down(other);
      await migration.down(other);
      const absent = await other.query("SELECT to_regclass('wallets') AS table_name") as Array<{ table_name: string | null }>;
      expect(absent[0]?.table_name).toBeNull();
      await migration.up(other);
      await securityMigration.up(other);
      const present = await other.query("SELECT to_regclass('wallets') AS table_name") as Array<{ table_name: string }>;
      expect(present[0]?.table_name).toBe("wallets");
    } finally {
      await other.query(`DROP SCHEMA IF EXISTS "${isolated}" CASCADE`);
      await other.release();
    }
  });

  test("NUMERIC round-trips through TypeORM as an exact fixed-scale string", async () => {
    const wallet = await openZero();
    const stored = await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id });
    expect(stored.balance).toBe("0.00");
    expect(typeof stored.balance).toBe("string");
    const populated = await openFunded();
    expect((await runner.manager.findOneByOrFail(WalletRow, { id: populated.id })).balance).toBe("100.00");
  });

  test.each(["-0.01", "1.005", "NaN", "Infinity", "-Infinity", "1000000000000000000.00"])(
    "rejects invalid money directly in SQL: %s", async (amount) => {
      await expectSqlState(() => runner.query(
        "INSERT INTO wallets(id,player_id,currency,balance,version) VALUES($1,$2,'BRL',$3,1)",
        [crypto.randomUUID(), crypto.randomUUID(), amount],
      ), "23514");
    },
  );

  test("enforces one wallet per player and currency", async () => {
    const wallet = await openZero();
    await expectSqlState(() => openZero(wallet.playerId), "23505");
  });

  test("positive opening balance without corresponding ledger cannot commit", async () => {
    const id = crypto.randomUUID();
    await expectSqlState(() => runner.query(
      "INSERT INTO wallets(id,player_id,currency,balance,version) VALUES($1,$2,'BRL',100.00,1)",
      [id, crypto.randomUUID()],
    ), "23514");
    expect(await runner.query("SELECT id FROM wallets WHERE id=$1", [id])).toHaveLength(0);
  });

  test("balance update without ledger rolls back at commit", async () => {
    const wallet = await openFunded();
    await expectSqlState(() => runner.query(
      "UPDATE wallets SET balance=99.00, version=2 WHERE id=$1", [wallet.id],
    ), "23514");
    expect((await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id })).balance).toBe("100.00");
  });

  test("version cannot change without balance change", async () => {
    const wallet = await openZero();
    await expectSqlState(() => runner.query("UPDATE wallets SET version=2 WHERE id=$1", [wallet.id]), "23514");
  });

  test("version must increase on an actual balance change", async () => {
    const wallet = await openFunded();
    await expectSqlState(() => runner.query("UPDATE wallets SET balance=99.00 WHERE id=$1", [wallet.id]), "23514");
  });

  test("ledger rejects UPDATE, DELETE and TRUNCATE", async () => {
    const wallet = await openFunded();
    await expectSqlState(() => runner.query("UPDATE wallet_ledger SET amount=100.00 WHERE id=$1", [wallet.ledgerId]), "23514");
    await expectSqlState(() => runner.query("DELETE FROM wallet_ledger WHERE id=$1", [wallet.ledgerId]), "23514");
    await expectSqlState(() => runner.query("TRUNCATE wallet_ledger"), "23514");
  });

  test("one transaction cannot produce two entries for the same wallet", async () => {
    const wallet = await openFunded();
    await expectSqlState(() => insertLedger({
      walletId: wallet.id, transactionId: wallet.openingId, amount: "100.00",
      before: "100.00", after: "200.00", version: 2,
    }), "23505");
  });

  test("terminal transaction and request identity remain immutable", async () => {
    const wallet = await openFunded();
    await expectSqlState(() => runner.query(
      "UPDATE wager_transactions SET status='REJECTED', failure_code='ALTERED' WHERE id=$1", [wallet.openingId],
    ), "23514");
    await expectSqlState(() => runner.query("DELETE FROM wager_transactions WHERE id=$1", [wallet.openingId]), "23514");
  });

  test("a rejected currency/player mismatch is persisted for audit without moving money", async () => {
    const wallet = await openZero();
    const transactionId = crypto.randomUUID();
    await insertTransaction({
      id: transactionId, walletId: wallet.id, playerId: crypto.randomUUID(), kind: "BET",
      amount: "1.00", currency: "USD", status: "REJECTED", failureCode: "CURRENCY_MISMATCH",
    });
    expect(await runner.query("SELECT id FROM wager_transactions WHERE id=$1", [transactionId])).toHaveLength(1);
    expect((await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id })).balance).toBe("0.00");
  });

  test("processed financial operation cannot commit without ledger", async () => {
    const wallet = await openFunded();
    await expectSqlState(() => insertTransaction({
      id: crypto.randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
      kind: "BET", amount: "10.00", balanceAfter: "90.00",
    }), "23514");
  });

  test("LOSS is processed without ledger or version increment", async () => {
    const wallet = await openFunded();
    await insertTransaction({
      id: crypto.randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
      kind: "LOSS", amount: "0.00", balanceAfter: "100.00",
    });
    const stored = await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id });
    expect(stored.balance).toBe("100.00");
    expect(stored.version).toBe(1);
    expect(await runner.query("SELECT id FROM wallet_ledger WHERE wallet_id=$1", [wallet.id])).toHaveLength(1);
  });

  test("LOSS may reference a processed BET of the same round without a financial movement", async () => {
    const wallet = await openFunded();
    const betId = crypto.randomUUID();
    await atomic(async () => {
      await insertTransaction({ id: betId, walletId: wallet.id, playerId: wallet.playerId,
        kind: "BET", amount: "10.00", balanceAfter: "90.00" });
      await runner.query("UPDATE wallets SET balance=90.00,version=2 WHERE id=$1", [wallet.id]);
      await insertLedger({ walletId: wallet.id, transactionId: betId, direction: "DEBIT",
        amount: "10.00", before: "100.00", after: "90.00", version: 2 });
    });
    const lossId = crypto.randomUUID();
    await insertTransaction({ id: lossId, walletId: wallet.id, playerId: wallet.playerId,
      kind: "LOSS", amount: "0.00", balanceAfter: "90.00", referenceId: betId, referenceExternalId: betId });
    const stored = await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id });
    expect(stored.balance).toBe("90.00");
    expect(stored.version).toBe(2);
    expect(await runner.query("SELECT id FROM wallet_ledger WHERE transaction_id=$1", [lossId])).toHaveLength(0);
  });

  test("wallet, transaction, ledger, inbox and outbox commit together", async () => {
    const wallet = await openFunded();
    const transactionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await atomic(async () => {
      await runner.query("SELECT id FROM wallets WHERE id=$1 FOR UPDATE", [wallet.id]);
      await insertTransaction({ id: transactionId, walletId: wallet.id, playerId: wallet.playerId, kind: "BET", status: "PENDING", amount: "80.00" });
      await runner.query("UPDATE wallets SET balance=20.00,version=2 WHERE id=$1", [wallet.id]);
      await insertLedger({ walletId: wallet.id, transactionId, direction: "DEBIT", amount: "80.00", before: "100.00", after: "20.00", version: 2 });
      await runner.query("UPDATE wager_transactions SET status='PROCESSED',balance_after=20.00,processed_at=NOW() WHERE id=$1", [transactionId]);
      await runner.query("INSERT INTO inbox(consumer_name,message_id,payload_hash,transaction_id,processed_at) VALUES('schema-test',$1,$2,$3,NOW())", [messageId, hash, transactionId]);
      await runner.query("INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,'WagerTransactionProcessed',$3)", [eventId, wallet.id, { eventId, transactionId }]);
    });
    expect((await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id })).balance).toBe("20.00");
    expect(await runner.query("SELECT id FROM wallet_ledger WHERE transaction_id=$1", [transactionId])).toHaveLength(1);
    expect(await runner.query("SELECT message_id FROM inbox WHERE message_id=$1", [messageId])).toHaveLength(1);
    expect(await runner.query("SELECT id FROM outbox WHERE id=$1", [eventId])).toHaveLength(1);
  });

  test("a failure before commit rolls back all five financial records", async () => {
    const wallet = await openFunded();
    const transactionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const simulatedFailure = new Error("simulated failure before commit");
    await expect(atomic(async () => {
      await insertTransaction({ id: transactionId, walletId: wallet.id, playerId: wallet.playerId, kind: "BET", amount: "80.00", balanceAfter: "20.00" });
      await runner.query("UPDATE wallets SET balance=20.00,version=2 WHERE id=$1", [wallet.id]);
      await insertLedger({ walletId: wallet.id, transactionId, direction: "DEBIT", amount: "80.00", before: "100.00", after: "20.00", version: 2 });
      await runner.query("INSERT INTO inbox(consumer_name,message_id,payload_hash,transaction_id,processed_at) VALUES('schema-test',$1,$2,$3,NOW())", [messageId, hash, transactionId]);
      await runner.query("INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,'WagerTransactionProcessed',$3)", [eventId, wallet.id, { eventId, transactionId }]);
      throw simulatedFailure;
    })).rejects.toBe(simulatedFailure);
    expect((await runner.manager.findOneByOrFail(WalletRow, { id: wallet.id })).balance).toBe("100.00");
    expect(await runner.query("SELECT id FROM wager_transactions WHERE id=$1", [transactionId])).toHaveLength(0);
    expect(await runner.query("SELECT id FROM wallet_ledger WHERE transaction_id=$1", [transactionId])).toHaveLength(0);
    expect(await runner.query("SELECT message_id FROM inbox WHERE message_id=$1", [messageId])).toHaveLength(0);
    expect(await runner.query("SELECT id FROM outbox WHERE id=$1", [eventId])).toHaveLength(0);
  });
});
