import { randomUUID } from "node:crypto";
import { availableParallelism, arch, platform, release, totalmem } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { identityToken } from "./lib/oidc.ts";
import { identityResultsMatch, planLoadEffects } from "./lib/load-oracle.ts";

type Mode = "independent" | "hot" | "duplicates";
interface Wallet { id: string; playerId: string }
interface Command { providerId: string; externalTransactionId: string; walletId: string; playerId: string;
  roundId: string; gameId: string; kind: "BET"; money: { amount: string; currency: "BRL" } }
interface Result { transactionId: string; status: string; idempotentReplay: boolean }
interface Reconciliation { walletId: string; consistent: boolean; storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string }; difference: { amount: string; currency: string } }

function bounded(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
function endpoint(raw: string): string {
  const url = new URL(raw);
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "api1", "api2", "api3"]);
  if (!localHosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Load targets must be loopback or the challenge's api1/api2/api3 Docker services, without credentials or a path.");
  }
  return url.origin;
}
function decimal(cents: bigint): string {
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
}

const requestCount = bounded("LOAD_REQUESTS", 200, 1, 10_000);
const concurrency = bounded("LOAD_CONCURRENCY", 12, 1, 100);
const requestedWallets = bounded("LOAD_WALLETS", 4, 1, 32);
const maximumDurationMs = bounded("LOAD_MAX_DURATION_MS", 120_000, 1_000, 120_000);
const mode = process.env.LOAD_MODE ?? "independent";
if (!["independent", "hot", "duplicates"].includes(mode)) throw new Error("LOAD_MODE must be independent, hot or duplicates.");
const workloadMode = mode as Mode;
const urls = [...new Set((process.env.LOAD_URLS ?? "http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:3002")
  .split(",").map(value => endpoint(value.trim())))];
if (!urls.length || urls.length > 16) throw new Error("Use one to sixteen local API URLs.");
const runId = randomUUID();
const token = await identityToken("admin-a");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function request(base: string, path: string, method = "GET", body?: unknown, key?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
}
for (const base of urls) {
  const health = await request(base, "/health/ready");
  if (health.status !== 200) throw new Error(`Target is not ready (${health.status}).`);
}

async function metrics(): Promise<{ available: boolean; lockConflicts: number; outboxLagSeconds: number | null }> {
  let lockConflicts = 0;
  let outboxLagSeconds: number | null = null;
  let available = true;
  for (const base of urls) {
    try {
      const response = await request(base, "/metrics");
      if (!response.ok) { available = false; continue; }
      const text = await response.text();
      const conflicts = /^jungle_lock_conflicts_total (\S+)$/m.exec(text);
      const lag = /^jungle_outbox_current_lag_seconds (\S+)$/m.exec(text);
      const parsedConflicts = conflicts ? Number(conflicts[1]) : NaN;
      const parsedLag = lag ? Number(lag[1]) : NaN;
      if (!Number.isFinite(parsedConflicts) || !Number.isFinite(parsedLag)) available = false;
      if (Number.isFinite(parsedConflicts)) lockConflicts += parsedConflicts;
      if (Number.isFinite(parsedLag)) outboxLagSeconds = Math.max(outboxLagSeconds ?? 0, parsedLag);
    } catch { available = false; }
  }
  return { available, lockConflicts, outboxLagSeconds };
}

const openingCents = BigInt(requestCount) + 1n;
const wallets: Wallet[] = [];
for (let index = 0; index < (workloadMode === "independent" ? requestedWallets : 1); index += 1) {
  const response = await request(urls[index % urls.length]!, "/wallets", "POST", {
    playerId: randomUUID(), initialBalance: { amount: decimal(openingCents), currency: "BRL" },
  });
  if (response.status !== 201) throw new Error(`Load wallet creation failed (${response.status}).`);
  wallets.push(await response.json() as Wallet);
}
function command(index: number): Command {
  const target = wallets[index % wallets.length]!;
  return { providerId: "provider-a", externalTransactionId: `load-${runId}-${index}`, walletId: target.id,
    playerId: target.playerId, roundId: `load-round-${runId}-${index}`, gameId: "local-load-experiment",
    kind: "BET", money: { amount: "0.01", currency: "BRL" } };
}
const duplicate = command(0);
const commands = Array.from({ length: requestCount }, (_, index) => workloadMode === "duplicates" ? duplicate : command(index));
const plan = planLoadEffects(commands);
const before = await metrics();
const elapsed: number[] = [];
const statusCodes = new Map<string, number>();
const uniqueProcessed = new Map<string, string>();
let replays = 0;
let errors = 0;
let rejected = 0;
let responseFailures = 0;
let next = 0;
let completed = 0;
const startedAt = new Date().toISOString();
const start = performance.now();

