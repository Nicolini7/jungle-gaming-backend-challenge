import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../src/application/errors.ts";
import type { WagerInput } from "../../src/application/contracts.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway.ts";
import { BackgroundWorkers, canonicalJson } from "../../src/infrastructure/messaging/background-workers.ts";
import type { WorkerProcessor } from "../../src/infrastructure/messaging/background-workers.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { commandFor, createTestWallet, integrationDatabaseUrl, integrationEnabled, submitCommand } from "../fixtures/financial-helpers.ts";

const sqsEndpoint = process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566";
const fixture = fileURLToPath(new URL("../fixtures/crash-consumer.ts", import.meta.url));

interface QueueSet {
  gateway: SqsGateway;
  commandName: string;
  eventName: string;
  dlqName: string;
}

describe.skipIf(!integrationEnabled)("PostgreSQL + SQS reais — inbox, outbox e recuperação", () => {
  let database: Database;
  let secondDatabase: Database;
  let service: WagerService;
  const queues: QueueSet[] = [];
  const children = new Set<Bun.Subprocess>();

  beforeAll(async () => {
    database = await Database.connect(integrationDatabaseUrl);
    await database.migrate();
    secondDatabase = await Database.connect(integrationDatabaseUrl);
    service = new WagerService(database, new Telemetry(true));
  });

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled([...children].map(child => child.exited));
    for (const { gateway } of queues) {
      await Promise.allSettled([gateway.commandQueueUrl, gateway.eventQueueUrl, gateway.dlqUrl]
        .map(QueueUrl => gateway.client.send(new DeleteQueueCommand({ QueueUrl }))));
      gateway.destroy();
    }
    await Promise.all([database?.close(), secondDatabase?.close()]);
  });

  async function createQueues(): Promise<QueueSet> {
    const suffix = randomUUID();
    const names = { commandName: `integration-${suffix}.fifo`, eventName: `integration-events-${suffix}.fifo`, dlqName: `integration-dlq-${suffix}.fifo` };
    const gateway = new SqsGateway({ endpoint: sqsEndpoint, region: process.env.AWS_REGION ?? "us-east-1",
      queueName: names.commandName, eventQueueName: names.eventName, dlqName: names.dlqName, visibilityTimeout: 30, maxReceives: 5 });
    await gateway.ensureQueues();
    await gateway.ready();
    const result = { ...names, gateway };
    queues.push(result);
    return result;
  }

  function envelope(command: WagerInput, messageId = randomUUID()) {
    return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...command, idempotencyKey: `${command.providerId}:${command.externalTransactionId}` } };
  }

  async function sendRaw(gateway: SqsGateway, body: string, QueueUrl = gateway.commandQueueUrl, group: string = randomUUID()): Promise<void> {
    // A unique transport deduplication ID deliberately bypasses FIFO's five-minute dedup.
    await gateway.client.send(new SendMessageCommand({ QueueUrl, MessageBody: body,
      MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
  }

  async function drain(gateway: SqsGateway, QueueUrl: string): Promise<Message[]> {
    const all: Message[] = [];
    for (let batch = 0; batch < 1000; batch++) {
      const response = await gateway.client.send(new ReceiveMessageCommand({ QueueUrl,
        MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 30 }));
      const messages = response.Messages ?? [];
      if (!messages.length) break;
      all.push(...messages);
      await Promise.all(messages.map(message => gateway.client.send(new DeleteMessageCommand({
        QueueUrl, ReceiptHandle: message.ReceiptHandle!,
      }))));
    }
    return all;
  }

  async function consistent(walletId: string, amount: string): Promise<void> {
    const reconciliation = await service.reconcile(walletId);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe(amount);
    expect(reconciliation.calculatedBalance).toEqual(reconciliation.storedBalance);
  }

  async function pendingFor(walletId: string): Promise<number> {
    const [row] = await database.source.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL", [walletId]);
    return row!.count;
  }

  async function fixtureProcess(queue: QueueSet, extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, "run", fixture], {
      env: { ...process.env, DATABASE_URL: integrationDatabaseUrl, SQS_ENDPOINT: sqsEndpoint,
        FIXTURE_COMMAND_QUEUE: queue.commandName, FIXTURE_EVENT_QUEUE: queue.eventName,
        FIXTURE_DLQ: queue.dlqName, NODE_ENV: "test", ...extra }, stdout: "pipe", stderr: "pipe",
    });
    children.add(child);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error("Worker process fixture timed out")); }, 30_000);
      })]);
      return { code, stdout: await stdout, stderr: await stderr };
    } finally {
      if (timer) clearTimeout(timer);
      children.delete(child);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }

  test("redelivery após commit e novo transporte para o mesmo pedido mantêm um débito", async () => {
    const { gateway } = await createQueues();
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const requested = envelope(command);
    let receipt = "";
    const receive = gateway.receive.bind(gateway);
    gateway.receive = async (...args) => {
      const messages = await receive(...args);
      receipt = messages[0]?.ReceiptHandle ?? receipt;
      return messages;
    };
    let failBeforeAck = true;
    const workers = new BackgroundWorkers(database, gateway, service, new Telemetry(true), {
      beforeAck: () => { if (failBeforeAck) { failBeforeAck = false; throw new Error("INJECTED_ACK_BOUNDARY_FAILURE"); } },
    });
    await sendRaw(gateway, JSON.stringify(requested));
    expect(await workers.pollOnce(0)).toBe(1);
    await consistent(wallet.id, "75.00");
    await gateway.changeVisibility(receipt, 0);
    expect(await workers.pollOnce(0)).toBe(1);
    // Even an identical envelope sent as a different physical SQS message is safe.
    await sendRaw(gateway, JSON.stringify(requested));
    expect(await workers.pollOnce(0)).toBe(1);
    // A new message identity shares the same financial request and idempotency key.
    await sendRaw(gateway, JSON.stringify(envelope(command)));
    expect(await workers.pollOnce(0)).toBe(1);
    const ledger = await database.source.query("SELECT id FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'", [wallet.id]);
    expect(ledger).toHaveLength(1);
    const inbox = await database.source.query("SELECT message_id FROM inbox WHERE transaction_id=(SELECT id FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2)", [command.providerId, command.externalTransactionId]);
    expect(inbox).toHaveLength(2);
    await consistent(wallet.id, "75.00");
  });

  test("processo morto depois do commit/antes do ack e novo processo não repetem a movimentação", async () => {
    const queue = await createQueues();
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const directory = await mkdtemp(join(tmpdir(), "jungle-crash-consumer-"));
    const marker = join(directory, "committed.json");
    try {
      await sendRaw(queue.gateway, JSON.stringify(envelope(command)));
      const crashed = await fixtureProcess(queue, { FIXTURE_CRASH: "1", FIXTURE_MARKER: marker });
      expect(crashed.code, crashed.stderr).toBe(86);
      const committed = JSON.parse(await readFile(marker, "utf8")) as { transactionId: string; receiptHandle: string; committed: boolean };
      expect(committed.committed).toBe(true);
      expect((await service.getTransaction(committed.transactionId)).status).toBe("PROCESSED");
      await queue.gateway.changeVisibility(committed.receiptHandle, 0);
      const restarted = await fixtureProcess(queue);
      expect(restarted.code, restarted.stderr).toBe(0);
      expect(restarted.stdout).toContain('"type":"consumed"');
      const debits = await database.source.query("SELECT id FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'", [wallet.id]);
      expect(debits).toHaveLength(1);
      const inbox = await database.source.query("SELECT message_id FROM inbox WHERE transaction_id=$1", [committed.transactionId]);
      expect(inbox).toHaveLength(1);
      expect((await queue.gateway.receive(0))).toHaveLength(0);
      await consistent(wallet.id, "75.00");
    } finally {
      await unlink(marker).catch(() => {});
      await rmdir(directory);
    }
  }, 45_000);

  test("shutdown aguarda mensagem em andamento, confirma após commit e interrompe o polling", async () => {
    const { gateway } = await createQueues();
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    let enteredResolve: () => void = () => {};
    let releaseResolve: () => void = () => {};
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const released = new Promise<void>(resolve => { releaseResolve = resolve; });
    const workers = new BackgroundWorkers(database, gateway, service, new Telemetry(true), {
      publishIntervalMs: 5, referenceIntervalMs: 5, pollWaitSeconds: 0, shutdownGraceMs: 5000,
      beforeAck: async () => { enteredResolve(); await released; },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    try {
      await sendRaw(gateway, JSON.stringify(envelope(command)));
      workers.start();
      await Promise.race([entered, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Consumer did not reach the post-commit ack barrier")), 5000);
      })]);
      if (timer) clearTimeout(timer);
      const stopping = workers.stop().then(() => { stopped = true; });
      await Bun.sleep(50);
      expect(stopped).toBe(false);
      // The financial commit is already durable although acknowledgement is deliberately gated.
      await consistent(wallet.id, "75.00");
      releaseResolve();
      await stopping;
      expect(stopped).toBe(true);
      expect(await gateway.receive(0)).toHaveLength(0);
      const debits = await database.source.query("SELECT id FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'", [wallet.id]);
      expect(debits).toHaveLength(1);
      await consistent(wallet.id, "75.00");
    } finally {
      if (timer) clearTimeout(timer);
      releaseResolve();
      await workers.stop();
    }
  }, 15_000);

  test("falha transitória usa backoff e volta ao caso de uso real, sem efeito duplicado", async () => {
    const { gateway } = await createQueues();
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    let receipt = "";
    const receive = gateway.receive.bind(gateway);
    gateway.receive = async (...args) => { const messages = await receive(...args); receipt = messages[0]?.ReceiptHandle ?? receipt; return messages; };
    const delays: number[] = [];
    const changeVisibility = gateway.changeVisibility.bind(gateway);
    gateway.changeVisibility = async (handle, seconds) => { delays.push(seconds); await changeVisibility(handle, seconds); };
    let attempts = 0;
    const faultProcessor: WorkerProcessor = {
      submit: async (...args) => {
        // Fault injection at the dependency boundary; the successful call uses real PG.
        if (++attempts <= 2) throw new AppError(503, "INJECTED_TRANSIENT_FAILURE");
        return service.submit(...args);
      },
      retryPending: limit => service.retryPending(limit),
    };
    const workers = new BackgroundWorkers(database, gateway, faultProcessor, new Telemetry(true));
    await sendRaw(gateway, JSON.stringify(envelope(command)));
    expect(await workers.pollOnce(0)).toBe(1);
    await consistent(wallet.id, "100.00");
    await changeVisibility(receipt, 0); // Advance broker visibility, not its receive counter.
    expect(await workers.pollOnce(0)).toBe(1);
    await changeVisibility(receipt, 0);
    expect(await workers.pollOnce(0)).toBe(1);
    expect(attempts).toBe(3);
    expect(delays).toEqual([2, 4]);
    await consistent(wallet.id, "75.00");
    expect(await drain(gateway, gateway.dlqUrl)).toHaveLength(0);
  });

  test("cinco falhas transitórias vão para DLQ sem confirmar uma operação financeira inexistente", async () => {
    const { gateway } = await createQueues();
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const requested = envelope(command);
    let receipt = "";
    const receive = gateway.receive.bind(gateway);
    gateway.receive = async (...args) => { const messages = await receive(...args); receipt = messages[0]?.ReceiptHandle ?? receipt; return messages; };
    let attempts = 0;
    const faultProcessor: WorkerProcessor = {
      submit: async () => { attempts += 1; throw new AppError(503, "INJECTED_PERSISTENT_OUTAGE"); },
      retryPending: limit => service.retryPending(limit),
    };
    const workers = new BackgroundWorkers(database, gateway, faultProcessor, new Telemetry(true));
    await sendRaw(gateway, JSON.stringify(requested));
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await workers.pollOnce(0)).toBe(1);
      if (attempt < 4) await gateway.changeVisibility(receipt, 0);
    }
    expect(attempts).toBe(5);
    const deadLetters = await drain(gateway, gateway.dlqUrl);
    expect(deadLetters).toHaveLength(1);
    const dead = JSON.parse(deadLetters[0]!.Body!) as { receiveCount: number; failureCode: string; originalBody: string };
    expect(dead.receiveCount).toBe(5);
    expect(dead.failureCode).toBe("INJECTED_PERSISTENT_OUTAGE");
    expect(dead.originalBody).toBe(JSON.stringify(requested));
    expect(await gateway.receive(0)).toHaveLength(0);
    await consistent(wallet.id, "100.00");
  });

  test("envelopes malformados e Money inválido são falhas permanentes e vão direto à DLQ", async () => {
    const { gateway } = await createQueues();
    const wallet = await createTestWallet(service);
    const requested = envelope(commandFor(wallet));
    const bodies = ["{invalid-json", JSON.stringify({ ...requested, type: "UnknownEvent" }),
      JSON.stringify({ ...requested, occurredAt: "yesterday" }),
      JSON.stringify({ ...requested, messageId: "m".repeat(256) }),
      JSON.stringify({ ...requested, correlationId: "c".repeat(181) }),
      JSON.stringify({ ...requested, data: { ...requested.data, idempotencyKey: "k".repeat(181) } }),
      JSON.stringify({ ...requested, data: { ...requested.data, money: { amount: "NaN", currency: "BRL" } } })];
    for (const body of bodies) await sendRaw(gateway, body);
    const workers = new BackgroundWorkers(database, gateway, service, new Telemetry(true));
    let consumed = 0;
    for (let round = 0; round < 10 && consumed < bodies.length; round++) consumed += await workers.pollOnce(0);
    expect(consumed).toBe(bodies.length);
    const deadLetters = await drain(gateway, gateway.dlqUrl);
    expect(deadLetters).toHaveLength(bodies.length);
    expect(deadLetters.map(message => (JSON.parse(message.Body!) as { originalBody: string }).originalBody).sort()).toEqual([...bodies].sort());
    expect(deadLetters.every(message => (JSON.parse(message.Body!) as { receiveCount: number }).receiveCount === 1)).toBe(true);
    await consistent(wallet.id, "100.00");
  });

  test("dois publishers concorrentes preservam eventos; consumidor deduplica eventId persistente", async () => {
    const { gateway } = await createQueues();
    const wallet = await createTestWallet(service);
    await Promise.all(Array.from({ length: 8 }, () => submitCommand(service, commandFor(wallet, { money: { amount: "10.00", currency: "BRL" } }))));
    const expected = await database.source.query<Array<{ id: string }>>("SELECT id FROM outbox WHERE aggregate_id=$1", [wallet.id]);
    const first = new BackgroundWorkers(database, gateway, service, new Telemetry(true), { publisherBatchSize: 3 });
    const second = new BackgroundWorkers(secondDatabase, gateway, service, new Telemetry(true), { publisherBatchSize: 3 });
    let firstCount = 0;
    let secondCount = 0;
    for (let round = 0; round < 300 && await pendingFor(wallet.id); round++) {
      const counts = await Promise.all([first.publishOnce(), second.publishOnce()]);
      firstCount += counts[0]!;
      secondCount += counts[1]!;
    }
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBeGreaterThan(0);
    expect(await pendingFor(wallet.id)).toBe(0);
    const events = (await drain(gateway, gateway.eventQueueUrl)).map(message => JSON.parse(message.Body!) as Record<string, unknown>)
      .filter(event => event.aggregateId === wallet.id);
    expect(events).toHaveLength(expected.length);
    expect(new Set(events.map(event => event.eventId))).toEqual(new Set(expected.map(row => row.id)));
    const duplicate = events.find(event => event.eventType === "WalletBalanceChanged")!;
    await sendRaw(gateway, JSON.stringify(duplicate), gateway.eventQueueUrl, wallet.id);
    await sendRaw(gateway, JSON.stringify(duplicate), gateway.eventQueueUrl, wallet.id);
    const hash = createHash("sha256").update(canonicalJson(duplicate)).digest("hex");
    let receivedDuplicates = 0;
    let inserted = 0;
    // A downstream consumer commits its persistent inbox before acknowledging either copy.
    for (let round = 0; round < 10 && receivedDuplicates < 2; round++) {
      const response = await gateway.client.send(new ReceiveMessageCommand({ QueueUrl: gateway.eventQueueUrl,
        MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 30 }));
      for (const message of response.Messages ?? []) {
        const rows = await database.transaction(em => em.query<Array<{ message_id: string }>>(`
          INSERT INTO inbox(consumer_name,message_id,payload_hash,transaction_id,received_at,processed_at)
          VALUES('integration-event-consumer-v1',$1,$2,$3,now(),now())
          ON CONFLICT(consumer_name,message_id) DO NOTHING RETURNING message_id
        `, [duplicate.eventId, hash, (duplicate.data as { transactionId: string }).transactionId]));
        inserted += rows.length;
        await gateway.client.send(new DeleteMessageCommand({ QueueUrl: gateway.eventQueueUrl, ReceiptHandle: message.ReceiptHandle! }));
        receivedDuplicates += 1;
      }
    }
    expect(receivedDuplicates).toBe(2);
    expect(inserted).toBe(1);
    await consistent(wallet.id, "20.00");
  }, 60_000);

  test("falha de publicação agenda backoff; processo novo recupera outbox confirmada com o mesmo eventId", async () => {
    const queue = await createQueues();
    const { gateway } = queue;
    const wallet = await createTestWallet(service, "0.00");
    await submitCommand(service, commandFor(wallet, { kind: "WIN" }));
    const before = await database.source.query<Array<{ id: string }>>("SELECT id FROM outbox WHERE aggregate_id=$1", [wallet.id]);
    const sendEvent = gateway.sendEvent.bind(gateway);
    gateway.sendEvent = async (payload, eventId, aggregateId) => {
      // Only this wallet sees the simulated broker outage; successful sends stay real.
      if (aggregateId === wallet.id) throw new Error("INJECTED_SQS_PUBLICATION_OUTAGE");
      await sendEvent(payload, eventId, aggregateId);
    };
    const publisher = new BackgroundWorkers(database, gateway, service, new Telemetry(true), { publisherBatchSize: 1000 });
    await publisher.publishOnce();
    const failed = await database.source.query<Array<{ attempts: number; published_at: Date | null; next_attempt_at: Date }>>(
      "SELECT attempts,published_at,next_attempt_at FROM outbox WHERE aggregate_id=$1", [wallet.id]);
    expect(failed).toHaveLength(before.length);
    expect(failed.every(row => row.attempts === 1 && row.published_at === null && row.next_attempt_at.getTime() > Date.now())).toBe(true);
    gateway.sendEvent = sendEvent;
    // Advance the scheduled retry without sleeping or changing any financial row.
    await database.source.query("UPDATE outbox SET next_attempt_at=now() WHERE aggregate_id=$1", [wallet.id]);
    const recovered = await fixtureProcess(queue, { FIXTURE_MODE: "publisher" });
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain('"type":"published"');
    expect(await pendingFor(wallet.id)).toBe(0);
    const events = (await drain(gateway, gateway.eventQueueUrl)).map(message => JSON.parse(message.Body!) as Record<string, unknown>)
      .filter(event => event.aggregateId === wallet.id);
    expect(new Set(events.map(event => event.eventId))).toEqual(new Set(before.map(row => row.id)));
    await consistent(wallet.id, "25.00");
  }, 60_000);
});
