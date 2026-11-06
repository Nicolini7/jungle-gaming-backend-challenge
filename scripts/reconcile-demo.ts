import { strict as assert } from "node:assert";
import { identityToken } from "./lib/oidc.ts";
import type { WagerService } from "../src/application/wager-service.ts";
type Reconciliation = Awaited<ReturnType<WagerService["reconcile"]>>;
const source = process.argv[2] ?? ".artifacts/containers/demo-http.json";
const evidence = await Bun.file(source).json() as { repeatedBet: { reconciliation: Reconciliation }; competingBets: { reconciliation: Reconciliation } };
const token = await identityToken("admin-a");
const base = process.env.RECONCILIATION_URL ?? "http://api1:3000";
const checked: Reconciliation[] = [];
for (const previous of [evidence.repeatedBet.reconciliation, evidence.competingBets.reconciliation]) {
  const response = await fetch(`${base}/wallets/${previous.walletId}/reconciliation`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const current = await response.json() as Reconciliation;
  assert.equal(current.consistent, true);
  assert.deepEqual(current.storedBalance, previous.storedBalance);
  assert.deepEqual(current.calculatedBalance, current.storedBalance);
  checked.push(current);
}
console.log(JSON.stringify({ restarted: true, checked }, null, 2));
