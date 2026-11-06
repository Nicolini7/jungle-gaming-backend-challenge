import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { AppError } from "../../application/errors.ts";

export interface Principal {
  readonly subject: string;
  readonly tenantId: string;
  readonly providerId?: string;
  readonly roles: ReadonlySet<string>;
}

export interface IdentityConfiguration {
  issuer: string;
  audience: string;
  jwksUri: string;
  providerTenants: ReadonlyMap<string, string>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
export function validTenant(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value) && value !== "system";
}

export function identityConfiguration(env: Record<string, string | undefined> = process.env): IdentityConfiguration {
  const { OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience, OIDC_JWKS_URI: jwksUri, PROVIDER_TENANTS_JSON: registry } = env;
  if (!issuer || !audience || !jwksUri || !registry) throw new Error("OIDC issuer, audience, JWKS URI and provider registry are required. Run setup first.");
  for (const value of [issuer, jwksUri]) {
    const url = new URL(value);
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) throw new Error("Invalid OIDC endpoint.");
    if (env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Production OIDC endpoints must use HTTPS.");
  }
  let entries: Array<[string, unknown]>;
  try {
    const parsed: unknown = JSON.parse(registry);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    entries = Object.entries(parsed);
  } catch { throw new Error("Invalid provider registry."); }
  const providerTenants = new Map<string, string>();
  for (const [provider, tenant] of entries) {
    if (!identifier.test(provider) || provider === "system" || !validTenant(tenant)) throw new Error("Invalid provider registry entry.");
    providerTenants.set(provider, tenant);
  }
  if (!providerTenants.size) throw new Error("Provider registry cannot be empty.");
  return { issuer, audience, jwksUri, providerTenants };
}

/** Token verification is delegated to the external IdP's configured JWKS. */
export class OidcIdentityVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(readonly configuration: IdentityConfiguration) {
    this.keys = createRemoteJWKSet(new URL(configuration.jwksUri), { timeoutDuration: 3000, cooldownDuration: 1000, cacheMaxAge: 300_000 });
  }

  async verify(authorization: unknown): Promise<Principal> {
    if (typeof authorization !== "string" || authorization.length > 8192) throw new AppError(401, "AUTHENTICATION_REQUIRED");
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match?.[1]) throw new AppError(401, "INVALID_ACCESS_TOKEN");
    try {
      const { payload } = await jwtVerify(match[1], this.keys, {
        issuer: this.configuration.issuer, audience: this.configuration.audience,
        algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "tenant_id"], clockTolerance: 5,
      });
      if (typeof payload.sub !== "string" || !payload.sub || !validTenant(payload.tenant_id)) throw new AppError(401, "INVALID_ACCESS_TOKEN");
      const realm = payload.realm_access;
      if (!realm || typeof realm !== "object" || !Array.isArray((realm as { roles?: unknown }).roles)) throw new AppError(403, "INSUFFICIENT_ROLE");
      const rawRoles = (realm as { roles: unknown[] }).roles;
      if (!rawRoles.every(role => typeof role === "string")) throw new AppError(401, "INVALID_ACCESS_TOKEN");
      const roles = new Set(rawRoles as string[]);
      if (!roles.has("wallet-admin") && !roles.has("wager-provider")) throw new AppError(403, "INSUFFICIENT_ROLE");
      const providerId = payload.provider_id;
      if (providerId !== undefined && (typeof providerId !== "string" || this.configuration.providerTenants.get(providerId) !== payload.tenant_id)) throw new AppError(403, "PROVIDER_IDENTITY_MISMATCH");
      if (!roles.has("wallet-admin") && typeof providerId !== "string") throw new AppError(403, "PROVIDER_IDENTITY_REQUIRED");
      return Object.freeze({ subject: payload.sub, tenantId: payload.tenant_id, roles,
        ...(typeof providerId === "string" ? { providerId } : {}) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE");
      throw new AppError(401, "INVALID_ACCESS_TOKEN");
    }
  }
}
