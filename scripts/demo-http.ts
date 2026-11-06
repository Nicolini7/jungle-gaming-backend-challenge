import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { strict as assert } from "node:assert";
import type { WagerService, TransactionResult } from "../src/application/wager-service.ts";
import type { WagerInput } from "../src/application/contracts.ts";
import { identityToken } from "./lib/oidc.ts";

type WalletView = Awaited<ReturnType<WagerService["createWallet"]>>;
type ReconciliationView = Awaited<ReturnType<WagerService["reconcile"]>>;

const urls = (process.env.DEMO_URLS ?? "http://127.0.0.1:3100,http://127.0.0.1:3101,http://127.0.0.1:3102").split(",");
const accessToken = await identityToken("admin-a");
async function request<T>(path: string, body?: unknown, key?: string, instance = 0) {
  const response = await fetch(`${urls[instance % urls.length]}${path}`, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() as T };
}
function command(wallet: WalletView, amount: string): WagerInput {
  return { providerId: "provider-a", externalTransactionId: randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: randomUUID(), gameId: "demo-game", kind: "BET", money: { amount, currency: "BRL" } };
}
const { body: wallet } = await request<WalletView>("/wallets", { playerId: randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
const bet = command(wallet, "25.00");
const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => request<TransactionResult>("/wagering/transactions", bet, `demo:${bet.externalTransactionId}`, index)));
assert(responses.every((item) => item.status === 200));
assert.equal(new Set(responses.map((item) => item.body.transactionId)).size, 1);
assert.equal(responses.filter((item) => item.body.idempotentReplay === false).length, 1);
const duplicateReconciliation = (await request<ReconciliationView>(`/wallets/${wallet.id}/reconciliation`, {})).body;
assert.equal(duplicateReconciliation.consistent, true);
assert.equal(duplicateReconciliation.storedBalance.amount, "75.00");
const { body: competingWallet } = await request<WalletView>("/wallets", { playerId: randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
const competitors = [command(competingWallet, "80.00"), command(competingWallet, "80.00")];
const competingResponses = await Promise.all(competitors.map((item, index) => request<TransactionResult>("/wagering/transactions", item, `demo:${item.externalTransactionId}`, index + 1)));
assert.deepEqual(competingResponses.map((item) => item.status).sort(), [200, 422]);
const competitionReconciliation = (await request<ReconciliationView>(`/wallets/${competingWallet.id}/reconciliation`, {})).body;
assert.equal(competitionReconciliation.consistent, true);
assert.equal(competitionReconciliation.storedBalance.amount, "20.00");
const evidence = { checkedAt: new Date().toISOString(), instances: urls,
  repeatedBet: { requests: 50, uniqueTransactions: 1, replays: 49, reconciliation: duplicateReconciliation },
  competingBets: { statuses: competingResponses.map((item) => item.body.status).sort(), reconciliation: competitionReconciliation } };
await mkdir(".artifacts", { recursive: true });
await Bun.write(".artifacts/demo-http.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
