#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${PG_APP_PASSWORD:?PG_APP_PASSWORD is required}"

if [ "$POSTGRES_USER" != "jungle_migrator" ]; then
  echo 'The secure profile requires the dedicated jungle_migrator owner.' >&2
  exit 1
fi

# psql reads passwords from its environment; none are placed in command-line arguments.
PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password PG_APP_PASSWORD
SET password_encryption = 'scram-sha-256';
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
