export type DemoClient = "admin-a" | "provider-a" | "admin-b" | "provider-b" | "provider-c";
const secretNames: Record<DemoClient, string> = {
  "admin-a": "OIDC_ADMIN_A_SECRET", "provider-a": "OIDC_PROVIDER_A_SECRET",
  "admin-b": "OIDC_ADMIN_B_SECRET", "provider-b": "OIDC_PROVIDER_B_SECRET", "provider-c": "OIDC_PROVIDER_C_SECRET",
};

export async function identityToken(client: DemoClient = "admin-a"): Promise<string> {
  const endpoint = process.env.OIDC_TOKEN_URL;
  const secret = process.env[secretNames[client]];
  if (!endpoint || !secret) throw new Error("OIDC test identity is not configured. Run setup and start Keycloak.");
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: `jg-${client}`, client_secret: secret }) });
  if (!response.ok) throw new Error(`OIDC identity unavailable (${response.status}).`);
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string") throw new Error("OIDC did not return an access token.");
  return payload.access_token;
}
