import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerService } from "../../src/application/wager-service.ts";
import type { TransactionResult } from "../../src/application/wager-service.ts";
import type { WagerInput } from "../../src/application/contracts.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { integrationDatabaseUrl, integrationEnabled } from "../fixtures/financial-helpers.ts";

const currencies = ["BRL", "USD", "EUR"] as const;
const maximum = 99_999_999_999_999_999_999n;
type Currency = typeof currencies[number];
interface Wallet { id: string; playerId: string; expectedCurrency: Currency }

// Independent oracle: decimal strings are converted through integer arithmetic only.
function decimal(value: bigint): string {
  const digits = value.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function cents(value: string): bigint {
  const [whole, fraction] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction!);
}
function seeded(seed: bigint): () => bigint {
  let state = seed;
  return () => { state = (state * 1_664_525n + 1_013_904_223n) & 0xffff_ffffn; return state; };
}

describe.skipIf(!integrationEnabled)("Enhanced finite financial matrix with real PostgreSQL", () => {
  let owner: Database;
  let first: Database;
  let second: Database;
  let service: WagerService;
  let other: WagerService;

  beforeAll(async () => {
    owner = await Database.connect(integrationDatabaseUrl);
    await owner.migrate();
    const applicationUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!applicationUrl) throw new Error("Application database URL required for the enhanced matrix.");
    first = await Database.connectApplication(applicationUrl);
    second = await Database.connectApplication(applicationUrl);
    service = new WagerService(first, new Telemetry(true));
    other = new WagerService(second, new Telemetry(true));
  }, 60_000);

  afterAll(async () => { await Promise.all([owner?.close(), first?.close(), second?.close()]); });

  async function wallet(currency: Currency, balance: bigint = 10_000n): Promise<Wallet> {
    const created = await service.createWallet({ playerId: randomUUID(), initialBalance: { amount: decimal(balance), currency } });
    return { ...created, expectedCurrency: currency };
  }
  function command(target: Wallet, currency: Currency, overrides: Partial<WagerInput> = {}): WagerInput {
    return { providerId: `matrix-${randomUUID()}`, externalTransactionId: randomUUID(),
      walletId: target.id, playerId: target.playerId, roundId: randomUUID(), gameId: "matrix-game",
      kind: "BET", money: { amount: "25.00", currency }, ...overrides };
  }
  function submit(input: WagerInput, useOther = false, key = `${input.providerId}:${input.externalTransactionId}`): Promise<TransactionResult> {
    return (useOther ? other : service).submit(input, key, { correlationId: randomUUID() });
  }
  function reversal(target: Wallet, currency: Currency, reference: WagerInput, kind: "REFUND" | "ROLLBACK", overrides: Partial<WagerInput> = {}): WagerInput {
    return command(target, currency, { providerId: reference.providerId, roundId: reference.roundId,
      kind, money: reference.money, referenceExternalTransactionId: reference.externalTransactionId, ...overrides });
  }
  async function count(target: Wallet, direction?: string): Promise<number> {
    const [row] = await owner.source.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM wallet_ledger WHERE wallet_id=$1 AND ($2::text IS NULL OR direction=$2)", [target.id, direction ?? null]);
    return row!.count;
  }
  async function consistent(target: Wallet, expected: bigint, version?: number): Promise<void> {
    const reconciliation = await service.reconcile(target.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe(decimal(expected));
    expect(reconciliation.storedBalance.currency).toBe(target.expectedCurrency);
    expect(reconciliation.calculatedBalance).toEqual(reconciliation.storedBalance);
    expect(reconciliation.difference.amount).toBe("0.00");
    expect(reconciliation.difference.currency).toBe(target.expectedCurrency);
    if (version !== undefined) expect((await service.getWallet(target.id)).version).toBe(version);
  }

  test("one player has independent wallets per currency and cannot reverse across them", async () => {
    const playerId = randomUUID();
    const targets: Wallet[] = [];
    for (const currency of currencies) {
      const target = await service.createWallet({ playerId, initialBalance: { amount: "100.00", currency } });
      targets.push({ ...target, expectedCurrency: currency });
      await expect(service.createWallet({ playerId, initialBalance: { amount: "0.00", currency } }))
        .rejects.toMatchObject({ code: "WALLET_ALREADY_EXISTS" });
    }
    const bet = command(targets[0]!, "BRL");
    await submit(bet);
    await submit(command(targets[1]!, "USD", { kind: "WIN", money: { amount: "10.00", currency: "USD" } }));
    const crossCurrencyReference = reversal(targets[1]!, "USD", bet, "REFUND", { money: { amount: "25.00", currency: "USD" } });
    expect((await submit(crossCurrencyReference)).failureCode).toBe("REFERENCE_MISMATCH");
    await consistent(targets[0]!, 7_500n, 2);
    await consistent(targets[1]!, 11_000n, 2);
    await consistent(targets[2]!, 10_000n, 1);
  });

  for (const currency of currencies) {
    test(`${currency}: BET over six balance boundaries`, async () => {
      for (const opening of [0n, 1n, 2_499n, 2_500n, 2_501n, maximum]) {
        const target = await wallet(currency, opening);
        const input = command(target, currency);
        const result = await submit(input);
        const accepted = opening >= 2_500n;
        expect(result.status).toBe(accepted ? "PROCESSED" : "REJECTED");
        expect(result.failureCode).toBe(accepted ? undefined : "INSUFFICIENT_FUNDS");
        expect(await count(target, "DEBIT")).toBe(accepted ? 1 : 0);
        expect(await submit(input, true)).toEqual({ ...result, idempotentReplay: true });
        await consistent(target, opening - (accepted ? 2_500n : 0n), accepted ? 2 : 1);
      }
    });

    test(`${currency}: one-cent WIN at zero, exact range and overflow boundary`, async () => {
      for (const opening of [0n, 1n, 2_499n, 2_500n, maximum - 1n, maximum]) {
        const target = await wallet(currency, opening);
        const result = await submit(command(target, currency, { kind: "WIN", money: { amount: "0.01", currency } }));
        const accepted = opening < maximum;
        expect(result.status).toBe(accepted ? "PROCESSED" : "REJECTED");
        expect(result.failureCode).toBe(accepted ? undefined : "MONEY_OVERFLOW");
        expect(await count(target)).toBe((opening > 0n ? 1 : 0) + (accepted ? 1 : 0));
        await consistent(target, opening + (accepted ? 1n : 0n), accepted ? 2 : 1);
      }
    });

    test(`${currency}: LOSS preserves balance and version at every tested boundary`, async () => {
      for (const opening of [0n, 1n, 2_500n, maximum]) {
        const target = await wallet(currency, opening);
        const before = await count(target);
        const result = await submit(command(target, currency, { kind: "LOSS", money: { amount: "0.00", currency } }));
        expect(result.status).toBe("PROCESSED");
        expect(await count(target)).toBe(before);
        const events = await owner.source.query<Array<{ event_type: string }>>(
          "SELECT event_type FROM outbox WHERE payload->'data'->>'transactionId'=$1", [result.transactionId]);
        expect(events.map(row => row.event_type)).toEqual(["WagerTransactionProcessed"]);
        await consistent(target, opening, 1);
      }
    });

    test(`${currency}: all monetary kinds reject zero and LOSS rejects a nonzero value`, async () => {
      const target = await wallet(currency);
      for (const kind of ["BET", "WIN", "REFUND", "ROLLBACK"] as const) {
        await expect(submit(command(target, currency, { kind, money: { amount: "0.00", currency }, referenceExternalTransactionId: "unused" })))
          .rejects.toMatchObject({ code: "INVALID_TRANSACTION_AMOUNT" });
      }
      await expect(submit(command(target, currency, { kind: "LOSS", money: { amount: "0.01", currency } })))
        .rejects.toMatchObject({ code: "INVALID_TRANSACTION_AMOUNT" });
      for (const kind of ["REFUND", "ROLLBACK"] as const) {
        await expect(submit(command(target, currency, { kind }))).rejects.toMatchObject({ code: "REFERENCE_REQUIRED" });
      }
      expect(await count(target)).toBe(1);
      await consistent(target, 10_000n, 1);
    });

    test(`${currency}: reversal lifecycle preserves the literal per-type uniqueness rule`, async () => {
      const target = await wallet(currency);
      const bet = command(target, currency);
      await submit(bet);
      const refund = reversal(target, currency, bet, "REFUND");
      expect((await submit(refund)).status).toBe("PROCESSED");
      await consistent(target, 10_000n, 3);
      // Rolling back the refund undoes its credit; rolling back the BET is another kind.
      const undoRefund = reversal(target, currency, refund, "ROLLBACK");
      expect((await submit(undoRefund)).status).toBe("PROCESSED");
      await consistent(target, 7_500n, 4);
      const undoBet = reversal(target, currency, bet, "ROLLBACK");
      const applied = await submit(undoBet);
      expect(applied.status).toBe("PROCESSED");
      expect(await submit(undoBet, true)).toEqual({ ...applied, idempotentReplay: true });
      expect((await submit(reversal(target, currency, bet, "REFUND"))).failureCode).toBe("REFERENCE_ALREADY_REVERSED");
      expect((await submit(reversal(target, currency, bet, "ROLLBACK"))).failureCode).toBe("REFERENCE_ALREADY_REVERSED");
      await consistent(target, 10_000n, 5);
      const literal = await wallet(currency);
      const literalBet = command(literal, currency);
      await submit(literalBet);
      const bothKinds = await Promise.all([submit(reversal(literal, currency, literalBet, "REFUND")),
        submit(reversal(literal, currency, literalBet, "ROLLBACK"), true)]);
      expect(bothKinds.every(result => result.status === "PROCESSED")).toBe(true);
      await consistent(literal, 12_500n, 4);
    });

    test(`${currency}: every excluded reference kind is rejected`, async () => {
      const cases = [
        ["REFUND", "WIN"], ["REFUND", "LOSS"], ["REFUND", "REFUND"], ["REFUND", "ROLLBACK"],
        ["ROLLBACK", "LOSS"], ["ROLLBACK", "ROLLBACK"],
      ] as const;
      for (const [kind, referenceKind] of cases) {
        const target = await wallet(currency);
        let reference = command(target, currency, { kind: referenceKind === "LOSS" ? "LOSS" : "WIN",
          money: { amount: referenceKind === "LOSS" ? "0.00" : "25.00", currency } });
        if (referenceKind === "REFUND" || referenceKind === "ROLLBACK") {
          const base = command(target, currency, { kind: referenceKind === "REFUND" ? "BET" : "WIN" });
          await submit(base);
          reference = reversal(target, currency, base, referenceKind);
        }
        await submit(reference);
        const before = await service.getWallet(target.id);
        const ledgerBefore = await count(target);
        const undo = reversal(target, currency, reference, kind, { money: { amount: "25.00", currency } });
        const result = await submit(undo);
        expect(result.status).toBe("REJECTED");
        expect(result.failureCode).toBe("INVALID_REFERENCE_KIND");
        expect(await count(target)).toBe(ledgerBefore);
        await consistent(target, cents(before.balance.amount), before.version);
      }
    });

    test(`${currency}: JSON ordering preserves replay while changed payload and new key conflict`, async () => {
      const target = await wallet(currency);
      const input = command(target, currency);
      const result = await submit(input);
      const key = `${input.providerId}:${input.externalTransactionId}`;
      const reordered = Object.fromEntries(Object.entries(input).reverse());
      reordered.money = { currency, amount: input.money.amount };
      expect(await other.submit(reordered, key, { correlationId: randomUUID() })).toEqual({ ...result, idempotentReplay: true });
      await expect(submit({ ...input, money: { amount: "25.01", currency } }, true, key))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(submit(input, true, `another-${randomUUID()}`))
        .rejects.toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
      expect(await count(target, "DEBIT")).toBe(1);
      await consistent(target, 7_500n, 2);
    });

    test(`${currency}: incompatible references and partial/excess reversals have no financial effect`, async () => {
      const target = await wallet(currency);
      const another = await wallet(currency);
      const bet = command(target, currency);
      await submit(bet);
      const cases: Array<[WagerInput, string]> = [
        [reversal(another, currency, bet, "REFUND"), "REFERENCE_MISMATCH"],
        [reversal(target, currency, bet, "REFUND", { roundId: randomUUID() }), "REFERENCE_MISMATCH"],
        [reversal(target, currency, bet, "REFUND", { playerId: randomUUID() }), "PLAYER_MISMATCH"],
        [reversal(target, currency, bet, "REFUND", { money: { amount: "24.99", currency } }), "REFERENCE_AMOUNT_MISMATCH"],
        [reversal(target, currency, bet, "ROLLBACK", { money: { amount: "25.01", currency } }), "REFERENCE_AMOUNT_MISMATCH"],
        [reversal(target, currency, bet, "REFUND", { money: { amount: "25.00", currency: currency === "BRL" ? "USD" : "BRL" } }), "CURRENCY_MISMATCH"],
      ];
      for (const [input, failureCode] of cases) {
        const result = await submit(input);
        expect(result.status).toBe("REJECTED");
        expect(result.failureCode).toBe(failureCode);
      }
      expect(await count(target)).toBe(2);
      expect(await count(another)).toBe(1);
      await consistent(target, 7_500n, 2);
      await consistent(another, 10_000n, 1);
    });

    test(`${currency}: provider-scoped lookup stays pending while gameId remains a documented compatibility choice`, async () => {
      const target = await wallet(currency);
      const bet = command(target, currency);
      await submit(bet);
      const foreignProvider = reversal(target, currency, bet, "REFUND", { providerId: `matrix-${randomUUID()}` });
      const pending = await submit(foreignProvider);
      expect(pending.status).toBe("PENDING_REFERENCE");
      await consistent(target, 7_500n, 2);
      // The original rules bind provider/player/wallet/currency/round, without gameId.
      const changedGame = reversal(target, currency, bet, "REFUND", { gameId: "different-game" });
      expect((await submit(changedGame)).status).toBe("PROCESSED");
      await consistent(target, 10_000n, 3);
      // Finish this fixture through the domain API instead of leaving a global retry candidate.
      const foreignReference = command(target, currency, { providerId: foreignProvider.providerId,
        externalTransactionId: bet.externalTransactionId, roundId: bet.roundId, money: bet.money });
      expect((await submit(foreignReference)).status).toBe("PROCESSED");
      await consistent(target, 7_500n, 4);
      await owner.source.query("UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [pending.transactionId]);
      await service.retryPending(1000);
      expect((await service.getTransaction(pending.transactionId)).status).toBe("PROCESSED");
      expect((await submit(foreignProvider, true)).idempotentReplay).toBe(true);
      expect(await count(target)).toBe(5);
      await consistent(target, 10_000n, 5);
    });

    test(`${currency}: REFUND and ROLLBACK before their reference recover without another movement on replay`, async () => {
      for (const kind of ["REFUND", "ROLLBACK"] as const) {
        const target = await wallet(currency);
        const bet = command(target, currency);
        const undo = reversal(target, currency, bet, kind);
        const pending = await submit(undo);
        expect(pending.status).toBe("PENDING_REFERENCE");
        await consistent(target, 10_000n, 1);
        await submit(bet);
        await owner.source.query("UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [pending.transactionId]);
        await service.retryPending(1000);
        expect((await service.getTransaction(pending.transactionId)).status).toBe("PROCESSED");
        expect((await submit(undo, true)).idempotentReplay).toBe(true);
        expect(await count(target)).toBe(3);
        await consistent(target, 10_000n, 3);
      }
    });

    test(`${currency}: refund overflow and rollback of already-spent credit stay rejected`, async () => {
      const top = await wallet(currency, maximum);
      const bet = command(top, currency, { money: { amount: "0.01", currency } });
      await submit(bet);
      await submit(command(top, currency, { kind: "WIN", money: { amount: "0.01", currency } }));
      const overflow = await submit(reversal(top, currency, bet, "REFUND"));
      expect(overflow.status).toBe("REJECTED");
      expect(overflow.failureCode).toBe("MONEY_OVERFLOW");
      await consistent(top, maximum, 3);
      const empty = await wallet(currency, 0n);
      const win = command(empty, currency, { kind: "WIN", money: { amount: "0.01", currency } });
      await submit(win);
      await submit(command(empty, currency, { money: win.money }));
      const spent = await submit(reversal(empty, currency, win, "ROLLBACK"));
      expect(spent.status).toBe("REJECTED");
      expect(spent.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
      await consistent(empty, 0n, 3);
    });

    test(`${currency}: 48 seeded operations agree with an independent sequential oracle`, async () => {
      const target = await wallet(currency, 5_000n);
      const next = seeded(0x4a554e47n);
      let balance = 5_000n;
      let version = 1;
      const previous: Array<{ input: WagerInput; result: TransactionResult }> = [];
      for (let index = 0; index < 48; index += 1) {
        const kind = (["BET", "WIN", "LOSS"] as const)[Number(next() % 3n)]!;
        const amount = kind === "LOSS" ? 0n : next() % 5_000n + 1n;
        const input = command(target, currency, { kind, money: { amount: decimal(amount), currency } });
        const accepted = kind !== "BET" || balance >= amount;
        if (accepted && amount > 0n) { balance += kind === "BET" ? -amount : amount; version += 1; }
        const result = await submit(input, index % 2 === 1);
        expect(result.status).toBe(accepted ? "PROCESSED" : "REJECTED");
        expect(result.balance.amount).toBe(decimal(balance));
        previous.push({ input, result });
        if (index % 8 === 7) {
          const replay = previous[index - 5]!;
          expect(await submit(replay.input, true)).toEqual({ ...replay.result, idempotentReplay: true });
        }
      }
      await consistent(target, balance, version);
    }, 45_000);

    test(`${currency}: mixed concurrent commands and their duplicates preserve exactly one effect per identity`, async () => {
      const target = await wallet(currency);
      const inputs = [
        ...Array.from({ length: 20 }, () => command(target, currency, { money: { amount: "7.00", currency } })),
        ...Array.from({ length: 10 }, () => command(target, currency, { kind: "WIN", money: { amount: "3.00", currency } })),
        ...Array.from({ length: 5 }, () => command(target, currency, { kind: "LOSS", money: { amount: "0.00", currency } })),
      ];
      const paired = await Promise.all(inputs.map(async input => ({ input,
        results: await Promise.all([submit(input), submit(input, true)]) })));
      let debits = 0;
      for (const { input, results } of paired) {
        expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
        expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
        expect(results[0]!.status).toBe(results[1]!.status);
        expect(results[0]!.balance).toEqual(results[1]!.balance);
        expect(results[0]!.failureCode).toBe(results[1]!.failureCode);
        for (const result of results) expect(result.balance.currency).toBe(currency);
        const result = results[0]!;
        if (input.kind === "WIN" || input.kind === "LOSS") {
          expect(result.status).toBe("PROCESSED");
          expect(result.failureCode).toBeUndefined();
        } else if (result.status === "PROCESSED") {
          expect(result.failureCode).toBeUndefined();
          debits += 1;
        } else {
          expect(result.status).toBe("REJECTED");
          expect(result.failureCode).toBe("INSUFFICIENT_FUNDS");
          expect(cents(result.balance.amount)).toBeLessThan(700n);
        }
      }
      // Ten credits always succeed; only their ordering relative to the debits varies.
      expect(debits).toBeGreaterThanOrEqual(14);
      expect(debits).toBeLessThanOrEqual(18);
      const balance = 13_000n - BigInt(debits) * 700n;
      const movements = 10 + debits;
      expect(await count(target, "DEBIT")).toBe(debits);
      expect(await count(target)).toBe(1 + movements);
      await consistent(target, balance, 1 + movements);
    }, 45_000);

    test(`${currency}: five competing refunds and retries produce one refund credit`, async () => {
      const target = await wallet(currency);
      const bet = command(target, currency);
      await submit(bet);
      const requests = Array.from({ length: 5 }, () => reversal(target, currency, bet, "REFUND"));
      const results = await Promise.all(requests.map((input, index) => submit(input, index % 2 === 1)));
      expect(results.filter(result => result.status === "PROCESSED")).toHaveLength(1);
      expect(results.filter(result => result.failureCode === "REFERENCE_ALREADY_REVERSED")).toHaveLength(4);
      const replays = await Promise.all(requests.map((input, index) => submit(input, index % 2 === 0)));
      for (const [index, replay] of replays.entries()) expect(replay).toEqual({ ...results[index]!, idempotentReplay: true });
      expect(await count(target, "CREDIT")).toBe(2);
      await consistent(target, 10_000n, 3);
    }, 45_000);
  }
});
