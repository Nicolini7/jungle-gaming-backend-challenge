import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { WagerService } from "../../src/application/wager-service.ts";
import type { TransactionResult } from "../../src/application/wager-service.ts";
import type { WagerInput } from "../../src/application/contracts.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { createApplication } from "../../src/infrastructure/http/application.ts";
import { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { commandFor as financialCommand, integrationDatabaseUrl, integrationEnabled } from "../fixtures/financial-helpers.ts";
import { identityToken } from "../fixtures/oidc.ts";

const commandFor: typeof financialCommand = (wallet, overrides = {}) => financialCommand(wallet, { providerId: "provider-a", ...overrides });

interface MoneyView { amount: string; currency: string }
interface WalletView { id: string; playerId: string; balance: MoneyView; version: number }
interface ErrorView { error: { code: string }; retryable: boolean }
interface LedgerView {
  items: Array<{ id: string; transactionId: string; walletVersion: number; money: MoneyView;
    balanceBefore: MoneyView; balanceAfter: MoneyView }>;
  nextCursor: string | null;
}
interface ReconciliationView {
  consistent: boolean; storedBalance: MoneyView; calculatedBalance: MoneyView;
  difference: MoneyView; checkedEntries: number;
}

describe.skipIf(!integrationEnabled)("HTTP real — contratos e consultas financeiras", () => {
  let database: Database;
  let app: INestApplication;
  let base: string;
  let gateway: SqsGateway;
  let service: WagerService;
  let token: string;
  const suffix = randomUUID();

  beforeAll(async () => {
    database = await Database.connect(integrationDatabaseUrl);
    await database.migrate();
    gateway = new SqsGateway({ endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566", region: "us-east-1",
      queueName: `http-commands-${suffix}.fifo`, eventQueueName: `http-events-${suffix}.fifo`, dlqName: `http-dlq-${suffix}.fifo` });
    await gateway.ensureQueues();
    const telemetry = new Telemetry(true);
    service = new WagerService(database, telemetry);
    token = await identityToken();
    app = await createApplication(database, service, gateway, telemetry);
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (gateway) {
      await Promise.allSettled([gateway.commandQueueUrl, gateway.eventQueueUrl, gateway.dlqUrl]
        .filter(Boolean).map(QueueUrl => gateway.client.send(new DeleteQueueCommand({ QueueUrl }))));
      gateway.destroy();
    }
    if (database) await database.close();
  }, 30_000);

  async function request<T>(path: string, init?: RequestInit, origin = base): Promise<{ response: Response; body: T }> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    return { response, body: await response.json() as T };
  }

  async function post<T>(path: string, body: unknown, key?: string, origin = base) {
    return request<T>(path, { method: "POST", headers: {
      "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
    }, body: JSON.stringify(body) }, origin);
  }

  async function wallet(amount = "100.00"): Promise<WalletView> {
    const created = await post<WalletView>("/wallets", { playerId: randomUUID(), initialBalance: { amount, currency: "BRL" } });
    expect(created.response.status).toBe(201);
    return created.body;
  }

  async function submit(command: WagerInput, key = `${command.providerId}:${command.externalTransactionId}`) {
    return post<TransactionResult>("/wagering/transactions", command, key);
  }

  test("liveness/readiness abertos verificam PostgreSQL e SQS reais", async () => {
    const live = await request<{ status: string }>("/health/live");
    expect(live.response.status).toBe(200);
    expect(live.body.status).toBe("alive");
    const ready = await request<{ status: string; postgres: string; sqs: string }>("/health/ready");
    expect(ready.response.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", postgres: "up", sqs: "up" });
  });

  test("cria wallet com saldo string e retorna conflito na criação duplicada", async () => {
    const input = { playerId: randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } };
    const created = await post<WalletView>("/wallets", input);
    expect(created.response.status).toBe(201);
    expect(created.body.balance).toEqual(input.initialBalance);
    expect(created.body.version).toBe(1);
    const duplicate = await post<ErrorView>("/wallets", input);
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test.each(["1.005", "NaN", "1e3", "-1.00", "1000000000000000000.00"])(
    "rejeita valor monetário inválido com400: %s", async (amount) => {
      const invalid = await post<ErrorView>("/wallets", { playerId: randomUUID(), initialBalance: { amount, currency: "BRL" } });
      expect(invalid.response.status).toBe(400);
      expect(invalid.body.retryable).toBe(false);
    },
  );

  test("exige Idempotency-Key e rejeita JSON malformado como400", async () => {
    const target = await wallet();
    const missing = await post<ErrorView>("/wagering/transactions", commandFor(target));
    expect(missing.response.status).toBe(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const malformed = await request<ErrorView>("/wallets", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{" });
    expect(malformed.response.status).toBe(400);
  });

  test("OPENING externo e campos extras são payloads inválidos", async () => {
    const target = await wallet();
    const command = commandFor(target);
    const opening = await post<ErrorView>("/wagering/transactions", { ...command, kind: "OPENING" }, randomUUID());
    expect(opening.response.status).toBe(400);
    const extra = await post<ErrorView>("/wagering/transactions", { ...command, unexpected: "field" }, randomUUID());
    expect(extra.response.status).toBe(400);
  });

  test("identificador inválido é400 e wallet inexistente é404", async () => {
    expect((await request<ErrorView>("/wallets/not-a-uuid")).response.status).toBe(400);
    expect((await request<ErrorView>(`/wallets/${randomUUID()}`)).response.status).toBe(404);
  });

  test("rejeição de negócio é422 e seu replay preserva saldo original", async () => {
    const target = await wallet("0.00");
    const bet = commandFor(target);
    const rejected = await submit(bet);
    expect(rejected.response.status).toBe(422);
    expect(rejected.body.status).toBe("REJECTED");
    expect(rejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(rejected.body.balance.amount).toBe("0.00");
    await submit(commandFor(target, { kind: "WIN", money: { amount: "50.00", currency: "BRL" } }));
    const replay = await submit(bet);
    expect(replay.response.status).toBe(422);
    expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
    expect((await request<WalletView>(`/wallets/${target.id}`)).body.balance.amount).toBe("50.00");
  });

  test("mesma key com payload divergente retorna409 e não movimenta novamente", async () => {
    const target = await wallet();
    const command = commandFor(target);
    const key = randomUUID();
    expect((await submit(command, key)).response.status).toBe(200);
    const conflict = await post<ErrorView>("/wagering/transactions", { ...command, money: { amount: "26.00", currency: "BRL" } }, key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await request<WalletView>(`/wallets/${target.id}`)).body.balance.amount).toBe("75.00");
  });

  test("referência ausente retorna202 e consulta expõe estado pendente", async () => {
    const target = await wallet();
    const reversal = commandFor(target, { kind: "REFUND", referenceExternalTransactionId: `missing-${randomUUID()}` });
    const pending = await submit(reversal);
    expect(pending.response.status).toBe(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");
    expect(pending.body.balance.amount).toBe("100.00");
    const queried = await request<TransactionResult>(`/wagering/transactions/${pending.body.transactionId}`);
    expect(queried.response.status).toBe(200);
    expect(queried.body.status).toBe("PENDING_REFERENCE");
  });

  test("LOSS referenciada à BET processa sem novo lançamento ou versão", async () => {
    const target = await wallet();
    const bet = commandFor(target);
    expect((await submit(bet)).response.status).toBe(200);
    const loss = commandFor(target, { kind: "LOSS", money: { amount: "0.00", currency: "BRL" },
      providerId: bet.providerId, roundId: bet.roundId, referenceExternalTransactionId: bet.externalTransactionId });
    const result = await submit(loss);
    expect(result.response.status).toBe(200);
    expect(result.body.status).toBe("PROCESSED");
    expect((await request<WalletView>(`/wallets/${target.id}`)).body.version).toBe(2);
    expect((await request<LedgerView>(`/wallets/${target.id}/ledger`)).body.items).toHaveLength(2);
  });

  test("conflito de moeda permanece auditável com422 e saldo na moeda da wallet", async () => {
    const target = await wallet();
    const mismatched = commandFor(target, { money: { amount: "1.00", currency: "USD" } });
    const rejected = await submit(mismatched);
    expect(rejected.response.status).toBe(422);
    expect(rejected.body.failureCode).toBe("CURRENCY_MISMATCH");
    expect(rejected.body.balance).toEqual({ amount: "100.00", currency: "BRL" });
    const transaction = await request<TransactionResult & { money: MoneyView }>(`/wagering/transactions/${rejected.body.transactionId}`);
    expect(transaction.body.money).toEqual({ amount: "1.00", currency: "USD" });
  });

  test("cursor opaco pagina ledger estável sem duplicar entradas", async () => {
    const target = await wallet();
    for (let index = 0; index < 3; index++) await submit(commandFor(target, { money: { amount: "10.00", currency: "BRL" } }));
    const first = await request<LedgerView>(`/wallets/${target.id}/ledger?limit=2`);
    expect(first.response.status).toBe(200);
    expect(first.body.items.map(item => item.walletVersion)).toEqual([1, 2]);
    expect(typeof first.body.nextCursor).toBe("string");
    const next = await request<LedgerView>(`/wallets/${target.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items.map(item => item.walletVersion)).toEqual([3, 4]);
    expect(next.body.nextCursor).toBeNull();
    expect(new Set([...first.body.items, ...next.body.items].map(item => item.id)).size).toBe(4);
    const other = await wallet();
    expect((await request<ErrorView>(`/wallets/${other.id}/ledger?cursor=${first.body.nextCursor}`)).response.status).toBe(400);
    expect((await request<ErrorView>(`/wallets/${target.id}/ledger?cursor=invalid`)).response.status).toBe(400);
    expect((await request<ErrorView>(`/wallets/${target.id}/ledger?limit=0`)).response.status).toBe(400);
  });

  test("consultas porid/provedor e reconciliação preservam histórico e valores string", async () => {
    const target = await wallet();
    const command = commandFor(target);
    const submitted = await submit(command);
    const before = await database.source.query("SELECT id,version,balance::text FROM wallets WHERE id=$1", [target.id]);
    const queried = await request<TransactionResult & { money: MoneyView }>(`/wagering/transactions/${submitted.body.transactionId}`);
    const provider = await request<TransactionResult>(`/providers/${command.providerId}/wagering/transactions/${command.externalTransactionId}`);
    expect(queried.response.status).toBe(200);
    expect(provider.body.transactionId).toBe(submitted.body.transactionId);
    expect(queried.body.money).toEqual(command.money);
    expect(typeof queried.body.balance.amount).toBe("string");
    const reconciliation = await post<ReconciliationView>(`/wallets/${target.id}/reconciliation`, {});
    expect(reconciliation.response.status).toBe(200);
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.storedBalance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(reconciliation.body.calculatedBalance).toEqual(reconciliation.body.storedBalance);
    expect(reconciliation.body.difference.amount).toBe("0.00");
    expect(reconciliation.body.checkedEntries).toBe(2);
    expect(await database.source.query("SELECT id,version,balance::text FROM wallets WHERE id=$1", [target.id])).toEqual(before);
  });

  test("propaga correlationId e expõe métricas em formato Prometheus", async () => {
    const target = await wallet();
    const command = commandFor(target);
    const correlation = `http-${randomUUID()}`;
    const result = await request<TransactionResult>("/wagering/transactions", { method: "POST", headers: {
      "Content-Type": "application/json", "Idempotency-Key": randomUUID(), "X-Correlation-Id": correlation,
    }, body: JSON.stringify(command) });
    expect(result.response.headers.get("x-correlation-id")).toBe(correlation);
    const metrics = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const text = await metrics.text();
    expect(text).toContain("jungle_transactions_total");
    expect(text).toContain("jungle_processing_duration_seconds");
    expect(text).toContain("jungle_outbox_current_lag_seconds");
  });

  test("SQS realmente indisponível causa readiness503 e mantém liveness200", async () => {
    const dead = new SqsGateway({ endpoint: "http://127.0.0.1:1", region: "us-east-1" });
    // Keep valid real queue identities, but route requests to a closed TCP endpoint.
    dead.commandQueueUrl = gateway.commandQueueUrl;
    dead.eventQueueUrl = gateway.eventQueueUrl;
    dead.dlqUrl = gateway.dlqUrl;
    const telemetry = new Telemetry(true);
    const isolatedApp = await createApplication(database, new WagerService(database, telemetry), dead, telemetry);
    try {
      await isolatedApp.listen(0, "127.0.0.1");
      const origin = await isolatedApp.getUrl();
      const live = await request<{ status: string }>("/health/live", undefined, origin);
      expect(live.response.status).toBe(200);
      const ready = await request<ErrorView>("/health/ready", undefined, origin);
      expect(ready.response.status).toBe(503);
      expect(ready.body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(ready.body.retryable).toBe(true);
    } finally {
      await isolatedApp.close();
      dead.destroy();
    }
  }, 15_000);
});
