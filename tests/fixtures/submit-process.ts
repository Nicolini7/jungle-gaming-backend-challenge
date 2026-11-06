import { Database } from "../../src/infrastructure/database/database.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { WagerService } from "../../src/application/wager-service.ts";
import type { WagerInput } from "../../src/application/contracts.ts";

interface BatchRequest {
  requests: { command: WagerInput; idempotencyKey: string }[];
}

let database: Database | undefined;
try {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("An explicit DATABASE_URL is required for the process fixture.");
  database = await Database.connect(databaseUrl);
  const service = new WagerService(database, new Telemetry(true));
  // Todos os processos abrem seus pools antes de a barreira receber os comandos.
  console.log(JSON.stringify({ type: "ready", pid: process.pid }));
  const batch = JSON.parse(await Bun.stdin.text()) as BatchRequest;
  const results = await Promise.all(batch.requests.map(({ command, idempotencyKey }) =>
    service.submit(command, idempotencyKey, { correlationId: `process-${process.pid}` })));
  console.log(JSON.stringify({ type: "result", pid: process.pid, results }));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Process fixture failed");
  process.exitCode = 1;
} finally {
  await database?.close();
}
