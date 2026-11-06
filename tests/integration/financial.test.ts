import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { payloadHash } from "../../src/application/contracts.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { TransactionStatus } from "../../src/domain/types.ts";
import { commandFor, createTestWallet, integrationDatabaseUrl, integrationEnabled, submitCommand } from "../fixtures/financial-helpers.ts";

describe.skipIf(!integrationEnabled)("PostgreSQL real — correção financeira e concorrência", () => {
  let database: Database;
  let secondDatabase: Database;
  let service: WagerService;
  let secondService: WagerService;

  beforeAll(async () => {
    database = await Database.connect(integrationDatabaseUrl);
    await database.migrate();
    secondDatabase = await Database.connect(integrationDatabaseUrl);
    service = new WagerService(database, new Telemetry(true));
    secondService = new WagerService(secondDatabase, new Telemetry(true));
  });

  afterAll(async () => {
    await Promise.all([database?.close(), secondDatabase?.close()]);
  });

  async function consistent(walletId: string, balance?: string): Promise<void> {
    const result = await service.reconcile(walletId);
    expect(result.consistent).toBe(true);
    expect(result.calculatedBalance).toEqual(result.storedBalance);
    if (balance) expect(result.storedBalance.amount).toBe(balance);
  }

  async function ledgerCount(walletId: string, direction?: string): Promise<number> {
    const rows = await database.source.query(`SELECT count(*)::int AS count FROM wallet_ledger
      WHERE wallet_id = $1 AND ($2::text IS NULL OR direction = $2)`, [walletId, direction ?? null]);
    return rows[0].count as number;
  }

  test("abertura positiva tem OPENING auditável; abertura zero não cria lançamento", async () => {
    const funded = await createTestWallet(service);
    const empty = await createTestWallet(service, "0.00");
    expect((await service.getWallet(funded.id)).version).toBe(1);
    expect(await ledgerCount(funded.id)).toBe(1);
    expect(await ledgerCount(empty.id)).toBe(0);
    const rows = await database.source.query("SELECT kind,status FROM wager_transactions WHERE wallet_id=$1", [funded.id]);
    expect(rows).toEqual([{ kind: "OPENING", status: "PROCESSED" }]);
    await expect(service.createWallet({ playerId: funded.playerId, initialBalance: { amount: "0.00", currency: "BRL" } }))
      .rejects.toMatchObject({ statusCode: 409 });
    await consistent(funded.id, "100.00");
    await consistent(empty.id, "0.00");
  });

  test("50 submissões paralelas em dois pools causam um único débito persistente", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      submitCommand(index % 2 ? service : secondService, command)));
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.every(result => result.status === "PROCESSED")).toBe(true);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    await consistent(wallet.id, "75.00");
  }, 30_000);

  test("duas apostas de 80 disputam 100: exatamente uma processa e a outra rejeita", async () => {
    const wallet = await createTestWallet(service);
    const first = commandFor(wallet, { money: { amount: "80.00", currency: "BRL" } });
    const second = commandFor(wallet, { money: { amount: "80.00", currency: "BRL" } });
    const results = await Promise.all([submitCommand(service, first), submitCommand(secondService, second)]);
    expect(results.map(result => result.status).sort()).toEqual([TransactionStatus.Processed, TransactionStatus.Rejected]);
    expect(results.find(result => result.status === "REJECTED")?.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    const replays = await Promise.all([submitCommand(secondService, first), submitCommand(service, second)]);
    expect(replays.every(result => result.idempotentReplay)).toBe(true);
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    await consistent(wallet.id, "20.00");
  });

  test("wallets diferentes progridem enquanto outra wallet está bloqueada", async () => {
    const hot = await createTestWallet(service);
    const independent = await createTestWallet(service);
    const runner = database.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SELECT id FROM wallets WHERE id=$1 FOR UPDATE", [hot.id]);
      const operation = submitCommand(secondService, commandFor(independent));
      const result = await Promise.race([operation,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Independent wallet blocked by unrelated lock")), 3_000))]);
      expect(result.status).toBe(TransactionStatus.Processed);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await consistent(hot.id, "100.00");
    await consistent(independent.id, "75.00");
  });

  test("replay devolve saldo original mesmo depois de outra movimentação", async () => {
    const wallet = await createTestWallet(service);
    const first = commandFor(wallet);
    const original = await submitCommand(service, first);
    await submitCommand(service, commandFor(wallet, { money: { amount: "10.00", currency: "BRL" } }));
    const replay = await submitCommand(secondService, first);
    expect(original.balance.amount).toBe("75.00");
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    await consistent(wallet.id, "65.00");
  });

  test("mesma key com payload diferente e mesma identidade externa com outra key são conflitos", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const key = `key-${randomUUID()}`;
    await submitCommand(service, command, key);
    await expect(submitCommand(secondService, { ...command, money: { amount: "26.00", currency: "BRL" } }, key))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(submitCommand(service, command, `other-${randomUUID()}`)).rejects.toMatchObject({ statusCode: 409 });
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    await consistent(wallet.id, "75.00");
  });

  test("ordem de chaves no JSON não altera hash nem transforma replay em outra cobrança", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const reordered = { ...Object.fromEntries(Object.entries(command).reverse()),
      money: { currency: command.money.currency, amount: command.money.amount } };
    expect(payloadHash(reordered)).toBe(payloadHash(command));
    const key = `${command.providerId}:${command.externalTransactionId}`;
    const original = await service.submit(command, key, { correlationId: randomUUID() });
    const replay = await secondService.submit(reordered, key, { correlationId: randomUUID() });
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    await consistent(wallet.id, "75.00");
  });

  test("mesma idempotency key disputada entre wallets diferentes tem um único vencedor", async () => {
    const wallets = await Promise.all([createTestWallet(service), createTestWallet(service)]);
    const first = commandFor(wallets[0]!);
    const second = commandFor(wallets[1]!);
    const key = `cross-wallet-${randomUUID()}`;
    const attempts = await Promise.allSettled([submitCommand(service, first, key), submitCommand(secondService, second, key)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    for (const [index, result] of attempts.entries()) {
      if (result.status === "fulfilled") {
        expect(result.value.status).toBe(TransactionStatus.Processed);
        expect(await ledgerCount(wallets[index]!.id, "DEBIT")).toBe(1);
        await consistent(wallets[index]!.id, "75.00");
      } else {
        expect(result.reason).toMatchObject({ statusCode: 409 });
        expect(await ledgerCount(wallets[index]!.id, "DEBIT")).toBe(0);
        await consistent(wallets[index]!.id, "100.00");
      }
    }
  });

  test("cursor opaco pagina ledger sem repetir entradas e pertence a uma wallet", async () => {
    const wallet = await createTestWallet(service);
    const other = await createTestWallet(service);
    for (let index = 0; index < 3; index++) {
      await submitCommand(service, commandFor(wallet, { money: { amount: "10.00", currency: "BRL" } }));
    }
    const first = await service.ledger(wallet.id, undefined, "2");
    expect(first.items.map(item => item.walletVersion)).toEqual([1, 2]);
    expect(first.nextCursor).toBeTruthy();
    // Uma nova entrada durante a navegação não desloca o cursor existente.
    await submitCommand(secondService, commandFor(wallet, { money: { amount: "10.00", currency: "BRL" } }));
    const second = await service.ledger(wallet.id, first.nextCursor!, "2");
    const third = await service.ledger(wallet.id, second.nextCursor!, "2");
    const entries = [...first.items, ...second.items, ...third.items];
    expect(entries.map(item => item.walletVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(entries.map(item => item.id)).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    await expect(service.ledger(other.id, first.nextCursor!, "2")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.ledger(wallet.id, "invalid!", "2")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.ledger(wallet.id, undefined, "0")).rejects.toMatchObject({ statusCode: 400 });
    await consistent(wallet.id, "60.00");
    await consistent(other.id, "100.00");
  });

  test("BET WIN LOSS REFUND e ROLLBACK mantêm ledger e versão coerentes", async () => {
    const wallet = await createTestWallet(service);
    const bet = commandFor(wallet);
    await submitCommand(service, bet);
    const win = commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: "WIN",
      referenceExternalTransactionId: bet.externalTransactionId, money: { amount: "10.00", currency: "BRL" } });
    await submitCommand(service, win);
    const beforeLoss = await service.getWallet(wallet.id);
    const loss = await submitCommand(service, commandFor(wallet, { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }));
    expect(loss.status).toBe(TransactionStatus.Processed);
    expect((await service.getWallet(wallet.id)).version).toBe(beforeLoss.version);
    const lossLedger = await database.source.query("SELECT id FROM wallet_ledger WHERE transaction_id=$1", [loss.transactionId]);
    expect(lossLedger).toHaveLength(0);
    await submitCommand(service, commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId }));
    await submitCommand(service, commandFor(wallet, { providerId: win.providerId, roundId: win.roundId, kind: "ROLLBACK",
      referenceExternalTransactionId: win.externalTransactionId, money: win.money }));
    expect((await service.getWallet(wallet.id)).version).toBe(5);
    expect(await ledgerCount(wallet.id)).toBe(5);
    await consistent(wallet.id, "100.00");
  });

  test("LOSS pode referenciar BET sem ledger, incremento de versão ou evento de saldo", async () => {
    const wallet = await createTestWallet(service);
    const bet = commandFor(wallet);
    await submitCommand(service, bet);
    const loss = await submitCommand(service, commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId,
      kind: "LOSS", money: { amount: "0.00", currency: "BRL" }, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(loss.status).toBe(TransactionStatus.Processed);
    expect((await service.getWallet(wallet.id)).version).toBe(2);
    expect(await ledgerCount(wallet.id)).toBe(2);
    const events = await database.source.query("SELECT event_type FROM outbox WHERE aggregate_id=$1 AND payload->'data'->>'transactionId'=$2", [wallet.id, loss.transactionId]);
    expect(events).toEqual([{ event_type: "WagerTransactionProcessed" }]);
    await consistent(wallet.id, "75.00");
  });

  test("unicidade da reversão segue o tipo: um REFUND e um ROLLBACK podem referenciar a BET", async () => {
    const wallet = await createTestWallet(service);
    const bet = commandFor(wallet);
    await submitCommand(service, bet);
    for (const kind of ["REFUND", "ROLLBACK"] as const) {
      const result = await submitCommand(service, commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId,
        kind, referenceExternalTransactionId: bet.externalTransactionId }));
      expect(result.status).toBe(TransactionStatus.Processed);
    }
    expect(await ledgerCount(wallet.id, "CREDIT")).toBe(3);
    await consistent(wallet.id, "125.00");
  });

  test("duas reversões REFUND concorrentes da mesma BET geram somente um crédito", async () => {
    const wallet = await createTestWallet(service);
    const bet = commandFor(wallet);
    await submitCommand(service, bet);
    const refunds = [commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId }),
    commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId })];
    const results = await Promise.all(refunds.map((command, index) => submitCommand(index ? secondService : service, command)));
    expect(results.map(result => result.status).sort()).toEqual([TransactionStatus.Processed, TransactionStatus.Rejected]);
    expect(await ledgerCount(wallet.id, "CREDIT")).toBe(2); // abertura + um refund
    await consistent(wallet.id, "100.00");
  });

  test("referência em wallet ou rodada errada e reversão parcial são rejeitadas sem ledger", async () => {
    const owner = await createTestWallet(service);
    const other = await createTestWallet(service);
    const bet = commandFor(owner);
    await submitCommand(service, bet);
    const wrongWallet = await submitCommand(service, commandFor(other, { providerId: bet.providerId,
      roundId: bet.roundId, kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId }));
    const wrongRound = await submitCommand(service, commandFor(owner, { providerId: bet.providerId,
      kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId }));
    const partial = await submitCommand(service, commandFor(owner, { providerId: bet.providerId, roundId: bet.roundId,
      kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId, money: { amount: "10.00", currency: "BRL" } }));
    for (const rejected of [wrongWallet, wrongRound, partial]) {
      expect(rejected.status).toBe(TransactionStatus.Rejected);
      expect(rejected.failureCode).toBeTruthy();
      expect(await database.source.query("SELECT id FROM wallet_ledger WHERE transaction_id=$1", [rejected.transactionId])).toHaveLength(0);
    }
    expect(partial.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
    await consistent(owner.id, "75.00");
    await consistent(other.id, "100.00");
  });

  test("player e moeda divergentes da wallet são rejeições financeiras persistidas", async () => {
    const wallet = await createTestWallet(service);
    const wrongPlayer = await submitCommand(service, commandFor(wallet, { playerId: randomUUID() }));
    const wrongCurrency = await submitCommand(service, commandFor(wallet, { money: { amount: "25.00", currency: "USD" } }));
    expect(wrongPlayer.status).toBe(TransactionStatus.Rejected);
    expect(wrongPlayer.failureCode).toBe("PLAYER_MISMATCH");
    expect(wrongCurrency.status).toBe(TransactionStatus.Rejected);
    expect(wrongCurrency.failureCode).toBe("CURRENCY_MISMATCH");
    expect(await ledgerCount(wallet.id)).toBe(1);
    await consistent(wallet.id, "100.00");
  });

  test.each(["REFUND", "ROLLBACK"] as const)("%s antes da referência persiste e processa depois", async (kind) => {
    const wallet = await createTestWallet(service);
    const fast = new WagerService(database, new Telemetry(true), { referenceBaseDelayMs: 1 });
    const bet = commandFor(wallet);
    const reversal = commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind,
      referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submitCommand(fast, reversal);
    expect(pending.status).toBe(TransactionStatus.PendingReference);
    await consistent(wallet.id, "100.00");
    await submitCommand(secondService, bet);
    await database.source.query("UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [pending.transactionId]);
    await fast.retryPending();
    expect((await service.getTransaction(pending.transactionId)).status).toBe(TransactionStatus.Processed);
    expect((await submitCommand(service, reversal)).idempotentReplay).toBe(true);
    await consistent(wallet.id, "100.00");
  });

  test("referência inexistente expira com rejeição auditável e evento", async () => {
    const wallet = await createTestWallet(service);
    const fast = new WagerService(database, new Telemetry(true), { referenceMaxAttempts: 1, referenceBaseDelayMs: 1, referenceTtlMs: 60_000 });
    const reversal = commandFor(wallet, { kind: "REFUND", referenceExternalTransactionId: "never-arrives" });
    const pending = await submitCommand(fast, reversal);
    await database.source.query("UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [pending.transactionId]);
    await fast.retryPending();
    const terminal = await service.getTransaction(pending.transactionId);
    expect(terminal.status).toBe(TransactionStatus.Rejected);
    expect(terminal.failureCode).toBeTruthy();
    const events = await database.source.query("SELECT id FROM outbox WHERE aggregate_id=$1 AND event_type='WagerTransactionRejected'", [wallet.id]);
    expect(events).toHaveLength(1);
    await consistent(wallet.id, "100.00");
  });

  test("referência que chegou no último retry é processada antes de aplicar limite de tentativas", async () => {
    const wallet = await createTestWallet(service);
    const fast = new WagerService(database, new Telemetry(true), { referenceMaxAttempts: 1, referenceBaseDelayMs: 1 });
    const bet = commandFor(wallet);
    const reversal = commandFor(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submitCommand(fast, reversal);
    expect(pending.status).toBe(TransactionStatus.PendingReference);
    await submitCommand(service, bet);
    await database.source.query("UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1 AND status='PENDING_REFERENCE'", [pending.transactionId]);
    await fast.retryPending();
    const terminal = await service.getTransaction(pending.transactionId);
    expect(terminal.status).toBe(TransactionStatus.Processed);
    expect(terminal.failureCode).toBeUndefined();
    await consistent(wallet.id, "100.00");
  });

  test("rollback de crédito já gasto é rejeitado com código diferente da BET sem saldo", async () => {
    const wallet = await createTestWallet(service, "0.00");
    const win = commandFor(wallet, { kind: "WIN", money: { amount: "25.00", currency: "BRL" } });
    await submitCommand(service, win);
    await submitCommand(service, commandFor(wallet));
    const rejectedBet = await submitCommand(service, commandFor(wallet));
    const rejectedRollback = await submitCommand(service, commandFor(wallet, { providerId: win.providerId, roundId: win.roundId,
      kind: "ROLLBACK", referenceExternalTransactionId: win.externalTransactionId, money: win.money }));
    expect(rejectedRollback.status).toBe(TransactionStatus.Rejected);
    expect(rejectedRollback.failureCode).toBeTruthy();
    expect(rejectedRollback.failureCode).not.toBe(rejectedBet.failureCode);
    expect(await ledgerCount(wallet.id)).toBe(2);
    await consistent(wallet.id, "0.00");
  });

  test("inbox e redelivery conservam identidade, hash e um único débito", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const key = `${command.providerId}:${command.externalTransactionId}`;
    const context = { correlationId: randomUUID(), inbox: { consumerName: "integration-consumer", messageId: randomUUID(), payloadHash: payloadHash(command) } };
    const original = await service.submit(command, key, context);
    const redelivered = await secondService.submit(command, key, context);
    expect(redelivered.transactionId).toBe(original.transactionId);
    expect(redelivered.idempotentReplay).toBe(true);
    const rows = await database.source.query("SELECT transaction_id,processed_at FROM inbox WHERE consumer_name=$1 AND message_id=$2",
      [context.inbox.consumerName, context.inbox.messageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_id).toBe(original.transactionId);
    expect(rows[0].processed_at).not.toBeNull();
    await expect(secondService.submit(command, key, { ...context, inbox: { ...context.inbox, payloadHash: "a".repeat(64) } }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await ledgerCount(wallet.id, "DEBIT")).toBe(1);
    await consistent(wallet.id, "75.00");
  });

  test("falha SQL ao gravar outbox desfaz saldo, operação, ledger e inbox juntos", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const key = `${command.providerId}:${command.externalTransactionId}`;
    const context = { correlationId: randomUUID(), inbox: { consumerName: "atomicity-test", messageId: randomUUID(), payloadHash: payloadHash(command) } };
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_fail_outbox_${suffix}`;
    const triggerName = `test_outbox_failure_${suffix}`;
    const beforeOutbox = await database.source.query("SELECT count(*)::int AS count FROM outbox WHERE aggregate_id=$1", [wallet.id]);
    await database.source.query(`CREATE FUNCTION ${functionName}() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.aggregate_id = '${wallet.id}'::uuid THEN
          RAISE EXCEPTION 'intentional integration failure' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$`);
    try {
      await database.source.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(service.submit(command, key, context)).rejects.toBeDefined();
    } finally {
      await database.source.query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox`);
      await database.source.query(`DROP FUNCTION ${functionName}()`);
    }
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await database.source.query("SELECT id FROM wager_transactions WHERE idempotency_key=$1", [key])).toHaveLength(0);
    expect(await database.source.query("SELECT message_id FROM inbox WHERE consumer_name=$1 AND message_id=$2",
      [context.inbox.consumerName, context.inbox.messageId])).toHaveLength(0);
    const afterOutbox = await database.source.query("SELECT count(*)::int AS count FROM outbox WHERE aggregate_id=$1", [wallet.id]);
    expect(afterOutbox).toEqual(beforeOutbox);
    await consistent(wallet.id, "100.00");
    expect((await service.submit(command, key, context)).status).toBe(TransactionStatus.Processed);
    await consistent(wallet.id, "75.00");
  });
});
