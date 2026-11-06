import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { OidcIdentityVerifier, identityConfiguration } from "../../src/infrastructure/security/identity.ts";

describe("OIDC — assinatura, claims e identidade do provedor", () => {
  let server: ReturnType<typeof Bun.serve>;
  let signingKey: CryptoKey;
  let invalidKey: CryptoKey;
  let verifier: OidcIdentityVerifier;
  const issuer = "https://identity.example/realms/jungle";

  beforeAll(async () => {
    const valid = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    signingKey = valid.privateKey;
    invalidKey = other.privateKey;
    const publicKey = { ...await exportJWK(valid.publicKey), kid: "unit-key", use: "sig", alg: "RS256" };
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [publicKey] }) });
    verifier = new OidcIdentityVerifier({ issuer, audience: "jungle-api", jwksUri: `${server.url}jwks`,
      providerTenants: new Map([["provider-a", "operator-a"], ["constructor", "operator-c"]]) });
  });
  afterAll(() => server.stop(true));

  async function token(claims: Record<string, unknown> = {}, key = signingKey) {
    return new SignJWT({ tenant_id: "operator-a", provider_id: "provider-a", realm_access: { roles: ["wager-provider"] }, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "unit-key" }).setIssuer(issuer).setAudience("jungle-api")
      .setSubject("service-provider-a").setIssuedAt().setExpirationTime("5m").sign(key);
  }

  test("valida token assinado pelo IdP e vincula provider ao tenant", async () => {
    const principal = await verifier.verify(`Bearer ${await token()}`);
    expect(principal.tenantId).toBe("operator-a");
    expect(principal.providerId).toBe("provider-a");
    expect(principal.roles.has("wager-provider")).toBe(true);
  });
  test("rejeita ausência de token e formato de bearer inválido", async () => {
    await expect(verifier.verify(undefined)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifier.verify("Bearer unsigned")).rejects.toMatchObject({ statusCode: 401 });
  });
  test("rejeita assinatura de outra chave, mesmo com kid conhecido", async () => {
    await expect(verifier.verify(`Bearer ${await token({}, invalidKey)}`)).rejects.toMatchObject({ statusCode: 401 });
  });
  test("rejeita payload adulterado sem nova assinatura", async () => {
    const original = await token();
    const segments = original.split(".");
    segments[1] = Buffer.from(JSON.stringify({ tenant_id: "operator-b", realm_access: { roles: ["wallet-admin"] } })).toString("base64url");
    await expect(verifier.verify(`Bearer ${segments.join(".")}`)).rejects.toMatchObject({ statusCode: 401 });
  });
  test("rejeita issuer, audience e expiração incorretos", async () => {
    for (const overrides of [{ iss: "https://other.example" }, { aud: "other-api" }, { exp: 1 }]) {
      const jwt = await new SignJWT({ sub: "client", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300,
        iss: issuer, aud: "jungle-api", tenant_id: "operator-a", provider_id: "provider-a",
        realm_access: { roles: ["wager-provider"] }, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "unit-key" }).sign(signingKey);
      await expect(verifier.verify(`Bearer ${jwt}`)).rejects.toMatchObject({ statusCode: 401 });
    }
  });
  test("recusa tenant reservado, role ausente e provider de outro operador", async () => {
    await expect(verifier.verify(`Bearer ${await token({ tenant_id: "__internal__" })}`)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifier.verify(`Bearer ${await token({ realm_access: { roles: ["user"] } })}`)).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifier.verify(`Bearer ${await token({ tenant_id: "operator-b" })}`)).rejects.toMatchObject({ statusCode: 403 });
  });
  test("um administrador válido dispensa provider_id, mas não tenant", async () => {
    const jwt = await token({ provider_id: undefined, realm_access: { roles: ["wallet-admin"] } });
    expect((await verifier.verify(`Bearer ${jwt}`)).roles.has("wallet-admin")).toBe(true);
  });
  test("configuração falha fechada; nomes de prototype não criam bindings implícitos", () => {
    expect(() => identityConfiguration({})).toThrow();
    expect(() => identityConfiguration({ OIDC_ISSUER: issuer, OIDC_AUDIENCE: "api", OIDC_JWKS_URI: issuer+"/certs",
      PROVIDER_TENANTS_JSON: '{"provider-a":"__internal__"}' })).toThrow();
    const configured = identityConfiguration({ OIDC_ISSUER: issuer, OIDC_AUDIENCE: "api", OIDC_JWKS_URI: issuer+"/certs",
      PROVIDER_TENANTS_JSON: '{"provider-a":"operator-a"}' });
    expect(configured.providerTenants.get("constructor")).toBeUndefined();
  });
});
