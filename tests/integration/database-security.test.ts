import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Database } from "../../src/infrastructure/database/database.ts";
import { WalletRow, OutboxRow } from "../../src/infrastructure/database/rows.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import { databaseCode } from "../../src/application/errors.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { integrationDatabaseUrl, integrationEnabled, commandFor } from "../fixtures/financial-helpers.ts";

const applicationUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (integrationEnabled && !applicationUrl) throw new Error("APP_DATABASE_URL is required for application-role security tests.");

describe.skipIf(!integrationEnabled)("PostgreSQL security — SCRAM, tenant identity and least privilege", () => {
  let owner: Database;
  let application: Database;
  let service: WagerService;

  beforeAll(async () => {
    owner = await Database.connect(integrationDatabaseUrl);
    await owner.migrate();
    application = await Database.connectApplication(applicationUrl);
    service = new WagerService(application, new Telemetry(true));
  }, 30_000);

  afterAll(async () => {
    await application?.close();
    await owner?.close();
  });

  async function canAuthenticate(password: string): Promise<boolean> {
    const url = new URL(applicationUrl);
    const client = new Client({ host: url.hostname, port: Number(url.port || "5432"),
      database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username),
      password, connectionTimeoutMillis: 2_000 });
    try { await client.connect(); await client.query("SELECT 1"); return true; }
    catch { return false; }
    finally { await client.end().catch(() => {}); }
  }

  async function denied(sql: string, parameters: unknown[] = []): Promise<void> {
    let caught: unknown;
    try {
      await application.transaction(async (em) => {
        await em.query(sql, parameters);
        // If misconfigured credentials permit the attack, rollback before asserting failure.
        throw new Error("Forbidden operation unexpectedly succeeded; transaction rolled back.");
      });
    } catch (error) { caught = error; }
    expect(databaseCode(caught)).toBe("42501");
  }

  async function createZero(tenantId: string) {
    const id = randomUUID();
    const playerId = randomUUID();
    await application.source.manager.insert(WalletRow, { id, playerId, tenantId, currency: "BRL",
      balance: "0.00", version: 1, createdAt: new Date(), updatedAt: new Date() });
    return { id, playerId };
  }

  test("application connection succeeds only with its generated password", async () => {
    expect(await canAuthenticate(decodeURIComponent(new URL(applicationUrl).password))).toBe(true);
    expect(await canAuthenticate("")).toBe(false);
    expect(await canAuthenticate("jungle")).toBe(false);
  });

  test("app has no superuser, role/database creation, replication, bypassRLS or owner membership", async () => {
    const [row] = await application.source.query<Array<Record<string, boolean | string>>>(`
      SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
        has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        has_database_privilege(current_user,current_database(),'CREATE') AS db_create,
        has_database_privilege(current_user,current_database(),'TEMPORARY') AS db_temp
      FROM pg_roles r WHERE r.rolname=current_user
    `);
    expect(row?.name).toBe("jungle_app");
    for (const [key, value] of Object.entries(row ?? {})) if (key !== "name") expect(value).toBe(false);
  });

  test("runtime refuses a valid but privileged migrator connection", async () => {
    await expect(Database.connectApplication(integrationDatabaseUrl)).rejects.toThrow("Application database role must be restricted");
  });

  test("app cannot create a table, schema, temporary shadow or another role", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    await denied(`CREATE TABLE public.forbidden_${suffix}(id INTEGER)`);
    await denied(`CREATE SCHEMA forbidden_${suffix}`);
    await denied(`CREATE TEMP TABLE forbidden_${suffix}(id INTEGER)`);
    await denied(`CREATE ROLE forbidden_${suffix}`);
  });

  test("app cannot disable ledger triggers, truncate history or bypass replication guards", async () => {
    await denied("ALTER TABLE wallet_ledger DISABLE TRIGGER ALL");
    await denied("TRUNCATE wallet_ledger");
    await denied("SET LOCAL session_replication_role='replica'");
    await denied("DROP TABLE wallet_ledger CASCADE");
  });

  test("app cannot assume the migrator role", async () => {
    const role = decodeURIComponent(new URL(integrationDatabaseUrl).username).replaceAll('"', '""');
    await denied(`SET LOCAL ROLE "${role}"`);
  });

  test("app cannot update/delete ledger entries or mutate a wallet's tenant identity", async () => {
    const wallet = await createZero(`security-${randomUUID()}`);
    await denied("UPDATE wallet_ledger SET amount=amount WHERE wallet_id=$1", [wallet.id]);
    await denied("DELETE FROM wallet_ledger WHERE wallet_id=$1", [wallet.id]);
    await denied("UPDATE wallets SET tenant_id='attacker' WHERE id=$1", [wallet.id]);
    await denied("UPDATE wallets SET player_id=$1 WHERE id=$2", [randomUUID(), wallet.id]);
  });

  test("tenant identity remains immutable even through an owner connection", async () => {
    const tenantId = `security-${randomUUID()}`;
    const wallet = await createZero(tenantId);
    await expect(owner.source.query("UPDATE wallets SET tenant_id='different-tenant' WHERE id=$1", [wallet.id]))
      .rejects.toMatchObject({ driverError: { code: "23514" } });
    const row = await application.source.manager.findOneByOrFail(WalletRow, { id: wallet.id });
    expect(row.tenantId).toBe(tenantId);
  });

  test("ordinary financial writes, replay, ledger and outbox still work as the restricted app", async () => {
    const wallet = await createZero(`security-${randomUUID()}`);
    const win = commandFor(wallet, { kind: "WIN", money: { amount: "10.00", currency: "BRL" } });
    const winResult = await service.submit(win, `${win.providerId}:${win.externalTransactionId}`, { correlationId: randomUUID() });
    expect(winResult.status).toBe("PROCESSED");
    const bet = commandFor(wallet, { money: { amount: "3.00", currency: "BRL" } });
    const key = `${bet.providerId}:${bet.externalTransactionId}`;
    const result = await service.submit(bet, key, { correlationId: randomUUID() });
    const replay = await service.submit(bet, key, { correlationId: randomUUID() });
    expect(result.balance.amount).toBe("7.00");
    expect(replay).toEqual({ ...result, idempotentReplay: true });
    const reconciliation = await service.reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.calculatedBalance.amount).toBe("7.00");
    expect(reconciliation.checkedEntries).toBe(2);
    const event = await application.source.manager.findOneByOrFail(OutboxRow, { aggregateId: wallet.id });
    await application.source.manager.update(OutboxRow, { id: event.id }, { attempts: 1, nextAttemptAt: new Date() });
    await denied("UPDATE outbox SET payload='{}'::jsonb WHERE id=$1", [event.id]);
  });

  test("tenant insertion does not weaken the global player/currency uniqueness invariant", async () => {
    const wallet = await createZero(`security-${randomUUID()}`);
    await expect(application.source.manager.insert(WalletRow, { id: randomUUID(), playerId: wallet.playerId,
      tenantId: `other-${randomUUID()}`, currency: "BRL", balance: "0.00", version: 1,
      createdAt: new Date(), updatedAt: new Date() })).rejects.toMatchObject({ driverError: { code: "23505" } });
  });
});
