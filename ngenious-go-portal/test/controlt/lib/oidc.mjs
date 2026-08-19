import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { HttpError } from "./errors.mjs";

const randomValue = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class OidcClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.discovery = null;
    this.jwks = null;
    this.jwksExpiresAt = 0;
    this.internalIssuer = `${config.keycloakInternalUrl}/realms/${encodeURIComponent(config.realm)}`;
  }

  internalEndpoint(endpoint) {
    if (!endpoint.startsWith(`${this.config.issuer}/`)) throw new Error("OIDC endpoint is outside the configured issuer");
    return `${this.internalIssuer}${endpoint.slice(this.config.issuer.length)}`;
  }

  issuerEndpoint(endpoint) {
    if (typeof endpoint !== "string" || !endpoint.startsWith(`${this.config.issuer}/`)) throw new Error("OIDC endpoint is outside the configured issuer");
    return endpoint;
  }

  async metadata() {
    if (this.discovery) return this.discovery;
    const response = await this.fetch(`${this.internalIssuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata.issuer !== this.config.issuer) throw new Error("OIDC issuer mismatch");
    this.discovery = metadata;
    return metadata;
  }

  async createAuthorization() {
    const metadata = await this.metadata();
    const state = randomValue();
    const nonce = randomValue();
    const verifier = randomValue(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(this.issuerEndpoint(metadata.authorization_endpoint));
    url.search = new URLSearchParams({
      client_id: this.config.oidcClientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: url.href, flow: { state, nonce, verifier } };
  }

  async logoutUrl() {
    const metadata = await this.metadata();
    if (!metadata.end_session_endpoint) return this.config.publicOrigin;
    const url = new URL(this.issuerEndpoint(metadata.end_session_endpoint));
    url.search = new URLSearchParams({
      client_id: this.config.oidcClientId,
      post_logout_redirect_uri: this.config.publicOrigin,
    });
    return url.href;
  }

  async exchange(code, flow) {
    const metadata = await this.metadata();
    const response = await this.fetch(this.internalEndpoint(metadata.token_endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.oidcClientId,
        client_secret: this.config.oidcClientSecret,
        code_verifier: flow.verifier,
      }),
    });
    if (!response.ok) throw new HttpError(401, "login_failed", "Keycloak did not accept the sign-in response.");
    const tokens = await response.json();
    const claims = await this.verifyIdToken(tokens.id_token, flow.nonce);
    return {
      sub: claims.sub,
      email: claims.email || claims.preferred_username,
      name: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || claims.email,
      roles: claims.resource_access?.[this.config.oidcClientId]?.roles || [],
    };
  }

  async keys(force = false) {
    if (!force && this.jwks && this.jwksExpiresAt > Date.now()) return this.jwks;
    const metadata = await this.metadata();
    const response = await this.fetch(this.internalEndpoint(metadata.jwks_uri));
    if (!response.ok) throw new Error(`OIDC key retrieval failed with HTTP ${response.status}`);
    this.jwks = (await response.json()).keys;
    this.jwksExpiresAt = Date.now() + 3_600_000;
    return this.jwks;
  }

  async verifyIdToken(token, nonce) {
    if (typeof token !== "string") throw new HttpError(401, "login_failed", "Keycloak did not return an identity token.");
    const segments = token.split(".");
    if (segments.length !== 3) throw new HttpError(401, "login_failed", "The identity token is malformed.");
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(segments[0], "base64url"));
      claims = JSON.parse(Buffer.from(segments[1], "base64url"));
    } catch {
      throw new HttpError(401, "login_failed", "The identity token is malformed.");
    }
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") throw new HttpError(401, "login_failed", "The identity token is malformed.");
    if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "login_failed", "The identity token algorithm is not accepted.");
    let key = (await this.keys()).find((candidate) => candidate.kid === header.kid);
    if (!key) key = (await this.keys(true)).find((candidate) => candidate.kid === header.kid);
    if (!key) throw new HttpError(401, "login_failed", "The identity token signing key is unknown.");
    const verified = verifySignature("RSA-SHA256", Buffer.from(`${segments[0]}.${segments[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(segments[2], "base64url"));
    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!verified || typeof claims.sub !== "string" || !claims.sub || claims.iss !== this.config.issuer || !audience.includes(this.config.oidcClientId) || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || claims.exp <= now || claims.iat > now + 60 || claims.nonce !== nonce) {
      throw new HttpError(401, "login_failed", "The identity token could not be verified.");
    }
    return claims;
  }
}
