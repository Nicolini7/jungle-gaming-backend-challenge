#!/usr/bin/env bash
# Explicit operator upgrade for the existing challenge volume. Does not drop data or restart PG.
set -euo pipefail

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${PG_APP_PASSWORD:?PG_APP_PASSWORD is required}"
: "${PGDATA:?PGDATA is required}"
if [ ! -f "$PGDATA/pg_hba.conf" ]; then
  echo 'This container does not expose its PostgreSQL authentication file; refuse upgrade.' >&2
  exit 1
fi
current_owner="${PG_UPGRADE_CURRENT_USER:-jungle}"
case "$current_owner" in jungle|jungle_migrator) ;; *) echo 'Unexpected legacy owner; inspect the challenge volume manually.' >&2; exit 1 ;; esac

# The old owner authenticates locally inside this project's container. An operator must opt in.
PGPASSWORD="${PG_UPGRADE_CURRENT_PASSWORD:-$POSTGRES_PASSWORD}" psql -X -q --username "$current_owner" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv owner_password POSTGRES_PASSWORD
\getenv app_password PG_APP_PASSWORD
SET password_encryption = 'scram-sha-256';
SELECT current_user='jungle' AS needs_rename \gset
\if :needs_rename
  SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='jungle_migrator') AS ambiguous_owner \gset
  \if :ambiguous_owner
    \echo 'Both owner roles exist; refuse ambiguous ownership upgrade.'
    \quit 3
  \endif
  -- PostgreSQL forbids renaming the session user. A temporary NOLOGIN operator preserves
  -- the legacy owner's OID and every existing ownership relation without another password.
  CREATE ROLE jungle_security_upgrade NOLOGIN SUPERUSER;
  SET SESSION AUTHORIZATION jungle_security_upgrade;
  ALTER ROLE jungle RENAME TO jungle_migrator;
  RESET SESSION AUTHORIZATION;
  DROP ROLE jungle_security_upgrade;
\endif
ALTER ROLE jungle_migrator PASSWORD :'owner_password';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jungle_app') THEN
    CREATE ROLE jungle_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
ALTER ROLE jungle_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_password';
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO jungle_app', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jungle_app;
SQL

if [ -n "${PGDATA:-}" ] && [ -f "$PGDATA/pg_hba.conf" ]; then
  if [ ! -f "$PGDATA/pg_hba.before-security-upgrade.conf" ]; then
    cp "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.before-security-upgrade.conf"
  fi
  # This is the operator-selected challenge container's PGDATA only.
  sed -E '/^[[:space:]]*#/! s/[[:space:]](trust|md5|password)([[:space:]]|$)/ scram-sha-256\2/' "$PGDATA/pg_hba.conf" > "$PGDATA/pg_hba.security-new.conf"
  if [ "$(id -u)" = 0 ]; then
    chown "$(stat -c '%u:%g' "$PGDATA/pg_hba.conf")" "$PGDATA/pg_hba.security-new.conf"
  fi
  chmod 600 "$PGDATA/pg_hba.security-new.conf"
  mv "$PGDATA/pg_hba.security-new.conf" "$PGDATA/pg_hba.conf"
  PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q --username jungle_migrator --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL' >/dev/null
SELECT pg_reload_conf();
SELECT pg_sleep(0.2);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL OR auth_method IN ('trust','md5','password')) THEN
    RAISE EXCEPTION 'Authentication file still contains weak or invalid rules';
  END IF;
END $$;
SQL
fi
if PGPASSWORD='' PGPASSFILE=/nonexistent PGCONNECT_TIMEOUT=2 psql -X -q -w -h 127.0.0.1 --username jungle_app --dbname "$POSTGRES_DB" -c 'SELECT 1' >/dev/null 2>&1; then
  echo 'Passwordless TCP connection unexpectedly succeeded; secure profile is not ready.' >&2
  exit 1
fi
echo 'Challenge PostgreSQL credentials upgraded; existing data and role ownership were preserved. Run migrations with the dedicated migrator.'
