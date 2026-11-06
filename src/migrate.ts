import "reflect-metadata";
import { Database } from "./infrastructure/database/database.ts";

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required; the runtime app URL is never used for migrations.");
const db = await Database.connect(migrationUrl);
try {
  const action = process.argv[2] ?? "up";
  if (action === "up") await db.migrate();
  else if (action === "down") await db.source.undoLastMigration({ transaction: "all" });
  else throw new Error("Usage: bun run src/migrate.ts up|down");
  console.log(JSON.stringify({ event: "migration_completed", action }));
} finally { await db.close(); }
