import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { WagerInput } from "../../src/application/contracts.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import { Database } from "../../src/infrastructure/database/database.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { commandFor, createTestWallet, integrationDatabaseUrl, integrationEnabled } from "../fixtures/financial-helpers.ts";

interface BatchResult {
  type: "result";
  pid: number;
  results: { transactionId: string; status: string; balance: { amount: string; currency: string }; idempotentReplay: boolean }[];
}

const fixturePath = fileURLToPath(new URL("../fixtures/submit-process.ts", import.meta.url));

describe.skipIf(!integrationEnabled)("PostgreSQL real — três processos e reinício", () => {
  let database: Database;
  let service: WagerService;
  const children = new Set<Bun.Subprocess<"pipe", "pipe", "pipe">>();

  beforeAll(async () => {
    database = await Database.connect(integrationDatabaseUrl);
    await database.migrate();
    service = new WagerService(database, new Telemetry(true));
  });

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all([...children].map(child => child.exited));
    await database?.close();
  });

  function startProcess() {
    const child = Bun.spawn([process.execPath, "run", fixturePath], {
      env: { ...process.env, DATABASE_URL: integrationDatabaseUrl, NODE_ENV: "test" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    children.add(child);
    let readyResolve: (pid: number) => void = () => {};
    let readyReject: (error: Error) => void = () => {};
    const ready = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const stderr = new Response(child.stderr).text();
    const output = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: BatchResult | undefined;
      for (;;) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as { type: string; pid: number };
          if (message.type === "ready") readyResolve(message.pid);
          if (message.type === "result") result = message as BatchResult;
        }
        if (chunk.done) break;
      }
      const code = await child.exited;
      const diagnostics = await stderr;
      if (code !== 0 || !result) throw new Error(`Independent process exited ${code}: ${diagnostics}`);
      return result;
    })();
    // Rejeitar a barreira também evita esperar 15s quando o processo falha no startup.
    void output.catch(error => readyReject(error instanceof Error ? error : new Error(String(error))));
    return {
      child,
      ready,
      result: output,
      send(commands: WagerInput[]) {
        child.stdin.write(JSON.stringify({ requests: commands.map(command => ({ command,
          idempotencyKey: `${command.providerId}:${command.externalTransactionId}` })) }));
        child.stdin.end();
      },
    };
  }

  async function runAcrossProcesses(batches: WagerInput[][]): Promise<BatchResult[]> {
    const processes = batches.map(() => startProcess());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(processes.map(process => process.ready)),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Process startup barrier timed out")), 15_000); }),
      ]);
      // A barreira libera todos somente depois que os pools independentes estão abertos.
      for (const [index, process] of processes.entries()) process.send(batches[index]!);
      return await Promise.all(processes.map(process => process.result));
    } finally {
      if (timeout) clearTimeout(timeout);
      for (const process of processes) {
        if (process.child.exitCode === null) process.child.kill();
        children.delete(process.child);
      }
      await Promise.allSettled(processes.map(process => process.result));
    }
  }

  async function consistent(walletId: string, amount: string): Promise<void> {
    const result = await service.reconcile(walletId);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe(amount);
    expect(result.calculatedBalance).toEqual(result.storedBalance);
  }

  test("50 duplicatas em três processos reais e pools independentes debitam uma única vez", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const batches = [17, 17, 16].map(count => Array.from({ length: count }, () => command));
    const processes = await runAcrossProcesses(batches);
    expect(new Set(processes.map(process => process.pid)).size).toBe(3);
    const results = processes.flatMap(process => process.results);
    expect(results).toHaveLength(50);
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every(result => result.status === "PROCESSED")).toBe(true);
    const rows = await database.source.query("SELECT id FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'", [wallet.id]);
    expect(rows).toHaveLength(1);
    await consistent(wallet.id, "75.00");
  }, 45_000);

  test("três processos disputam a mesma wallet sem saldo negativo", async () => {
    const wallet = await createTestWallet(service);
    const batches = Array.from({ length: 3 }, () => [commandFor(wallet, { money: { amount: "80.00", currency: "BRL" } })]);
    const processes = await runAcrossProcesses(batches);
    expect(new Set(processes.map(process => process.pid)).size).toBe(3);
    const results = processes.flatMap(process => process.results);
    expect(results.filter(result => result.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter(result => result.status === "REJECTED")).toHaveLength(2);
    await consistent(wallet.id, "20.00");
  }, 45_000);

  test("três processos movimentam wallets diferentes em paralelo", async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => createTestWallet(service)));
    const batches = wallets.map(wallet => Array.from({ length: 5 }, () => commandFor(wallet,
      { money: { amount: "10.00", currency: "BRL" } })));
    const processes = await runAcrossProcesses(batches);
    expect(new Set(processes.map(process => process.pid)).size).toBe(3);
    expect(processes.flatMap(process => process.results).every(result => result.status === "PROCESSED")).toBe(true);
    for (const wallet of wallets) await consistent(wallet.id, "50.00");
  }, 45_000);

  test("outro processo após reinício recupera replay e saldo pelo PostgreSQL", async () => {
    const wallet = await createTestWallet(service);
    const command = commandFor(wallet);
    const [beforeRestart] = await runAcrossProcesses([[command]]);
    const [afterRestart] = await runAcrossProcesses([[command]]);
    expect(beforeRestart!.pid).not.toBe(afterRestart!.pid);
    expect(beforeRestart!.results[0]!.idempotentReplay).toBe(false);
    expect(afterRestart!.results[0]).toEqual({ ...beforeRestart!.results[0]!, idempotentReplay: true });
    const pendingEvents = await database.source.query("SELECT id FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL", [wallet.id]);
    expect(pendingEvents.length).toBeGreaterThan(0);
    await consistent(wallet.id, "75.00");
  }, 45_000);
});
