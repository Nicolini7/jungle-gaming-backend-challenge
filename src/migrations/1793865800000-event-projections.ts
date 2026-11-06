import type { MigrationInterface, QueryRunner } from "typeorm";

/** Durable event consumption and read models do not modify the financial ledger. */
export class EventProjections1793865800000 implements MigrationInterface {
  readonly name = "EventProjections1793865800000";

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE event_receipts (
        consumer_name VARCHAR(180) NOT NULL CHECK (length(consumer_name) > 0),
        event_id UUID NOT NULL REFERENCES outbox(id),
        payload_hash VARCHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        event_type VARCHAR(100) NOT NULL,
        aggregate_id UUID NOT NULL REFERENCES wallets(id),
        processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (consumer_name, event_id)
      );

      CREATE TABLE wallet_balance_projections (
        wallet_id UUID PRIMARY KEY,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC NOT NULL CHECK (jw_is_money(balance)),
        wallet_version INTEGER NOT NULL CHECK (wallet_version >= 1),
        source_event_id UUID NOT NULL REFERENCES outbox(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (wallet_id, wallet_version) REFERENCES wallet_ledger(wallet_id, wallet_version)
      );

      CREATE TABLE in_app_notifications (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        recipient_id UUID NOT NULL,
        tenant_id VARCHAR(180) NOT NULL,
        channel VARCHAR(20) NOT NULL CHECK (channel = 'in_app'),
        status VARCHAR(32) NOT NULL CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED')),
        source_event_id UUID NOT NULL REFERENCES outbox(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (transaction_id, recipient_id, channel)
      );
      CREATE INDEX notification_wallet_created ON in_app_notifications(wallet_id, created_at DESC, id DESC);

      CREATE FUNCTION jw_guard_event_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'processed event receipts are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'event_receipt_immutable';
      END $$;
      CREATE TRIGGER event_receipt_immutable BEFORE UPDATE OR DELETE ON event_receipts
        FOR EACH ROW EXECUTE FUNCTION jw_guard_event_receipt();
      CREATE TRIGGER event_receipt_no_truncate BEFORE TRUNCATE ON event_receipts
        FOR EACH STATEMENT EXECUTE FUNCTION jw_guard_event_receipt();

      CREATE FUNCTION jw_guard_balance_projection() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'balance projections cannot be deleted by mutation'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_projection_immutable_identity';
        END IF;
        IF TG_OP = 'UPDATE' AND (
          (NEW.wallet_id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.wallet_id, OLD.currency, OLD.created_at)
          OR NEW.wallet_version <= OLD.wallet_version
        ) THEN
          RAISE EXCEPTION 'balance projection identity is immutable and its version must increase'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_projection_monotonic';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger l
          WHERE l.wallet_id = NEW.wallet_id AND l.wallet_version = NEW.wallet_version
            AND l.currency = NEW.currency AND l.balance_after = NEW.balance
        ) OR NOT EXISTS (
          SELECT 1 FROM outbox o WHERE o.id = NEW.source_event_id
            AND o.aggregate_id = NEW.wallet_id AND o.event_type = 'WalletBalanceChanged'
            AND o.payload->'data'->>'walletVersion' = NEW.wallet_version::TEXT
            AND o.payload->'data'->'balanceAfter'->>'amount' = NEW.balance::TEXT
            AND o.payload->'data'->'balanceAfter'->>'currency' = NEW.currency
        ) THEN
          RAISE EXCEPTION 'balance projection must match a committed ledger snapshot and event'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_projection_committed_snapshot';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER balance_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON wallet_balance_projections
        FOR EACH ROW EXECUTE FUNCTION jw_guard_balance_projection();

      CREATE FUNCTION jw_guard_notification() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'notification identities cannot be deleted by mutation'
            USING ERRCODE = '23514', CONSTRAINT = 'notification_immutable_identity';
        END IF;
        IF TG_OP = 'UPDATE' AND (
          (NEW.id, NEW.wallet_id, NEW.transaction_id, NEW.recipient_id, NEW.tenant_id, NEW.channel, NEW.created_at)
            IS DISTINCT FROM
          (OLD.id, OLD.wallet_id, OLD.transaction_id, OLD.recipient_id, OLD.tenant_id, OLD.channel, OLD.created_at)
          OR OLD.status <> 'PENDING_REFERENCE' OR NEW.status NOT IN ('PROCESSED', 'REJECTED')
        ) THEN
          RAISE EXCEPTION 'notification identity and terminal status are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'notification_monotonic';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallets w JOIN wager_transactions t ON t.wallet_id=w.id
          JOIN outbox o ON o.id=NEW.source_event_id
          WHERE w.id=NEW.wallet_id AND w.player_id=NEW.recipient_id AND w.tenant_id=NEW.tenant_id
            AND t.id=NEW.transaction_id AND o.aggregate_id=w.id
            AND o.payload->'data'->>'transactionId'=t.id::TEXT
            AND o.payload->'data'->>'status'=NEW.status
            AND o.event_type = CASE NEW.status WHEN 'PROCESSED' THEN 'WagerTransactionProcessed'
              WHEN 'REJECTED' THEN 'WagerTransactionRejected' ELSE 'WagerTransactionPendingReference' END
        ) THEN
          RAISE EXCEPTION 'notification identity and status must match a committed event'
            USING ERRCODE = '23514', CONSTRAINT = 'notification_committed_event';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER notification_guard BEFORE INSERT OR UPDATE OR DELETE ON in_app_notifications
        FOR EACH ROW EXECUTE FUNCTION jw_guard_notification();

      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jungle_app') THEN
          GRANT SELECT, INSERT ON event_receipts, wallet_balance_projections, in_app_notifications TO jungle_app;
          GRANT UPDATE(balance, wallet_version, source_event_id, updated_at) ON wallet_balance_projections TO jungle_app;
          GRANT UPDATE(status, source_event_id, updated_at) ON in_app_notifications TO jungle_app;
        END IF;
      END $$;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP TABLE in_app_notifications;
      DROP TABLE wallet_balance_projections;
      DROP TABLE event_receipts;
      DROP FUNCTION jw_guard_notification();
      DROP FUNCTION jw_guard_balance_projection();
      DROP FUNCTION jw_guard_event_receipt();
    `);
  }
}
