import { describe, expect, test } from "bun:test";
import { identityResultsMatch, planLoadEffects } from "../../scripts/lib/load-oracle.ts";
import type { PlannedLoadCommand } from "../../scripts/lib/load-oracle.ts";

function distinct(count: number): PlannedLoadCommand[] {
  return Array.from({ length: count }, (_, index) => ({ providerId: "provider-a", externalTransactionId: `operation-${index}`,
    walletId: `wallet-${index % 4}` }));
}

describe("Load correctness oracle independent of observed transaction IDs", () => {
  test("one returned transaction ID cannot satisfy one hundred distinct planned operations", () => {
    const plan = planLoadEffects(distinct(100));
    expect(plan.logicalOperationCount).toBe(100);
    expect(plan.expectedReplays).toBe(0);
    expect(identityResultsMatch(plan, 1, 0)).toBe(false);
    expect(identityResultsMatch(plan, 1, 99)).toBe(false);
  });

  test("one hundred copies require one processed identity and ninety-nine replays", () => {
    const input = { providerId: "provider-a", externalTransactionId: "one-operation", walletId: "wallet-a" };
    const plan = planLoadEffects(Array.from({ length: 100 }, () => input));
    expect(plan.logicalOperationCount).toBe(1);
    expect(plan.expectedReplays).toBe(99);
    expect([...plan.effectsByWallet]).toEqual([["wallet-a", 1]]);
    expect(identityResultsMatch(plan, 1, 99)).toBe(true);
    expect(identityResultsMatch(plan, 100, 0)).toBe(false);
  });

  test("one hundred distinct identities require one hundred effects and no replays", () => {
    const plan = planLoadEffects(distinct(100));
    expect(identityResultsMatch(plan, 100, 0)).toBe(true);
    expect([...plan.effectsByWallet.values()]).toEqual([25, 25, 25, 25]);
    expect(identityResultsMatch(plan, 100, 1)).toBe(false);
    expect(identityResultsMatch(plan, 99, 0)).toBe(false);
  });

  test("one logical identity targeting two wallets is an invalid experiment plan", () => {
    const input = { providerId: "provider-a", externalTransactionId: "one-operation", walletId: "wallet-a" };
    expect(() => planLoadEffects([input, { ...input, walletId: "wallet-b" }])).toThrow("cannot target different wallets");
  });

  test("tuple identity distinguishes provider and external IDs containing separators", () => {
    const plan = planLoadEffects([
      { providerId: "a:b", externalTransactionId: "c", walletId: "wallet-a" },
      { providerId: "a", externalTransactionId: "b:c", walletId: "wallet-b" },
    ]);
    expect(plan.logicalOperationCount).toBe(2);
    expect([...plan.effectsByWallet]).toEqual([["wallet-a", 1], ["wallet-b", 1]]);
    expect(identityResultsMatch(plan, 2, 0)).toBe(true);
  });

  test("mixed repeated commands allocate each effect to its planned wallet once", () => {
    const a = { providerId: "provider-a", externalTransactionId: "operation-1", walletId: "wallet-a" };
    const b = { providerId: "provider-b", externalTransactionId: "operation-1", walletId: "wallet-b" };
    const c = { providerId: "provider-a", externalTransactionId: "operation-2", walletId: "wallet-a" };
    const input = [a, a, b, c, b, a] as const;
    const before = JSON.stringify(input);
    const plan = planLoadEffects(input);
    expect([...plan.effectsByWallet]).toEqual([["wallet-a", 2], ["wallet-b", 1]]);
    expect(plan.logicalOperationCount).toBe(3);
    expect(plan.expectedReplays).toBe(3);
    expect(identityResultsMatch(plan, 3, 3)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(count => [String(count), count] as const))(
    "rejects impossible observed count %s", (_name, count) => {
    const plan = planLoadEffects(distinct(1));
    expect(identityResultsMatch(plan, count, 0)).toBe(false);
    expect(identityResultsMatch(plan, 1, count)).toBe(false);
    });

  test("empty planning has no effects and accepts only empty observations", () => {
    const plan = planLoadEffects([]);
    expect(plan.effectsByWallet.size).toBe(0);
    expect(identityResultsMatch(plan, 0, 0)).toBe(true);
    expect(identityResultsMatch(plan, 1, 0)).toBe(false);
  });
});
