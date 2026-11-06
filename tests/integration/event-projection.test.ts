import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import type { WagerInput } from "../../src/application/contracts.ts";
import { AppError } from "../../src/application/errors.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { createApplication } from "../../src/infrastructure/http/application.ts";
import { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway.ts";
import { SqsEventConsumer } from "../../src/infrastructure/notifications/event-consumer.ts";
import { EventProjector } from "../../src/infrastructure/notifications/event-projector.ts";
import type { FinancialIntegrationEvent } from "../../src/infrastructure/notifications/event-projector.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { InitialFinancialSchema1793865600000 } from "../../src/migrations/1793865600000-initial-financial-schema.ts";
import { TenantAndLeastPrivilege1793865700000 } from "../../src/migrations/1793865700000-tenant-and-least-privilege.ts";
import { EventProjections1793865800000 } from "../../src/migrations/1793865800000-event-projections.ts";
import { commandFor, integrationDatabaseUrl, integrationEnabled, submitCommand } from "../fixtures/financial-helpers.ts";
import { identityToken } from "../fixtures/oidc.ts";
import type { DemoClient } from "../fixtures/oidc.ts";

interface WalletView { id: string; playerId: string; balance: { amount: string; currency: string }; version: number }
type EventType = FinancialIntegrationEvent["eventType"];

describe.skipIf(!integrationEnabled)("Persistent event receipts, notifications and ordered balance projections", () => {
  let owner: Database;
  let db: Database;
  let otherDb: Database;
  let service: WagerService;
  let projector: EventProjector;
  let otherProjector: EventProjector;
  let app: INestApplication;
  let origin: string;
  const queues: SqsGateway[] = [];
  const tokens = new Map<DemoClient, string>();

  async function queue(): Promise<SqsGateway> {
    const suffix = randomUUID();
    const gateway = new SqsGateway({ endpoint: process.env.SQS_ENDPOINT!, region: process.env.AWS_REGION ?? "us-east-1",
      queueName: `projection-commands-${suffix}.fifo`, eventQueueName: `projection-events-${suffix}.fifo`,
      dlqName: `projection-command-dlq-${suffix}.fifo`, visibilityTimeout: 30, maxReceives: 5 });
    queues.push(gateway);
    await gateway.ensureQueues();
    await gateway.ensureEventConsumerQueue();
    return gateway;
  }

  beforeAll(async () => {
    const applicationUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!integrationDatabaseUrl || !applicationUrl || !process.env.SQS_ENDPOINT) throw new Error("Explicit owner/app PostgreSQL and SQS settings are required.");
    owner = await Database.connect(integrationDatabaseUrl);
    await owner.migrate();
    db = await Database.connectApplication(applicationUrl);
    otherDb = await Database.connectApplication(applicationUrl);
    service = new WagerService(db, new Telemetry(true));
    projector = new EventProjector(db);
    otherProjector = new EventProjector(otherDb);
    const issued = await Promise.all((["admin-a", "provider-a", "admin-b"] as const)
      .map(async client => [client, await identityToken(client)] as const));
    for (const [client, token] of issued) tokens.set(client, token);
    app = await createApplication(db, service, await queue(), new Telemetry(true));
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    for (const gateway of queues) {
      await Promise.allSettled([gateway.commandQueueUrl, gateway.eventQueueUrl, gateway.dlqUrl, gateway.eventDlqUrl]
        .filter(Boolean).map(QueueUrl => gateway.client.send(new DeleteQueueCommand({ QueueUrl }))));
      gateway.destroy();
    }
    await Promise.all([db?.close(), otherDb?.close(), owner?.close()]);
  }, 30_000);

  async function wallet(amount = "100.00", tenantId = "operator-a"): Promise<WalletView> {
    return service.createWallet({ playerId: randomUUID(), initialBalance: { amount, currency: "BRL" } }, { tenantId });
  }

  async function operation(target: WalletView, overrides: Partial<WagerInput> = {}) {
    const command = commandFor(target, { providerId: "provider-a", ...overrides });
    const result = await submitCommand(service, command);
    return { command, result };
  }

  async function event(transactionId: string, eventType: EventType): Promise<FinancialIntegrationEvent> {
    const rows = await owner.source.query<Array<{ payload: FinancialIntegrationEvent }>>(
      "SELECT payload FROM outbox WHERE payload->'data'->>'transactionId'=$1 AND event_type=$2", [transactionId, eventType]);
    expect(rows).toHaveLength(1);
    return rows[0]!.payload;
  }

  async function count(table: "event_receipts" | "in_app_notifications" | "wallet_balance_projections", column: "event_id" | "transaction_id" | "wallet_id", value: string): Promise<number> {
    const [row] = await owner.source.query<Array<{ count: number }>>(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`, [value]);
    return row!.count;
  }

  async function assertFinancialBalance(target: WalletView, amount: string) {
    const state = await service.reconcile(target.id);
    expect(state.consistent).toBe(true);
    expect(state.storedBalance).toEqual({ amount, currency: "BRL" });
    expect(state.calculatedBalance).toEqual(state.storedBalance);
  }

  async function send(gateway: SqsGateway, body: string): Promise<void> {
    // Different transport identities and groups force the persistent consumer boundary to handle duplicates.
    await gateway.client.send(new SendMessageCommand({ QueueUrl: gateway.eventQueueUrl, MessageBody: body,
      MessageGroupId: randomUUID(), MessageDeduplicationId: randomUUID() }));
  }

  async function readQueue(gateway: SqsGateway, QueueUrl: string) {
    const response = await gateway.client.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 0,
      MaxNumberOfMessages: 10, VisibilityTimeout: 30 }));
    const messages = response.Messages ?? [];
    await Promise.all(messages.map(message => gateway.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle! }))));
    return messages;
  }

  async function within<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Event lifecycle test exceeded its deadline")), milliseconds);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async function fault(table: "in_app_notifications" | "wallet_balance_projections", walletId: string): Promise<() => Promise<void>> {
    const suffix = randomUUID().replaceAll("-", "");
    const fn = `event_fault_${suffix}`;
    const trigger = `event_fault_${suffix}`;
    await owner.source.query(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.wallet_id='${walletId}'::uuid THEN
        RAISE EXCEPTION 'injected event persistence failure' USING ERRCODE='40001';
      END IF; RETURN NEW; END $$`);
    try {
      await owner.source.query(`CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
    } catch (error) { await owner.source.query(`DROP FUNCTION "${fn}"()`); throw error; }
    return async () => {
      await owner.source.query(`DROP TRIGGER IF EXISTS "${trigger}" ON ${table}`);
      await owner.source.query(`DROP FUNCTION IF EXISTS "${fn}"()`);
    };
  }

  test("fifty concurrent copies across independent pools create one receipt and one notification card", async () => {
    const target = await wallet();
    const { result } = await operation(target);
    const status = await event(result.transactionId, "WagerTransactionProcessed");
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => (index % 2 ? projector : otherProjector).process(status)));
    expect(results.filter(item => !item.duplicate)).toHaveLength(1);
    expect(results.filter(item => item.notificationApplied)).toHaveLength(1);
    expect(results.filter(item => item.duplicate)).toHaveLength(49);
    expect(await count("event_receipts", "event_id", status.eventId)).toBe(1);
    expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(1);
    const snapshot = await event(result.transactionId, "WalletBalanceChanged");
    const snapshots = await Promise.all(Array.from({ length: 50 }, (_, index) => (index % 2 ? projector : otherProjector).process(snapshot)));
    expect(snapshots.filter(item => item.projectionApplied)).toHaveLength(1);
    expect(await count("event_receipts", "event_id", snapshot.eventId)).toBe(1);
    expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(1);
    expect(await projector.balanceProjection(target.id)).toMatchObject({ walletVersion: 2, balance: { amount: "75.00", currency: "BRL" } });
    await assertFinancialBalance(target, "75.00");
  }, 60_000);

  test.each(["status-first", "balance-first"] as const)("one financial operation creates one card with %s event delivery", async order => {
    const target = await wallet();
    const { result } = await operation(target);
    const status = await event(result.transactionId, "WagerTransactionProcessed");
    const snapshot = await event(result.transactionId, "WalletBalanceChanged");
    for (const item of order === "status-first" ? [status, snapshot] : [snapshot, status]) await projector.process(item);
    const notifications = await projector.listNotifications(target.id);
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0]).toMatchObject({ transactionId: result.transactionId, recipientId: target.playerId, channel: "in_app", status: "PROCESSED" });
    expect(await count("event_receipts", "event_id", status.eventId)).toBe(1);
    expect(await count("event_receipts", "event_id", snapshot.eventId)).toBe(1);
  });

  test("a newer full balance snapshot is retained when older versions arrive later", async () => {
    const target = await wallet();
    const first = await operation(target);
    const second = await operation(target, { money: { amount: "10.00", currency: "BRL" } });
    const [opening] = await owner.source.query<Array<{ payload: FinancialIntegrationEvent }>>(
      "SELECT payload FROM outbox WHERE aggregate_id=$1 AND event_type='WalletBalanceChanged' AND payload->'data'->>'walletVersion'='1'", [target.id]);
    const latest = await event(second.result.transactionId, "WalletBalanceChanged");
    const older = await event(first.result.transactionId, "WalletBalanceChanged");
    expect((await projector.process(latest)).projectionApplied).toBe(true);
    expect((await otherProjector.process(older)).projectionApplied).toBe(false);
    expect((await projector.process(opening!.payload)).projectionApplied).toBe(false);
    const projection = await projector.balanceProjection(target.id);
    expect(projection).toMatchObject({ walletVersion: 3, eventId: latest.eventId, balance: { amount: "65.00", currency: "BRL" } });
    for (const item of [opening!.payload, older, latest]) expect(await count("event_receipts", "event_id", item.eventId)).toBe(1);
    expect((await projector.listNotifications(target.id)).items).toHaveLength(0);
    await assertFinancialBalance(target, "65.00");
  });

  test("racing snapshots and replays converge to the highest committed wallet version", async () => {
    const target = await wallet();
    const operations = [];
    for (const amount of ["25.00", "10.00", "5.00"]) operations.push(await operation(target, { money: { amount, currency: "BRL" } }));
    const snapshots = await Promise.all(operations.map(item => event(item.result.transactionId, "WalletBalanceChanged")));
    const copies = Array.from({ length: 12 }, (_, index) => snapshots[[2, 0, 1][index % 3]!]!);
    await Promise.all(copies.map((item, index) => (index % 2 ? projector : otherProjector).process(item)));
    expect(await projector.balanceProjection(target.id)).toMatchObject({ walletVersion: 4, balance: { amount: "60.00", currency: "BRL" } });
    expect(await count("wallet_balance_projections", "wallet_id", target.id)).toBe(1);
    for (const item of snapshots) expect(await count("event_receipts", "event_id", item.eventId)).toBe(1);
    await assertFinancialBalance(target, "60.00");
  });

  test.each(["different payload", "unknown producer event", "wallet substitution", "provider substitution", "tenant injection", "future wallet version"] as const)(
    "rejects %s without claiming a receipt or applying a read model", async mutation => {
      const target = await wallet();
      const { result } = await operation(target);
      const original = await event(result.transactionId, mutation === "future wallet version" ? "WalletBalanceChanged" : "WagerTransactionProcessed");
      const altered = structuredClone(original) as unknown as { eventId: string; aggregateId: string; data: Record<string, unknown> };
      if (mutation === "different payload") altered.data.money = { amount: "24.00", currency: "BRL" };
      if (mutation === "unknown producer event") altered.eventId = randomUUID();
      if (mutation === "wallet substitution") altered.aggregateId = altered.data.walletId = randomUUID();
      if (mutation === "provider substitution") altered.data.providerId = "provider-b";
      if (mutation === "tenant injection") altered.data.tenantId = "operator-b";
      if (mutation === "future wallet version") altered.data.walletVersion = 2_147_483_647;
      await expect(projector.process(altered)).rejects.toBeInstanceOf(AppError);
      expect(await count("event_receipts", "event_id", altered.eventId)).toBe(0);
      expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(0);
      expect(await projector.balanceProjection(target.id)).toBeNull();
      await assertFinancialBalance(target, "75.00");
    });

  test("a terminal notification never regresses when its older pending event arrives", async () => {
    const target = await wallet();
    const bet = commandFor(target, { providerId: "provider-a" });
    const refund = commandFor(target, { providerId: bet.providerId, roundId: bet.roundId, kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submitCommand(service, refund);
    expect(pending.status).toBe("PENDING_REFERENCE");
    const before = await event(pending.transactionId, "WagerTransactionPendingReference");
    await submitCommand(service, bet);
    await owner.source.query("UPDATE wager_transactions SET next_attempt_at=now() WHERE id=$1", [pending.transactionId]);
    await service.retryPending();
    const terminal = await event(pending.transactionId, "WagerTransactionProcessed");
    expect((await projector.process(terminal)).notificationApplied).toBe(true);
    const first = await projector.listNotifications(target.id);
    expect((await otherProjector.process(before)).notificationApplied).toBe(false);
    expect((await projector.listNotifications(target.id)).items).toEqual(first.items);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ status: "PROCESSED", eventId: terminal.eventId });
    await assertFinancialBalance(target, "100.00");
  });

  test("a pending card is updated in place when the operation reaches a terminal status", async () => {
    const target = await wallet();
    const bet = commandFor(target, { providerId: "provider-a" });
    const refund = commandFor(target, { providerId: bet.providerId, roundId: bet.roundId, kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submitCommand(service, refund);
    await projector.process(await event(pending.transactionId, "WagerTransactionPendingReference"));
    const initial = (await projector.listNotifications(target.id)).items[0]!;
    expect(initial.status).toBe("PENDING_REFERENCE");
    await submitCommand(service, bet);
    await owner.source.query("UPDATE wager_transactions SET next_attempt_at=now() WHERE id=$1", [pending.transactionId]);
    await service.retryPending();
    await otherProjector.process(await event(pending.transactionId, "WagerTransactionProcessed"));
    const final = (await projector.listNotifications(target.id)).items;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ id: initial.id, transactionId: pending.transactionId, status: "PROCESSED" });
    expect(final[0]!.createdAt).toBe(initial.createdAt);
  });

  test("rejected and LOSS operations create status cards without changing the financial balance", async () => {
    const target = await wallet("0.00");
    const rejected = await operation(target);
    expect(rejected.result.status).toBe("REJECTED");
    await projector.process(await event(rejected.result.transactionId, "WagerTransactionRejected"));
    const loss = await operation(target, { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } });
    await projector.process(await event(loss.result.transactionId, "WagerTransactionProcessed"));
    const items = (await projector.listNotifications(target.id)).items;
    expect(items.map(item => item.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(await projector.balanceProjection(target.id)).toBeNull();
    await assertFinancialBalance(target, "0.00");
  });

  test("a rejected currency mismatch remains a valid notification for the wallet owner", async () => {
    const target = await wallet();
    const rejected = await operation(target, { money: { amount: "25.00", currency: "USD" } });
    expect(rejected.result.status).toBe("REJECTED");
    expect(rejected.result.failureCode).toBe("CURRENCY_MISMATCH");
    const input = await event(rejected.result.transactionId, "WagerTransactionRejected");
    expect((await projector.process(input)).notificationApplied).toBe(true);
    expect((await projector.listNotifications(target.id)).items[0]).toMatchObject({
      recipientId: target.playerId, status: "REJECTED", transactionId: rejected.result.transactionId,
    });
    expect(await projector.balanceProjection(target.id)).toBeNull();
    await assertFinancialBalance(target, "100.00");
  });

  test("the read-model migration is reversible and repeatable in an isolated schema", async () => {
    const runner = owner.source.createQueryRunner();
    const schema = `event_schema_${randomUUID().replaceAll("-", "")}`;
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      await new InitialFinancialSchema1793865600000().up(runner);
      await new TenantAndLeastPrivilege1793865700000().up(runner);
      const migration = new EventProjections1793865800000();
      await migration.up(runner);
      const tables = ["event_receipts", "wallet_balance_projections", "in_app_notifications"];
      for (const table of tables) {
        const [row] = await runner.query("SELECT to_regclass($1)::text AS name", [`${schema}.${table}`]) as Array<{ name: string | null }>;
        expect(row!.name).not.toBeNull();
      }
      await migration.down(runner);
      for (const table of tables) {
        const [row] = await runner.query("SELECT to_regclass($1)::text AS name", [`${schema}.${table}`]) as Array<{ name: string | null }>;
        expect(row!.name).toBeNull();
      }
      await migration.up(runner);
      const [row] = await runner.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('event_receipts','wallet_balance_projections','in_app_notifications')", [schema]) as Array<{ count: number }>;
      expect(row!.count).toBe(3);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    const [remaining] = await owner.source.query<Array<{ count: number }>>("SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1", [schema]);
    expect(remaining!.count).toBe(0);
  }, 30_000);

  test.each(["in_app_notifications", "wallet_balance_projections"] as const)("a SQL failure in %s rolls back its event receipt and effect atomically", async table => {
    const target = await wallet();
    const { result } = await operation(target);
    const input = await event(result.transactionId, table === "in_app_notifications" ? "WagerTransactionProcessed" : "WalletBalanceChanged");
    const clear = await fault(table, target.id);
    try { await expect(projector.process(input)).rejects.toBeDefined(); }
    finally { await clear(); }
    expect(await count("event_receipts", "event_id", input.eventId)).toBe(0);
    expect(await count(table, "wallet_id", target.id)).toBe(0);
    const recovered = await otherProjector.process(input);
    expect(recovered.duplicate).toBe(false);
    expect(recovered.notificationApplied || recovered.projectionApplied).toBe(true);
    expect(await count("event_receipts", "event_id", input.eventId)).toBe(1);
    expect(await count(table, "wallet_id", target.id)).toBe(1);
    await assertFinancialBalance(target, "75.00");
  });

  test("runtime privileges cannot replace notification recipients or regress projection versions", async () => {
    const target = await wallet();
    const { result } = await operation(target);
    await projector.process(await event(result.transactionId, "WagerTransactionProcessed"));
    await projector.process(await event(result.transactionId, "WalletBalanceChanged"));
    await expect(db.source.query("UPDATE in_app_notifications SET recipient_id=$1 WHERE wallet_id=$2", [randomUUID(), target.id])).rejects.toBeDefined();
    await expect(db.source.query("UPDATE wallet_balance_projections SET wallet_version=1 WHERE wallet_id=$1", [target.id])).rejects.toBeDefined();
    await expect(owner.source.query("UPDATE in_app_notifications SET status='REJECTED' WHERE wallet_id=$1", [target.id])).rejects.toBeDefined();
    expect(await projector.balanceProjection(target.id)).toMatchObject({ walletVersion: 2, balance: { amount: "75.00", currency: "BRL" } });
    expect((await projector.listNotifications(target.id)).items[0]!.recipientId).toBe(target.playerId);
  });

  test("HTTP read models reject anonymous and cross-tenant requests while allowing their wallet scope", async () => {
    const target = await wallet();
    const { result } = await operation(target);
    await projector.process(await event(result.transactionId, "WagerTransactionProcessed"));
    await projector.process(await event(result.transactionId, "WalletBalanceChanged"));
    for (const suffix of ["notifications", "balance-projection"]) {
      const url = `${origin}/wallets/${target.id}/${suffix}`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { Authorization: `Bearer ${tokens.get("admin-b")!}` } })).status).toBe(404);
      for (const client of ["admin-a", "provider-a"] as const) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${tokens.get(client)!}` } });
        expect(response.status).toBe(200);
        expect(await response.json()).toHaveProperty("walletId", target.id);
      }
    }
    const headers = { Authorization: `Bearer ${tokens.get("admin-a")!}` };
    for (const limit of ["0", "101", "1.5", "invalid", "1 OR 1=1"]) {
      expect((await fetch(`${origin}/wallets/${target.id}/notifications?limit=${encodeURIComponent(limit)}`, { headers })).status).toBe(400);
    }
    const noEvents = await wallet("0.00");
    expect((await fetch(`${origin}/wallets/${noEvents.id}/balance-projection`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/health/live`)).status).toBe(200);
  });

  test("two SQS event consumers handle physical redeliveries without a duplicate card", async () => {
    const gateway = await queue();
    const target = await wallet();
    const { result } = await operation(target);
    const input = await event(result.transactionId, "WagerTransactionProcessed");
    const first = new SqsEventConsumer(projector, gateway, new Telemetry(true));
    const second = new SqsEventConsumer(otherProjector, gateway, new Telemetry(true));
    await Promise.all(Array.from({ length: 50 }, () => send(gateway, JSON.stringify(input))));
    let received = 0;
    for (let round = 0; round < 20 && received < 50; round++) {
      const counts = await Promise.all([first.pollOnce(0), second.pollOnce(0)]);
      received += counts[0]! + counts[1]!;
    }
    expect(received).toBe(50);
    expect(await gateway.receiveEvents(0)).toHaveLength(0);
    expect(await count("event_receipts", "event_id", input.eventId)).toBe(1);
    expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(1);
    expect(await readQueue(gateway, gateway.eventDlqUrl)).toHaveLength(0);
    await assertFinancialBalance(target, "75.00");
  }, 60_000);

  test("redelivery after commit but before event acknowledgment reuses the persisted notification", async () => {
    const gateway = await queue();
    const target = await wallet();
    const { result } = await operation(target);
    const input = await event(result.transactionId, "WagerTransactionProcessed");
    let receipt = "";
    const receive = gateway.receiveEvents.bind(gateway);
    gateway.receiveEvents = async (...args) => {
      const messages = await receive(...args);
      receipt = messages[0]?.ReceiptHandle ?? receipt;
      return messages;
    };
    let fail = true;
    const worker = new SqsEventConsumer(projector, gateway, new Telemetry(true), { beforeAck: async () => {
      expect(await count("event_receipts", "event_id", input.eventId)).toBe(1);
      expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(1);
      if (fail) { fail = false; throw new AppError(503, "INJECTED_EVENT_ACK_FAILURE"); }
    } });
    await send(gateway, JSON.stringify(input));
    expect(await worker.pollOnce(0)).toBe(1);
    const original = (await projector.listNotifications(target.id)).items[0]!;
    expect(receipt).not.toBe("");
    await gateway.changeEventVisibility(receipt, 0);
    expect(await worker.pollOnce(0)).toBe(1);
    expect((await projector.listNotifications(target.id)).items).toEqual([original]);
    expect(await gateway.receiveEvents(0)).toHaveLength(0);
    expect(await readQueue(gateway, gateway.eventDlqUrl)).toHaveLength(0);
  });

  test("shutdown drains a manually started event poll and acknowledges only after its commit", async () => {
    const gateway = await queue();
    const target = await wallet();
    const { result } = await operation(target);
    const input = await event(result.transactionId, "WagerTransactionProcessed");
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let acknowledged = false;
    const acknowledge = gateway.acknowledgeEvent.bind(gateway);
    gateway.acknowledgeEvent = async receipt => { acknowledged = true; await acknowledge(receipt); };
    const worker = new SqsEventConsumer({ process: async raw => {
      enter();
      await blocked;
      return projector.process(raw);
    } }, gateway, new Telemetry(true), { shutdownGraceMs: 5000, beforeAck: async () => {
      expect(await count("event_receipts", "event_id", input.eventId)).toBe(1);
      expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(1);
    } });
    await send(gateway, JSON.stringify(input));
    const polling = worker.pollOnce(0);
    let closing: Promise<void> | undefined;
    try {
      await within(entered, 5000);
      let closed = false;
      closing = worker.stop().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      expect(acknowledged).toBe(false);
      expect(await count("event_receipts", "event_id", input.eventId)).toBe(0);
      release();
      await within(Promise.all([polling, closing]), 5000);
      expect(closed).toBe(true);
      expect(acknowledged).toBe(true);
      expect(await gateway.receiveEvents(0)).toHaveLength(0);
      expect(await count("in_app_notifications", "transaction_id", result.transactionId)).toBe(1);
      await assertFinancialBalance(target, "75.00");
    } finally {
      release();
      await Promise.allSettled([polling, closing ?? worker.stop()]);
    }
  }, 30_000);

  test("expired shutdown grace returns event visibility and a second consumer completes it once", async () => {
    const gateway = await queue();
    const target = await wallet();
    const { result } = await operation(target);
    const input = await event(result.transactionId, "WagerTransactionProcessed");
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let returnedVisibility = false;
    const change = gateway.changeEventVisibility.bind(gateway);
    gateway.changeEventVisibility = async (...args) => {
      const [, seconds] = args;
      if (seconds === 0) returnedVisibility = true;
      await change(...args);
    };
    const worker = new SqsEventConsumer({ process: async raw => {
      enter();
      await blocked;
      return projector.process(raw);
    } }, gateway, new Telemetry(true), { shutdownGraceMs: 20 });
    await send(gateway, JSON.stringify(input));
    const polling = worker.pollOnce(0);
    try {
      await within(entered, 5000);
      await within(worker.stop(), 5000);
      expect(returnedVisibility).toBe(true);
      expect(await count("event_receipts", "event_id", input.eventId)).toBe(0);
      const recovered = new SqsEventConsumer(otherProjector, gateway, new Telemetry(true));
      expect(await recovered.pollOnce(0)).toBe(1);
      const before = (await projector.listNotifications(target.id)).items;
      expect(before).toHaveLength(1);
      release();
      await within(Promise.allSettled([polling]), 5000);
      expect((await projector.listNotifications(target.id)).items).toEqual(before);
      expect(await count("event_receipts", "event_id", input.eventId)).toBe(1);
      expect(await gateway.receiveEvents(0)).toHaveLength(0);
      await assertFinancialBalance(target, "75.00");
    } finally {
      release();
      await Promise.allSettled([polling, worker.stop()]);
    }
  }, 30_000);

  test("a poison event goes to the event DLQ before its source is acknowledged", async () => {
    const gateway = await queue();
    const worker = new SqsEventConsumer(projector, gateway, new Telemetry(true));
    const body = "{invalid-financial-event";
    await send(gateway, body);
    expect(await worker.pollOnce(0)).toBe(1);
    expect(await gateway.receiveEvents(0)).toHaveLength(0);
    const dead = await readQueue(gateway, gateway.eventDlqUrl);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0]!.Body!) as unknown).toMatchObject({ originalBody: body });
    expect(await readQueue(gateway, gateway.dlqUrl)).toHaveLength(0);
  });
});
