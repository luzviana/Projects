import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { OidcClient } from "../lib/oidc.mjs";

let passed = 0;

async function test(name, run) {
  try {
    await run();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

const issuer = "https://id.ngenious.app/realms/go-portal-test";
const clientId = "controlt-web";
const kid = "test-signing-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = kid;
jwk.alg = "RS256";
jwk.use = "sig";

const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  jwks_uri: `${issuer}/protocol/openid-connect/certs`,
};

function response(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

function client() {
  return new OidcClient({
    keycloakInternalUrl: "http://keycloak:8080",
    realm: "go-portal-test",
    issuer,
    oidcClientId: clientId,
    oidcClientSecret: "test-only-secret",
    redirectUri: "https://controlt.ngenious.app/auth/callback",
    publicOrigin: "https://controlt.ngenious.app",
  }, async (url) => {
    if (url.endsWith("/.well-known/openid-configuration")) return response(metadata);
    if (url.endsWith("/protocol/openid-connect/certs")) return response({ keys: [jwk] });
    throw new Error(`Unexpected request: ${url}`);
  });
}

function token(overrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...headerOverrides })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: "admin-1",
    iss: issuer,
    aud: clientId,
    iat: now,
    exp: now + 300,
    nonce: "nonce-1",
    email: "admin@example.test",
    ...overrides,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function rejectsLogin(run) {
  await assert.rejects(run, (error) => error instanceof HttpError && error.status === 401 && error.code === "login_failed");
}

await test("accepts an RS256 token with the expected signature and claims", async () => {
  const claims = await client().verifyIdToken(token(), "nonce-1");
  assert.equal(claims.sub, "admin-1");
  assert.equal(claims.email, "admin@example.test");
});

await test("rejects a token whose signed payload was altered", async () => {
  const valid = token();
  const [header, payload, signature] = valid.split(".");
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), sub: "attacker" })).toString("base64url");
  await rejectsLogin(() => client().verifyIdToken(`${header}.${changed}.${signature}`, "nonce-1"));
});

await test("rejects invalid issuer, audience, expiry, nonce, subject, and algorithm", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const candidate of [
    token({ iss: "https://attacker.invalid" }),
    token({ aud: "another-client" }),
    token({ exp: now - 1 }),
    token({ nonce: "another-nonce" }),
    token({ sub: "" }),
    token({}, { alg: "HS256" }),
  ]) await rejectsLogin(() => client().verifyIdToken(candidate, "nonce-1"));
});

await test("rejects malformed token JSON as a failed sign-in", async () => {
  await rejectsLogin(() => client().verifyIdToken("not-json.also-not-json.signature", "nonce-1"));
});

if (!process.exitCode) process.stdout.write(`${passed} identity-token security tests passed\n`);
