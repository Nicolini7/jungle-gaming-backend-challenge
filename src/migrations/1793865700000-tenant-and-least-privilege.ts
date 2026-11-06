import type { MigrationInterface, QueryRunner } from "typeorm";

/** Preserve existing financial history while adding immutable ownership and a limited app role. */
export class TenantAndLeastPrivilege1793865700000 implements MigrationInterface {
  readonly name = "TenantAndLeastPrivilege1793865700000";

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE wallets ADD COLUMN tenant_id VARCHAR(180) NOT NULL DEFAULT '__internal__';
      ALTER TABLE wallets ADD CONSTRAINT wallets_tenant_identity CHECK (
        tenant_id = '__internal__' OR tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$'
      );
      CREATE INDEX wallets_tenant_id ON wallets(tenant_id, id);

      CREATE OR REPLACE FUNCTION jw_guard_wallet() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets are audit records and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_audit_immutable';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.tenant_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.tenant_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity and tenant are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_identity_immutable';
        END IF;
        IF (NEW.balance IS DISTINCT FROM OLD.balance AND NEW.version <> OLD.version + 1)
           OR (NEW.balance IS NOT DISTINCT FROM OLD.balance AND NEW.version <> OLD.version) THEN
          RAISE EXCEPTION 'wallet version must change exactly once per balance change'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_version_tracks_balance';
        END IF;
        RETURN NEW;
      END $$;

      -- DDL ownership belongs to the migrator. New roles cannot create shadow objects.
      DO $$
      BEGIN
        EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', current_schema());
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jungle_app') THEN
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO jungle_app', current_database());
          EXECUTE format('GRANT USAGE ON SCHEMA %I TO jungle_app', current_schema());
          EXECUTE format('REVOKE ALL ON SCHEMA %I FROM jungle_app', current_schema());
          EXECUTE format('GRANT USAGE ON SCHEMA %I TO jungle_app', current_schema());
          REVOKE ALL ON wallets, wager_transactions, wallet_ledger, inbox, outbox FROM jungle_app;
          REVOKE UPDATE(id, player_id, tenant_id, currency, balance, version, created_at, updated_at)
            ON wallets FROM jungle_app;
          GRANT SELECT, INSERT ON wallets, wager_transactions, wallet_ledger, inbox, outbox TO jungle_app;
          GRANT UPDATE(balance, version, updated_at) ON wallets TO jungle_app;
          GRANT UPDATE(status, reference_transaction_id, failure_code, balance_after, processed_at,
                       reference_attempts, next_attempt_at) ON wager_transactions TO jungle_app;
          GRANT UPDATE(attempts, next_attempt_at, published_at) ON outbox TO jungle_app;
          GRANT EXECUTE ON FUNCTION jw_is_money(NUMERIC), jw_assert_wallet_consistency(UUID) TO jungle_app;
        END IF;
      END $$;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Rollback never restores public CREATE/TEMP or grants schema ownership to the app.
    await runner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jungle_app') THEN
          REVOKE ALL ON wallets, wager_transactions, wallet_ledger, inbox, outbox FROM jungle_app;
          REVOKE UPDATE(balance, version, updated_at) ON wallets FROM jungle_app;
          REVOKE UPDATE(status, reference_transaction_id, failure_code, balance_after, processed_at,
                        reference_attempts, next_attempt_at) ON wager_transactions FROM jungle_app;
          REVOKE UPDATE(attempts, next_attempt_at, published_at) ON outbox FROM jungle_app;
        END IF;
      END $$;
      DROP INDEX wallets_tenant_id;
      ALTER TABLE wallets DROP COLUMN tenant_id;
      CREATE OR REPLACE FUNCTION jw_guard_wallet() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets are audit records and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_audit_immutable';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_identity_immutable';
        END IF;
        IF (NEW.balance IS DISTINCT FROM OLD.balance AND NEW.version <> OLD.version + 1)
           OR (NEW.balance IS NOT DISTINCT FROM OLD.balance AND NEW.version <> OLD.version) THEN
          RAISE EXCEPTION 'wallet version must change exactly once per balance change'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_version_tracks_balance';
        END IF;
        RETURN NEW;
      END $$;
    `);
  }
}
