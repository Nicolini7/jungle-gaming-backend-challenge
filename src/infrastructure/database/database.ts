import "reflect-metadata";
import { DataSource } from "typeorm";
import type { EntityManager } from "typeorm";
import { InitialFinancialSchema1793865600000 } from "../../migrations/1793865600000-initial-financial-schema.ts";
import { TenantAndLeastPrivilege1793865700000 } from "../../migrations/1793865700000-tenant-and-least-privilege.ts";
import { EventProjections1793865800000 } from "../../migrations/1793865800000-event-projections.ts";
import { schemas } from "./rows.ts";

/** One pool per process; all financial writes use the scoped transactional manager. */
export class Database {
  private constructor(public readonly source: DataSource) {}

  static async connect(url: string): Promise<Database> {
    if (typeof url !== "string" || !url.trim()) throw new Error("An explicit PostgreSQL connection URL is required.");
    const source = new DataSource({
      type: "postgres",
      url,
      entities: schemas,
      migrations: [InitialFinancialSchema1793865600000, TenantAndLeastPrivilege1793865700000, EventProjections1793865800000],
      migrationsTableName: "schema_migrations",
      synchronize: false,
      logging: false,
      extra: {
        max: 20,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 10_000,
        application_name: "jungle-wagering",
        statement_timeout: 15_000,
      },
    });
    await source.initialize();
    return new Database(source);
  }

  /** Runtime apps fail closed if accidentally configured with a migrator/owner connection. */
  static async connectApplication(url: string): Promise<Database> {
    const database = await Database.connect(url);
    try {
      const [role] = await database.source.query<Array<{
        unsafe: boolean; canCreateSchema: boolean; canCreateDatabase: boolean;
        canUseTemp: boolean; canActAsOwner: boolean; canAlterLedger: boolean;
      }>>(`
        SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS unsafe,
          has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateSchema",
          has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabase",
          has_database_privilege(current_user, current_database(), 'TEMPORARY') AS "canUseTemp",
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname IN ('wallets','wallet_ledger','wager_transactions')
                   AND pg_has_role(c.relowner, 'MEMBER')) AS "canActAsOwner",
          (has_table_privilege(current_user, 'public.wallet_ledger', 'UPDATE') OR
           has_table_privilege(current_user, 'public.wallet_ledger', 'DELETE') OR
           has_table_privilege(current_user, 'public.wallet_ledger', 'TRIGGER')) AS "canAlterLedger"
        FROM pg_roles r WHERE r.rolname=current_user
      `);
      if (!role || Object.values(role).some(Boolean)) throw new Error("Application database role must be restricted; use the dedicated migrator only for schema operations.");
      return database;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  transaction<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction("READ COMMITTED", fn);
  }

  async migrate(): Promise<void> {
    // Advisory lock serializes startup migrations across API/worker processes only.
    // Financial transactions never acquire this lock.
    const runner = this.source.createQueryRunner();
    await runner.connect();
    try {
      await runner.query("SELECT pg_advisory_lock(1793865600)");
      await this.source.runMigrations({ transaction: "all" });
    } finally {
      try {
        await runner.query("SELECT pg_advisory_unlock(1793865600)");
      } finally {
        await runner.release();
      }
    }
  }

  async close(): Promise<void> {
    if (this.source.isInitialized) await this.source.destroy();
  }
}
