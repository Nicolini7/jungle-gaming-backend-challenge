import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import type { TransactionResult } from "../../src/application/wager-service.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import type { WagerInput } from "../../src/application/contracts.ts";
import { databaseCode } from "../../src/application/errors.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { WalletRow } from "../../src/infrastructure/database/rows.ts";
import { createApplication } from "../../src/infrastructure/http/application.ts";
import { BackgroundWorkers } from "../../src/infrastructure/messaging/background-workers.ts";
import { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway.ts";
import { AuthorizedWagerProcessor } from "../../src/infrastructure/security/authorized-processor.ts";
import { identityConfiguration } from "../../src/infrastructure/security/identity.ts";
import { TenantAccessPolicy } from "../../src/infrastructure/security/policy.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { identityToken } from "../fixtures/oidc.ts";
import type { DemoClient } from "../fixtures/oidc.ts";

interface WalletView { id: string; playerId: string; balance: { amount: string; currency: string }; version: number }
interface ErrorView { error: { code: string }; retryable: boolean }
interface DeadLetter { failureCode: string; originalBody: string }
const clients: DemoClient[] = ["admin-a", "provider-a", "admin-b", "provider-b", "provider-c"];
const enabled = process.env.RUN_INTEGRATION === "1";

/** Exercise real Keycloak signatures, restricted PostgreSQL permissions and the public ingress adapters. */
describe.skipIf(!enabled)("Keycloak + restricted PostgreSQL — identity and tenant boundaries", () => {
  let owner: Database;
  let db: Database;
  let service: WagerService;
  let app: INestApplication;
  let origin: string;
  let gateway: SqsGateway;
  let workers: BackgroundWorkers;
  const tokens = new Map<DemoClient, string>();
  const queues: SqsGateway[] = [];

  async function queue(): Promise<SqsGateway> {
    const suffix = randomUUID();
    const result = new SqsGateway({ endpoint: process.env.SQS_ENDPOINT!, region: process.env.AWS_REGION ?? "us-east-1",
      queueName: `authorization-${suffix}.fifo`, eventQueueName: `authorization-events-${suffix}.fifo`,
      dlqName: `authorization-dlq-${suffix}.fifo`, visibilityTimeout: 30, maxReceives: 5 });
    queues.push(result);
    await result.ensureQueues();
    return result;
  }

  beforeAll(async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    const applicationUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!migrationUrl || !applicationUrl || !process.env.SQS_ENDPOINT) throw new Error("Explicit migration/app database URLs and SQS endpoint are required.");
    owner = await Database.connect(migrationUrl);
    await owner.migrate();
    db = await Database.connectApplication(applicationUrl);
    const issued = await Promise.all(clients.map(async client => [client, await identityToken(client)] as const));
    for (const [client, token] of issued) tokens.set(client, token);
    gateway = await queue();
    const telemetry = new Telemetry(true);
    service = new WagerService(db, telemetry);
    const policy = new TenantAccessPolicy(db, identityConfiguration().providerTenants);
    workers = new BackgroundWorkers(db, gateway, new AuthorizedWagerProcessor(service, policy), telemetry);
    app = await createApplication(db, service, gateway, telemetry);
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    for (const entry of queues) {
      await Promise.allSettled([entry.commandQueueUrl, entry.eventQueueUrl, entry.dlqUrl].filter(Boolean)
        .map(QueueUrl => entry.client.send(new DeleteQueueCommand({ QueueUrl }))));
      entry.destroy();
    }
    await Promise.all([db?.close(), owner?.close()]);
  }, 30_000);

  async function request(path: string, client?: DemoClient, method = "GET", body?: unknown, key?: string, authorization?: string) {
    const headers = new Headers();
    if (authorization !== undefined) headers.set("Authorization", authorization);
    else if (client) headers.set("Authorization", `Bearer ${tokens.get(client)!}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (key) headers.set("Idempotency-Key", key);
    return fetch(`${origin}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  async function wallet(client: DemoClient = "admin-a", amount = "100.00"): Promise<WalletView> {
    const response = await request("/wallets", client, "POST", {
      playerId: randomUUID(), initialBalance: { amount, currency: "BRL" },
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<WalletView>;
  }

  function command(target: WalletView, providerId = "provider-a", overrides: Partial<WagerInput> = {}): WagerInput {
    return { providerId, externalTransactionId: randomUUID(), playerId: target.playerId, walletId: target.id,
      roundId: randomUUID(), gameId: "authorization-game", kind: "BET", money: { amount: "25.00", currency: "BRL" }, ...overrides };
  }

  async function submit(input: WagerInput, client: DemoClient = "provider-a", key = `${input.providerId}:${input.externalTransactionId}`) {
    return request("/wagering/transactions", client, "POST", input, key);
  }

  async function denied(response: Response, statuses = [403, 404]): Promise<void> {
    expect(statuses).toContain(response.status);
    const body = await response.json() as ErrorView;
    expect(body.error.code).toBeString();
    expect(body.retryable).toBe(false);
    expect(body).not.toHaveProperty("balance");
    expect(body).not.toHaveProperty("playerId");
    expect(body).not.toHaveProperty("items");
    expect(body).not.toHaveProperty("storedBalance");
  }

  async function balance(target: WalletView, amount: string): Promise<void> {
    expect((await service.getWallet(target.id)).balance.amount).toBe(amount);
  }

  function envelope(input: WagerInput, messageId = randomUUID()) {
    return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...input, idempotencyKey: `${input.providerId}:${input.externalTransactionId}` } };
  }

  async function deadLetters(transport = gateway): Promise<DeadLetter[]> {
    const result = await transport.client.send(new ReceiveMessageCommand({
      QueueUrl: transport.dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30,
    }));
    const messages = result.Messages ?? [];
    const parsed = messages.map(message => JSON.parse(message.Body!) as DeadLetter);
    await Promise.all(messages.map(message => transport.client.send(new DeleteMessageCommand({
      QueueUrl: transport.dlqUrl, ReceiptHandle: message.ReceiptHandle!,
    }))));
    return parsed;
  }

  test("health remains anonymous; all seven financial handlers and metrics reject missing identity", async () => {
    expect((await request("/health/live")).status).toBe(200);
    expect((await request("/health/ready")).status).toBe(200);
    const id = randomUUID();
    const routes = [
      ["POST", "/wallets"], ["GET", `/wallets/${id}`], ["GET", `/wallets/${id}/ledger`],
      ["POST", `/wallets/${id}/reconciliation`], ["GET", `/wagering/transactions/${id}`],
      ["GET", `/providers/provider-a/wagering/transactions/${id}`], ["POST", "/wagering/transactions"],
      ["GET", "/metrics"],
    ] as const;
    for (const [method, path] of routes) await denied(await request(path, undefined, method), [401]);
  });

  test("only tenant administrators create wallets and the signed tenant is persisted", async () => {
    for (const amount of ["0.00", "100.00"]) {
      const playerId = randomUUID();
      await denied(await request("/wallets", "provider-a", "POST", { playerId, initialBalance: { amount, currency: "BRL" } }), [403]);
      expect(await owner.source.manager.countBy(WalletRow, { playerId })).toBe(0);
    }
    const a = await wallet("admin-a");
    const b = await wallet("admin-b");
    expect((await owner.source.manager.findOneByOrFail(WalletRow, { id: a.id })).tenantId).toBe("operator-a");
    expect((await owner.source.manager.findOneByOrFail(WalletRow, { id: b.id })).tenantId).toBe("operator-b");
    for (const ownership of [{ tenantId: "operator-b" }, { tenant_id: "__internal__" }]) {
      const playerId = randomUUID();
      await denied(await request("/wallets", "admin-a", "POST", {
        playerId, initialBalance: { amount: "100.00", currency: "BRL" }, ...ownership,
      }), [400]);
      expect(await owner.source.manager.countBy(WalletRow, { playerId })).toBe(0);
    }
  });

  test("metrics require an administrator role and remain available to authenticated administrators", async () => {
    await denied(await request("/metrics", "provider-a"), [403]);
    const response = await request("/metrics", "admin-a");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("jungle_outbox_current_lag_seconds");
  });

  test("a provider can submit, replay and query its transaction and tenant wallet", async () => {
    const target = await wallet();
    const input = command(target);
    const first = await submit(input);
    expect(first.status).toBe(200);
    const original = await first.json() as TransactionResult;
    expect(original.idempotentReplay).toBe(false);
    const repeat = await submit(input);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ...original, idempotentReplay: true });
    for (const path of [`/wallets/${target.id}`, `/wallets/${target.id}/ledger`,
      `/wagering/transactions/${original.transactionId}`, `/providers/provider-a/wagering/transactions/${input.externalTransactionId}`]) {
      expect((await request(path, "provider-a")).status).toBe(200);
    }
    const reconciliation = await request(`/wallets/${target.id}/reconciliation`, "provider-a", "POST");
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({ consistent: true, storedBalance: { amount: "75.00", currency: "BRL" } });
    await balance(target, "75.00");
  });

  test("tenant isolation covers wallet, ledger, reconciliation and both transaction lookup forms in both directions", async () => {
    const fixtures = [];
    for (const [admin, provider, providerId] of [["admin-a", "provider-a", "provider-a"], ["admin-b", "provider-b", "provider-b"]] as const) {
      const target = await wallet(admin);
      const input = command(target, providerId);
      const response = await submit(input, provider);
      expect(response.status).toBe(200);
      fixtures.push({ target, input, result: await response.json() as TransactionResult });
    }
    for (const [index, clientsFromOtherTenant, otherProviderId] of [
      [0, ["admin-b", "provider-b"], "provider-b"], [1, ["admin-a", "provider-a"], "provider-a"],
    ] as const) {
      const { target, input, result } = fixtures[index]!;
      for (const client of clientsFromOtherTenant) {
        for (const path of [`/wallets/${target.id}`, `/wallets/${target.id}/ledger?limit=100`,
          `/wagering/transactions/${result.transactionId}`, `/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`]) {
          await denied(await request(path, client));
        }
        await denied(await request(`/wallets/${target.id}/reconciliation`, client, "POST"));
        await denied(await submit(command(target, otherProviderId), client));
      }
      await balance(target, "75.00");
    }
  });

  test("signed provider identity cannot be replaced by body, URL or another tenant's administrator", async () => {
    const target = await wallet();
    for (const client of ["provider-a", "admin-a"] as const) {
      await denied(await submit(command(target, "provider-b"), client), [403]);
      await denied(await submit(command(target, `unregistered-${randomUUID()}`), client), [403]);
      await denied(await submit(command(target, "constructor"), client), [403]);
      await denied(await request(`/providers/provider-b/wagering/transactions/${randomUUID()}`, client), [403]);
    }
    await denied(await submit(command(target, "system")), [400]);
    await balance(target, "100.00");
  });

  test("two providers in one tenant can concurrently move the shared wallet while transaction identities remain scoped", async () => {
    const target = await wallet();
    const a = command(target);
    const c = command(target, "provider-c");
    const responses = await Promise.all([submit(a, "provider-a"), submit(c, "provider-c")]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const [resultA, resultC] = await Promise.all(responses.map(response => response.json() as Promise<TransactionResult>));
    await balance(target, "50.00");
    expect((await request(`/wallets/${target.id}/ledger`, "provider-c")).status).toBe(200);
    expect((await request(`/wagering/transactions/${resultC!.transactionId}`, "provider-c")).status).toBe(200);
    await denied(await request(`/wagering/transactions/${resultA!.transactionId}`, "provider-c"), [404]);
    await denied(await request(`/providers/provider-a/wagering/transactions/${a.externalTransactionId}`, "provider-c"), [403]);
    expect((await request(`/wagering/transactions/${resultA!.transactionId}`, "admin-a")).status).toBe(200);
  });

  test("reserved internal legacy wallets and their opening transactions remain unreachable to external identities", async () => {
    const legacy = await service.createWallet({ playerId: randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
    const ledger = await service.ledger(legacy.id);
    const openingId = ledger.items[0]!.transactionId;
    for (const client of clients) {
      for (const path of [`/wallets/${legacy.id}`, `/wallets/${legacy.id}/ledger`, `/wagering/transactions/${openingId}`]) {
        await denied(await request(path, client), [404]);
      }
      await denied(await request(`/wallets/${legacy.id}/reconciliation`, client, "POST"), [404]);
    }
    await denied(await submit(command(legacy)), [404]);
    await balance(legacy, "100.00");
  });

  test("tampered Keycloak tenant, provider, issuer, audience and roles do not become trusted claims", async () => {
    const original = tokens.get("provider-a")!.split(".");
    const claims = JSON.parse(Buffer.from(original[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const changed of [{ tenant_id: "operator-b", provider_id: "provider-b" }, { tenant_id: "__internal__" },
      { realm_access: { roles: ["wallet-admin"] } }, { iss: "https://untrusted.invalid/realm" }, { aud: "other-api" }, { exp: 0 }]) {
      const payload = Buffer.from(JSON.stringify({ ...claims, ...changed })).toString("base64url");
      await denied(await request("/metrics", undefined, "GET", undefined, undefined,
        `Bearer ${original[0]}.${payload}.${original[2]}`), [401]);
    }
    for (const authorization of ["Bearer not-a-jwt", `Basic ${tokens.get("provider-a")!}`, `Bearer ${original[0]}.${original[1]}.`,
      `Bearer ${tokens.get("provider-a")!}, Bearer ${tokens.get("admin-a")!}`]) {
      await denied(await request("/metrics", undefined, "GET", undefined, undefined, authorization), [401]);
    }
  });

  test("the runtime role cannot change schema, disable the ownership trigger or rewrite tenant ownership", async () => {
    const target = await wallet();
    for (const [sql, parameters] of [
      [`CREATE SCHEMA denied_${randomUUID().replaceAll("-", "")}`, []],
      ["ALTER TABLE wallets DISABLE TRIGGER wallet_guard", []],
      ["UPDATE wallets SET tenant_id=$1 WHERE id=$2", ["operator-b", target.id]],
    ] as const) {
      let caught: unknown;
      try {
        await db.transaction(async em => {
          await em.query(sql, [...parameters]);
          // Roll back even if a regression unexpectedly grants the forbidden operation.
          throw new Error("Unexpected application database permission.");
        });
      } catch (error) { caught = error; }
      expect(databaseCode(caught)).toBe("42501");
    }
    let immutable: unknown;
    try {
      await owner.transaction(async em => {
        await em.query("UPDATE wallets SET tenant_id=$1 WHERE id=$2", ["operator-b", target.id]);
        throw new Error("Unexpected mutable tenant ownership.");
      });
    }
    catch (error) { immutable = error; }
    expect(databaseCode(immutable)).toBe("23514");
    expect((await owner.source.manager.findOneByOrFail(WalletRow, { id: target.id })).tenantId).toBe("operator-a");
  });

  test("trusted SQS commands need no JWT and redelivery still produces one debit", async () => {
    const target = await wallet();
    const input = command(target);
    const message = envelope(input);
    await gateway.sendCommand(message);
    expect(await workers.pollOnce(2)).toBe(1);
    await balance(target, "75.00");
    await gateway.client.send(new SendMessageCommand({ QueueUrl: gateway.commandQueueUrl,
      MessageBody: JSON.stringify(message), MessageGroupId: target.id, MessageDeduplicationId: randomUUID() }));
    expect(await workers.pollOnce(2)).toBe(1);
    await balance(target, "75.00");
    const inbox = await db.source.query("SELECT transaction_id FROM inbox WHERE consumer_name=$1 AND message_id=$2", ["wager-transactions-v1", message.messageId]);
    expect(inbox).toHaveLength(1);
    expect(await deadLetters()).toHaveLength(0);
  }, 15_000);

  test("SQS rejects unknown providers, cross-tenant wallets and internal legacy wallets before financial or inbox writes", async () => {
    const target = await wallet();
    const legacy = await service.createWallet({ playerId: randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
    const cases = [
      { input: command(target, "provider-b"), code: "WALLET_NOT_FOUND" },
      { input: command(target, "constructor"), code: "PROVIDER_NOT_REGISTERED" },
      { input: command(legacy), code: "WALLET_NOT_FOUND" },
    ];
    for (const item of cases) {
      const message = envelope(item.input);
      await gateway.sendCommand(message);
      expect(await workers.pollOnce(2)).toBe(1);
      const letters = await deadLetters();
      expect(letters).toHaveLength(1);
      expect(letters[0]).toMatchObject({ failureCode: item.code, originalBody: JSON.stringify(message) });
      expect(await db.source.query("SELECT id FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2",
        [item.input.providerId, item.input.externalTransactionId])).toHaveLength(0);
      expect(await db.source.query("SELECT message_id FROM inbox WHERE consumer_name=$1 AND message_id=$2",
        ["wager-transactions-v1", message.messageId])).toHaveLength(0);
    }
    await balance(target, "100.00");
    await balance(legacy, "100.00");
  }, 20_000);

  test("an existing legacy transaction does not authorize a cross-tenant HTTP or SQS replay", async () => {
    const target = await wallet();
    const input = command(target, "provider-b", { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } });
    // The trusted core harness represents history admitted before the ingress policy existed.
    const key = `${input.providerId}:${input.externalTransactionId}`;
    const existing = await service.submit(input, key, { correlationId: randomUUID() });
    expect(existing.status).toBe("PROCESSED");
    for (const client of ["provider-b", "admin-b"] as const) {
      await denied(await submit(input, client, key), [404]);
      await denied(await request(`/wagering/transactions/${existing.transactionId}`, client), [404]);
    }
    const message = envelope(input);
    await gateway.sendCommand(message);
    expect(await workers.pollOnce(2)).toBe(1);
    const letters = await deadLetters();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ failureCode: "WALLET_NOT_FOUND", originalBody: JSON.stringify(message) });
    expect(await db.source.query("SELECT message_id FROM inbox WHERE consumer_name=$1 AND message_id=$2",
      ["wager-transactions-v1", message.messageId])).toHaveLength(0);
    expect((await service.getTransaction(existing.transactionId)).status).toBe("PROCESSED");
    await balance(target, "100.00");
  }, 10_000);
});
