import "reflect-metadata";
import { Database } from "./infrastructure/database/database.ts";
import { SqsGateway, BackgroundWorkers } from "./infrastructure/messaging/index.ts";
import { Telemetry } from "./infrastructure/telemetry.ts";
import { WagerService } from "./application/wager-service.ts";
import { createApplication } from "./infrastructure/http/application.ts";
import { identityConfiguration } from "./infrastructure/security/identity.ts";
import { TenantAccessPolicy } from "./infrastructure/security/policy.ts";
import { AuthorizedWagerProcessor } from "./infrastructure/security/authorized-processor.ts";
import { EventProjector } from "./infrastructure/notifications/event-projector.ts";
import { SqsEventConsumer } from "./infrastructure/notifications/event-consumer.ts";

const telemetry = new Telemetry();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required. Run setup first.");
if (process.env.RUN_MIGRATIONS === "true") throw new Error("Run migrations with the separate migration entrypoint.");
const identity = identityConfiguration();
const db = await Database.connectApplication(databaseUrl);
const sqs = new SqsGateway({ endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566", region: process.env.AWS_REGION ?? "us-east-1" });
await sqs.ensureQueues();
await sqs.ensureEventConsumerQueue();
const service = new WagerService(db, telemetry);
const policy = new TenantAccessPolicy(db, identity.providerTenants);
const workers = new BackgroundWorkers(db, sqs, new AuthorizedWagerProcessor(service, policy), telemetry);
const eventConsumer = new SqsEventConsumer(new EventProjector(db), sqs, telemetry);
const app = await createApplication(db, service, sqs, telemetry);
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
await app.listen(port, process.env.HOST ?? "127.0.0.1");
if (process.env.WORKERS_ENABLED !== "false") { workers.start(); eventConsumer.start(); }
telemetry.log("application_started", { port, instance: process.pid });
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  telemetry.log("shutdown_started", { signal });
  await Promise.all([workers.stop(), eventConsumer.stop()]);
  await app.close();
  sqs.destroy();
  await db.close();
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void shutdown(signal).catch(() => process.exit(1)); });
