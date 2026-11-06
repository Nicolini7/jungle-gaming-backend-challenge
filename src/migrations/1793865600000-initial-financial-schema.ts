import type { MigrationInterface, QueryRunner } from "typeorm";

/** Exact money, append-only audit and deferred cross-table financial invariants. */
export class InitialFinancialSchema1793865600000 implements MigrationInterface {
  readonly name = "InitialFinancialSchema1793865600000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION jw_is_money(value NUMERIC) RETURNS BOOLEAN
      LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
        SELECT value >= 0 AND value <= 999999999999999999.99 AND scale(value) <= 2
      $$;

      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL CHECK (currency IN ('BRL', 'USD', 'EUR')),
        balance NUMERIC NOT NULL DEFAULT 0.00 CHECK (jw_is_money(balance)),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency)
      );

      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(255) NOT NULL CHECK (length(provider_id) > 0),
        external_transaction_id VARCHAR(255) NOT NULL CHECK (length(external_transaction_id) > 0),
        idempotency_key VARCHAR(512) NOT NULL CHECK (length(idempotency_key) > 0),
        payload_hash VARCHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(255) NOT NULL CHECK (length(round_id) > 0),
        game_id VARCHAR(255) NOT NULL CHECK (length(game_id) > 0),
        kind VARCHAR(16) NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        amount NUMERIC NOT NULL CHECK (jw_is_money(amount)),
        currency VARCHAR(3) NOT NULL CHECK (currency IN ('BRL', 'USD', 'EUR')),
        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        failure_code VARCHAR(100),
        balance_after NUMERIC CHECK (jw_is_money(balance_after)),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        reference_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_attempt_at TIMESTAMPTZ,
        correlation_id VARCHAR(255) NOT NULL CHECK (length(correlation_id) > 0),
        CONSTRAINT wager_idempotency_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_id_wallet_currency_unique UNIQUE (id, wallet_id, currency),
        CONSTRAINT wager_amount_by_kind CHECK (
          (kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)
        ),
        CONSTRAINT wager_required_reference CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR
          (reference_external_transaction_id IS NOT NULL AND length(reference_external_transaction_id) > 0)
        ),
        CONSTRAINT wager_reference_identity CHECK (
          reference_external_transaction_id IS NOT NULL OR reference_transaction_id IS NULL
        ),
        CONSTRAINT wager_terminal_data CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND failure_code IS NULL AND balance_after IS NOT NULL)
          OR (status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL AND length(failure_code) > 0)
          OR (status IN ('PENDING', 'PENDING_REFERENCE') AND processed_at IS NULL AND failure_code IS NULL)
        ),
        CONSTRAINT wager_pending_reference_data CHECK (
          status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL
        )
      );

      CREATE UNIQUE INDEX wager_reversal_once_per_kind
        ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
      CREATE INDEX wager_wallet_created ON wager_transactions(wallet_id, created_at, id);
      CREATE INDEX wager_reference_due ON wager_transactions(next_attempt_at, wallet_id, id)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE wallet_ledger (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount NUMERIC NOT NULL CHECK (jw_is_money(amount) AND amount > 0),
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC NOT NULL CHECK (jw_is_money(balance_before)),
        balance_after NUMERIC NOT NULL CHECK (jw_is_money(balance_after)),
        wallet_version INTEGER NOT NULL CHECK (wallet_version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets(id, currency),
        CONSTRAINT ledger_transaction_identity_fk FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions(id, wallet_id, currency),
        CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
      CREATE INDEX ledger_wallet_cursor ON wallet_ledger(wallet_id, created_at, id);

      CREATE TABLE inbox (
        consumer_name VARCHAR(255) NOT NULL CHECK (length(consumer_name) > 0),
        message_id VARCHAR(255) NOT NULL CHECK (length(message_id) > 0),
        payload_hash VARCHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        transaction_id UUID REFERENCES wager_transactions(id),
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_processed_transaction CHECK (processed_at IS NULL OR transaction_id IS NOT NULL)
      );

      CREATE TABLE outbox (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL CHECK (length(event_type) > 0),
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMPTZ
      );
      CREATE INDEX outbox_due ON outbox(next_attempt_at, occurred_at, id) WHERE published_at IS NULL;
      CREATE INDEX outbox_aggregate ON outbox(aggregate_id, occurred_at, id);

      CREATE FUNCTION jw_guard_wallet() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
      CREATE TRIGGER wallet_guard BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION jw_guard_wallet();

      CREATE FUNCTION jw_guard_transaction() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transactions are audit records and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'wager_audit_immutable';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'terminal wager transactions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'wager_terminal_immutable';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id,
            NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id,
            NEW.created_at, NEW.correlation_id)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id,
            OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id,
            OLD.created_at, OLD.correlation_id) THEN
          RAISE EXCEPTION 'wager request payload is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'wager_payload_immutable';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid wager state transition'
            USING ERRCODE = '23514', CONSTRAINT = 'wager_status_transition';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wager_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION jw_guard_transaction();

      CREATE FUNCTION jw_block_ledger_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger is append-only'
          USING ERRCODE = '23514', CONSTRAINT = 'ledger_immutable';
      END $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger
        FOR EACH ROW EXECUTE FUNCTION jw_block_ledger_mutation();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger
        FOR EACH STATEMENT EXECUTE FUNCTION jw_block_ledger_mutation();

      CREATE FUNCTION jw_lock_ledger_wallet() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        -- Even direct SQL must serialize financial writes at wallet granularity.
        PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ledger_lock_wallet BEFORE INSERT ON wallet_ledger
        FOR EACH ROW EXECUTE FUNCTION jw_lock_ledger_wallet();

      CREATE FUNCTION jw_assert_wallet_consistency(target_wallet UUID) RETURNS VOID LANGUAGE plpgsql AS $$
      DECLARE
        w wallets%ROWTYPE;
        calculated NUMERIC;
        movement_count BIGINT;
        opening_count BIGINT;
      BEGIN
        SELECT * INTO w FROM wallets WHERE id = target_wallet FOR UPDATE;
        IF NOT FOUND THEN RETURN; END IF;

        SELECT COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00),
               COUNT(*) FILTER (WHERE t.kind <> 'OPENING'),
               COUNT(*) FILTER (WHERE t.kind = 'OPENING')
          INTO calculated, movement_count, opening_count
          FROM wallet_ledger l JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE l.wallet_id = target_wallet;

        IF w.balance <> calculated OR w.version <> 1 + movement_count OR opening_count > 1 THEN
          RAISE EXCEPTION 'wallet balance/version is inconsistent with its immutable ledger'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_consistency';
        END IF;

        IF EXISTS (
          SELECT 1 FROM (
            SELECT l.*,
              LAG(l.balance_after, 1, 0.00::NUMERIC) OVER (ORDER BY l.wallet_version) AS previous_balance,
              ROW_NUMBER() OVER (ORDER BY l.wallet_version) AS sequence_number
            FROM wallet_ledger l WHERE l.wallet_id = target_wallet
          ) chain
          WHERE chain.balance_before <> chain.previous_balance
             OR chain.wallet_version <> chain.sequence_number + CASE WHEN opening_count = 1 THEN 0 ELSE 1 END
        ) THEN
          RAISE EXCEPTION 'wallet ledger chain is inconsistent'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_chain';
        END IF;

        IF EXISTS (
          SELECT 1 FROM wager_transactions t
          LEFT JOIN wallet_ledger l ON l.transaction_id = t.id AND l.wallet_id = t.wallet_id
          LEFT JOIN wager_transactions reference ON reference.id = t.reference_transaction_id
          WHERE t.wallet_id = target_wallet AND (
            (t.status = 'PROCESSED' AND (t.player_id <> w.player_id OR t.currency <> w.currency))
            OR (t.status = 'PROCESSED' AND t.kind <> 'LOSS' AND l.id IS NULL)
            OR ((t.status <> 'PROCESSED' OR t.kind = 'LOSS') AND l.id IS NOT NULL)
            OR (l.id IS NOT NULL AND (
              l.amount <> t.amount OR l.balance_after <> t.balance_after
              OR l.direction <> CASE
                WHEN t.kind = 'BET' THEN 'DEBIT'
                WHEN t.kind = 'ROLLBACK' AND reference.kind IN ('WIN','REFUND') THEN 'DEBIT'
                ELSE 'CREDIT' END
              OR (t.kind = 'OPENING' AND l.wallet_version <> 1)
            ))
          )
        ) THEN
          RAISE EXCEPTION 'financial transaction and ledger do not match'
            USING ERRCODE = '23514', CONSTRAINT = 'transaction_ledger_consistency';
        END IF;

        IF EXISTS (
          SELECT 1 FROM wager_transactions t
          LEFT JOIN wager_transactions reference ON reference.id = t.reference_transaction_id
          WHERE t.wallet_id = target_wallet AND t.status = 'PROCESSED'
            AND (t.kind IN ('REFUND','ROLLBACK') OR t.reference_external_transaction_id IS NOT NULL)
            AND (
              reference.id IS NULL OR reference.status <> 'PROCESSED'
              OR reference.provider_id <> t.provider_id
              OR reference.external_transaction_id <> t.reference_external_transaction_id
              OR reference.player_id <> t.player_id OR reference.wallet_id <> t.wallet_id
              OR reference.currency <> t.currency OR reference.round_id <> t.round_id
              OR (t.kind IN ('REFUND','ROLLBACK') AND reference.amount <> t.amount)
              OR (t.kind IN ('REFUND','WIN','LOSS') AND reference.kind <> 'BET')
              OR (t.kind = 'ROLLBACK' AND reference.kind NOT IN ('BET','WIN','REFUND'))
              OR t.kind NOT IN ('REFUND','ROLLBACK','WIN','LOSS')
            )
        ) THEN
          RAISE EXCEPTION 'processed transaction has an invalid reference'
            USING ERRCODE = '23514', CONSTRAINT = 'transaction_reference_consistency';
        END IF;
      END $$;

      CREATE FUNCTION jw_deferred_wallet_consistency() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          PERFORM jw_assert_wallet_consistency(NEW.id);
        ELSE
          PERFORM jw_assert_wallet_consistency(NEW.wallet_id);
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jw_deferred_wallet_consistency();
      CREATE CONSTRAINT TRIGGER ledger_consistency AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jw_deferred_wallet_consistency();
      CREATE CONSTRAINT TRIGGER wager_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jw_deferred_wallet_consistency();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE outbox;
      DROP TABLE inbox;
      DROP TABLE wallet_ledger;
      DROP TABLE wager_transactions;
      DROP TABLE wallets;
      DROP FUNCTION jw_deferred_wallet_consistency();
      DROP FUNCTION jw_assert_wallet_consistency(UUID);
      DROP FUNCTION jw_lock_ledger_wallet();
      DROP FUNCTION jw_block_ledger_mutation();
      DROP FUNCTION jw_guard_transaction();
      DROP FUNCTION jw_guard_wallet();
      DROP FUNCTION jw_is_money(NUMERIC);
    `);
  }
}
