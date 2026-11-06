import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Builtins only: configuration must work before application dependencies are installed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const realmPath = resolve(root, ".local/keycloak/jungle-realm.json");
const secretKeys = ["POSTGRES_PASSWORD", "PG_APP_PASSWORD", "KEYCLOAK_ADMIN_PASSWORD",
  "OIDC_ADMIN_A_SECRET", "OIDC_PROVIDER_A_SECRET", "OIDC_ADMIN_B_SECRET",
  "OIDC_PROVIDER_B_SECRET", "OIDC_PROVIDER_C_SECRET"] as const;

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2] ?? "";
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { throw new Error("Invalid quoted value in the local environment file."); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values.set(match[1]!, value);
  }
  return values;
}

function envValue(value: string): string {
  return /^[A-Za-z0-9_./:@?&=+{},"-]*$/.test(value) && !/[\r\n#]/.test(value) ? value : JSON.stringify(value);
}

function claim(name: string, value: string) {
  return { name, protocol: "openid-connect", protocolMapper: "oidc-hardcoded-claim-mapper",
    config: { "claim.name": name, "claim.value": value, "jsonType.label": "String",
      "access.token.claim": "true", "id.token.claim": "false", "userinfo.token.claim": "false" } };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Generate idempotent local .env secrets and a Keycloak realm template. Does not modify PostgreSQL or print secret values.");
    return;
  }
  let previous = "";
  try { previous = await readFile(envPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values = parseEnv(previous);
  for (const key of secretKeys) {
    const existing = process.env[key] || values.get(key) || "";
    values.set(key, /^[A-Za-z0-9_-]{43,}$/.test(existing) ? existing : randomBytes(32).toString("base64url"));
  }
  const defaults: Record<string, string> = {
    PORT: "3000", HOST: "127.0.0.1", SQS_ENDPOINT: "http://127.0.0.1:4566", AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", WORKERS_ENABLED: "true", RUN_MIGRATIONS: "false",
    NODE_ENV: "development", KEYCLOAK_ADMIN_USERNAME: "jungle-admin",
    OIDC_ISSUER: "http://localhost:18080/realms/jungle",
    OIDC_JWKS_URI: "http://127.0.0.1:18080/realms/jungle/protocol/openid-connect/certs",
    OIDC_AUDIENCE: "jungle-api",
    OIDC_TOKEN_URL: "http://127.0.0.1:18080/realms/jungle/protocol/openid-connect/token",
    PROVIDER_TENANTS_JSON: JSON.stringify({ "provider-a": "operator-a", "provider-b": "operator-b", "provider-c": "operator-a" }),
  };
  for (const [key, fallback] of Object.entries(defaults)) values.set(key, process.env[key] || values.get(key) || fallback);

  // Native development is pinned to this project's isolated cluster, never an unrelated DB.
  values.set("DATABASE_URL", `postgresql://jungle_app:${encodeURIComponent(values.get("PG_APP_PASSWORD")!)}@127.0.0.1:55432/jungle`);
  values.set("APP_DATABASE_URL", values.get("DATABASE_URL")!);
  values.set("MIGRATION_DATABASE_URL", `postgresql://jungle:${encodeURIComponent(values.get("POSTGRES_PASSWORD")!)}@127.0.0.1:55432/jungle`);

  const clients = [
    { id: "jg-admin-a", tenant: "operator-a", role: "wallet-admin", secret: "OIDC_ADMIN_A_SECRET" },
    { id: "jg-provider-a", tenant: "operator-a", role: "wager-provider", provider: "provider-a", secret: "OIDC_PROVIDER_A_SECRET" },
    { id: "jg-admin-b", tenant: "operator-b", role: "wallet-admin", secret: "OIDC_ADMIN_B_SECRET" },
    { id: "jg-provider-b", tenant: "operator-b", role: "wager-provider", provider: "provider-b", secret: "OIDC_PROVIDER_B_SECRET" },
    { id: "jg-provider-c", tenant: "operator-a", role: "wager-provider", provider: "provider-c", secret: "OIDC_PROVIDER_C_SECRET" },
  ];
  const realm = {
    realm: "jungle", enabled: true, displayName: "Jungle Challenge", sslRequired: "external",
    registrationAllowed: false, resetPasswordAllowed: false, bruteForceProtected: true,
    roles: { realm: [{ name: "wallet-admin" }, { name: "wager-provider" }] },
    clients: clients.map(client => ({
      clientId: client.id, enabled: true, protocol: "openid-connect", publicClient: false,
      clientAuthenticatorType: "client-secret", secret: "$" + "{" + client.secret + "}",
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
      implicitFlowEnabled: false, fullScopeAllowed: true,
      protocolMappers: [claim("tenant_id", client.tenant), ...(client.provider ? [claim("provider_id", client.provider)] : []),
        { name: "audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper",
          config: { "included.custom.audience": "jungle-api", "access.token.claim": "true", "id.token.claim": "false" } },
        { name: "realm-roles", protocol: "openid-connect", protocolMapper: "oidc-usermodel-realm-role-mapper",
          config: { "claim.name": "realm_access.roles", "jsonType.label": "String", multivalued: "true",
            "access.token.claim": "true", "id.token.claim": "false", "userinfo.token.claim": "false" } },
      ],
    })),
    users: clients.map(client => ({ username: `service-account-${client.id}`, enabled: true,
      serviceAccountClientId: client.id, realmRoles: [client.role] })),
  };
  const envContents = "# Generated by scripts/setup.ts. Local secrets: never commit or print this file.\n" +
    [...values.entries()].map(([key, value]) => `${key}=${envValue(value)}`).join("\n") + "\n";
  await mkdir(dirname(realmPath), { recursive: true });
  if (envContents !== previous) await writeFile(envPath, envContents, { mode: 0o600 });
  try { await chmod(envPath, 0o600); } catch { /* Windows does not expose POSIX mode bits. */ }
  // Literal environment placeholders only. Readable by the container UID; no actual secrets.
  const realmContents = JSON.stringify(realm, null, 2) + "\n";
  let previousRealm = "";
  try { previousRealm = await readFile(realmPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (realmContents !== previousRealm) await writeFile(realmPath, realmContents, { mode: 0o644 });
  try { await chmod(realmPath, 0o644); } catch { /* Windows uses file ACLs. */ }
  console.log(JSON.stringify({ event: "local_configuration_ready", changed: envContents !== previous || realmContents !== previousRealm,
    files: [".env", ".local/keycloak/jungle-realm.json"] }));
}

await main().catch(() => { console.error("Local configuration could not be generated. No secret values were printed."); process.exitCode = 1; });
