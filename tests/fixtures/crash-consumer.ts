import { writeFileSync } from "node:fs";
import { Database } from "../../src/infrastructure/database/database.ts";
import { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway.ts";
import { BackgroundWorkers } from "../../src/infrastructure/messaging/background-workers.ts";
import { Telemetry } from "../../src/infrastructure/telemetry.ts";
import { WagerService } from "../../src/application/wager-service.ts";

let database: Database | undefined;
let gateway: SqsGateway | undefined;
try {
  database = await Database.connect(process.env.DATABASE_URL!);
  gateway = new SqsGateway({
    endpoint: process.env.SQS_ENDPOINT!, region: process.env.AWS_REGION ?? "us-east-1",
    queueName: process.env.FIXTURE_COMMAND_QUEUE!, eventQueueName: process.env.FIXTURE_EVENT_QUEUE!,
    dlqName: process.env.FIXTURE_DLQ!, visibilityTimeout: 30,
  });
  await gateway.ensureQueues();
  const telemetry = new Telemetry(true);
  const service = new WagerService(database, telemetry);
  const workers = new BackgroundWorkers(database, gateway, service, telemetry, {
    publisherBatchSize: 1000,
    ...(process.env.FIXTURE_CRASH === "1" ? {
      beforeAck: async ({ message, result }) => {
        // A real process exit after submit resolves: PostgreSQL committed, SQS was not acked.
        writeFileSync(process.env.FIXTURE_MARKER!, JSON.stringify({
          transactionId: result.transactionId, receiptHandle: message.ReceiptHandle, committed: true,
        }));
        process.exit(86);
      },
    } : {}),
  });
  console.log(JSON.stringify({ type: "ready", pid: process.pid }));
  if (process.env.FIXTURE_MODE === "publisher") {
    let published = 0;
    for (let batch = 0; batch < 30; batch++) {
      const count = await workers.publishOnce();
      published += count;
      if (!count) break;
    }
    console.log(JSON.stringify({ type: "published", pid: process.pid, count: published }));
  } else {
    let count = 0;
    for (let attempt = 0; attempt < 5 && count === 0; attempt++) count = await workers.pollOnce(2);
    if (!count) throw new Error("Fixture did not receive a command.");
    console.log(JSON.stringify({ type: "consumed", pid: process.pid, count }));
  }
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Worker fixture failed");
  process.exitCode = 1;
} finally {
  gateway?.destroy();
  await database?.close();
}