await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
  for (;;) {
    if (performance.now() - start >= maximumDurationMs) return;
    const index = next;
    next += 1;
    if (index >= commands.length) return;
    const input = commands[index]!;
    const began = performance.now();
    let responseReceived = false;
    try {
      const response = await request(urls[index % urls.length]!, "/wagering/transactions", "POST", input,
        `${input.providerId}:${input.externalTransactionId}`);
      responseReceived = true;
      statusCodes.set(String(response.status), (statusCodes.get(String(response.status)) ?? 0) + 1);
      const result = await response.json() as Partial<Result>;
      if (response.status === 200 && result.status === "PROCESSED" && typeof result.transactionId === "string" &&
        typeof result.idempotentReplay === "boolean") {
        uniqueProcessed.set(result.transactionId, input.walletId);
        if (result.idempotentReplay) replays += 1;
      } else {
        errors += 1;
        if (response.status === 422) rejected += 1;
      }
    } catch {
      errors += 1;
      if (responseReceived) responseFailures += 1;
      else statusCodes.set("transport_error", (statusCodes.get("transport_error") ?? 0) + 1);
    } finally {
      elapsed.push(performance.now() - began);
      completed += 1;
    }
  }
}));

const durationSeconds = (performance.now() - start) / 1000;
const after = await metrics();
const identityChecksPassed = errors === 0 && completed === requestCount
  ? identityResultsMatch(plan, uniqueProcessed.size, replays) : null;
const reconciliations: Array<Reconciliation & { expectedBalance: string | null; expectedBalanceMatches: boolean | null }> = [];
for (const target of wallets) {
  const response = await request(urls[0]!, `/wallets/${target.id}/reconciliation`, "POST", {});
  if (response.status !== 200) throw new Error(`Final reconciliation failed (${response.status}).`);
  const row = await response.json() as Reconciliation;
  // Exact expected balances are asserted only for complete, error-free runs.
  const effects = plan.effectsByWallet.get(target.id) ?? 0;
  const expectedBalance = errors === 0 && completed === requestCount ? decimal(openingCents - BigInt(effects)) : null;
  reconciliations.push({ ...row, expectedBalance, expectedBalanceMatches: expectedBalance === null ? null :
    row.storedBalance.amount === expectedBalance && row.calculatedBalance.amount === expectedBalance &&
    row.storedBalance.currency === "BRL" && row.calculatedBalance.currency === "BRL" });
}
const report = {
  runId, startedAt, finishedAt: new Date().toISOString(),
  environment: { client: { bun: Bun.version, nodeCompatibility: process.versions.node, platform: platform(), release: release(),
    architecture: arch(), availableParallelism: availableParallelism(), reportedSystemMemoryBytes: totalmem() },
    targets: urls, targetConfiguration: (process.env.LOAD_ENVIRONMENT ?? "Not supplied; server limits must be recorded separately.").slice(0, 500) },
  methodology: { mode: workloadMode, warmup: "readiness, wallet setup and metrics collection; no measured request warmup",
    requestCount, completed, concurrency, wallets: wallets.length, maximumDurationMs,
    currency: "BRL", operationAmount: "0.01", percentileMethod: "nearest rank over all completed requests including errors",
    retriesDuringMeasurement: false, preservedFinancialTestRecords: true },
  measured: { durationSeconds, throughputRequestsPerSecond: completed / durationSeconds,
    latencyMilliseconds: { p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95), p99: percentile(elapsed, 0.99),
      maximum: elapsed.length ? Math.max(...elapsed) : null },
    errorRate: completed ? errors / completed : null, errors, financialRejections: rejected, responseFailures,
    statusCodes: Object.fromEntries(statusCodes), uniqueProcessedTransactions: uniqueProcessed.size, idempotentReplays: replays,
    lockConflictsDelta: before.available && after.available && after.lockConflicts >= before.lockConflicts ? after.lockConflicts - before.lockConflicts : null,
    metricsCounterResetObserved: before.available && after.available && after.lockConflicts < before.lockConflicts,
    outboxLagSecondsBefore: before.outboxLagSeconds, outboxLagSecondsAfter: after.outboxLagSeconds,
    metricsAvailable: before.available && after.available },
  reconciliations,
  identityValidation: { logicalOperationsExpected: plan.logicalOperationCount, replaysExpected: plan.expectedReplays, passed: identityChecksPassed },
  limits: ["Finite local experiment, not a production capacity claim.",
    "Scheduling stops at the duration budget; in-flight requests may drain for up to 30 seconds.",
    "Latency includes client, HTTP, authentication, locks, PostgreSQL and response overhead.",
    "Lock-conflict counter measures recorded database errors, not time spent waiting for row locks.",
    "Outbox lag is global to the shared database, not restricted to this run.",
    "Exact expected balances are checked only for complete, error-free runs; ledger reconciliation always runs."],
};
await mkdir(".artifacts/load", { recursive: true });
const output = `.artifacts/load/${runId}.json`;
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: output, completed, requests: requestCount, errors,
  throughputRequestsPerSecond: report.measured.throughputRequestsPerSecond,
  latencyMilliseconds: report.measured.latencyMilliseconds, consistent: reconciliations.every(row => row.consistent), identityChecksPassed }, null, 2));
if (errors || completed !== requestCount || identityChecksPassed !== true || reconciliations.some(row => !row.consistent || row.expectedBalanceMatches === false)) process.exitCode = 1;
