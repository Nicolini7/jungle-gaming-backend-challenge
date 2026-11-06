import { strict as assert } from "node:assert";
import { identityToken } from "./lib/oidc.ts";

interface Reconciliation { walletId: string; storedBalance: { amount: string; currency: string } }
interface Card { id: string; transactionId: string; status: string }
const evidence = await Bun.file(process.argv[2] ?? ".artifacts/containers/demo-http.json").json() as {
  repeatedBet: { reconciliation: Reconciliation }; competingBets: { reconciliation: Reconciliation };
};
const urls = (process.env.EVENT_DEMO_URLS ?? "http://api1:3000,http://api2:3000,http://api3:3000").split(",");
for (const value of urls) {
  const url = new URL(value);
  if (!["api1", "api2", "api3", "127.0.0.1", "localhost"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Event demonstration URLs must address the local challenge services.");
  }
}
const token = await identityToken();
async function request<T>(url: string, path: string): Promise<{ status: number; value: T }> {
  const response = await fetch(url + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
  return { status: response.status, value: await response.json() as T };
}
const results = [];
for (const [sample, cardCount] of [[evidence.repeatedBet.reconciliation, 2], [evidence.competingBets.reconciliation, 3]] as const) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const projection = await request<{ balance: Reconciliation["storedBalance"]; walletVersion: number }>(urls[0]!, `/wallets/${sample.walletId}/balance-projection`);
    const cards = await request<{ items: Card[] }>(urls[0]!, `/wallets/${sample.walletId}/notifications`);
    if (projection.status === 200 && cards.status === 200 && cards.value.items.length === cardCount &&
      projection.value.balance.amount === sample.storedBalance.amount) break;
    assert(Date.now() < deadline, "Committed events did not reach the read models within the demonstration deadline.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const url of urls) {
    const wallet = await request<{ version: number; balance: Reconciliation["storedBalance"] }>(url, `/wallets/${sample.walletId}`);
    const projection = await request<{ balance: Reconciliation["storedBalance"]; walletVersion: number }>(url, `/wallets/${sample.walletId}/balance-projection`);
    const cards = await request<{ items: Card[] }>(url, `/wallets/${sample.walletId}/notifications`);
    assert.equal(wallet.status, 200); assert.equal(projection.status, 200); assert.equal(cards.status, 200);
    assert.deepEqual(projection.value.balance, wallet.value.balance);
    assert.equal(projection.value.walletVersion, wallet.value.version);
    assert.equal(cards.value.items.length, cardCount);
    assert.equal(new Set(cards.value.items.map(card => card.transactionId)).size, cardCount);
    assert.equal(new Set(cards.value.items.map(card => card.id)).size, cardCount);
  }
  results.push({ walletId: sample.walletId, balance: sample.storedBalance, notificationCards: cardCount, instancesChecked: urls.length });
}
console.log(JSON.stringify({ consistentReadModels: true, checked: results }, null, 2));
