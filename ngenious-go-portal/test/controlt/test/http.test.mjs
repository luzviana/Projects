import assert from "node:assert/strict";
import { createRequestHandler } from "../lib/http-app.mjs";
import { KeycloakApiError } from "../lib/keycloak.mjs";
import { createSessionStore } from "../lib/sessions.mjs";

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

function request({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
  const chunks = body === "" ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function response() {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    writeHead(status, extra = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(extra)) this.setHeader(name, value);
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.headersSent = true;
      this.ended = true;
    },
    destroy() { this.destroyed = true; },
    get headers() { return headers; },
    get body() { return Buffer.concat(chunks).toString("utf8"); },
    get json() { return JSON.parse(this.body); },
  };
}

function harness() {
  const calls = [];
  const sessions = createSessionStore("b".repeat(64), { secure: true });
  const created = sessions.createSession({
    sub: "admin-1",
    email: "admin@example.test",
    name: "Test Admin",
    roles: ["ngenious-admin"],
  });
  const authHeaders = {
    cookie: created.cookie.split(";")[0],
    "x-controlt-csrf": created.session.csrf,
  };
  const service = {
    async listOrganizations(session) { calls.push(["listOrganizations", session]); return [{ id: "org-1", name: "Example" }]; },
    async listApplications(session, organizationId) { calls.push(["listApplications", session, organizationId]); return []; },
    async listMembers(session, organizationId) { calls.push(["listMembers", session, organizationId]); return []; },
    async createAndInvite(session, organizationId, body) { calls.push(["createAndInvite", session, organizationId, body]); return { id: "user-1", status: "invited" }; },
    async resendInvitation(session, organizationId, userId) { calls.push(["resendInvitation", session, organizationId, userId]); return { id: userId, status: "invited" }; },
    async updateMember(session, organizationId, userId, body) { calls.push(["updateMember", session, organizationId, userId, body]); return { id: userId, ...body }; },
  };
  const oidc = {
    async createAuthorization() { return { url: "https://id.example.test/authorize", flow: { state: "state-1", verifier: "verifier-1" } }; },
    async exchange() { return { sub: "admin-2", email: "second@example.test", name: "Second Admin", roles: ["ngenious-admin"] }; },
    async logoutUrl() { return "https://id.example.test/logout"; },
  };
  const errors = [];
  const handler = createRequestHandler({
    config: { publicOrigin: "https://controlt.ngenious.app", postLoginPath: "/" },
    sessions,
    oidc,
    service,
    logError: (record) => errors.push(record),
  });
  return { handler, sessions, service, oidc, calls, errors, authHeaders, created };
}

async function invoke(handler, options) {
  const res = response();
  await handler(request(options), res);
  return res;
}

await test("redirects an unauthenticated root request directly to sign-in", async () => {
  const { handler } = harness();
  const res = await invoke(handler, { url: "/" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.get("location"), "https://id.example.test/authorize");
  assert.match(res.headers.get("set-cookie")[0], /^controlt_oidc=/);
  assert.match(res.headers.get("set-cookie")[0], /HttpOnly/);
  assert.match(res.headers.get("set-cookie")[0], /Secure/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(res.headers.get("x-request-id"));
});

await test("serves the application to an authenticated administrator", async () => {
  const { handler, authHeaders } = harness();
  const res = await invoke(handler, { url: "/", headers: authHeaders });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<!doctype html>/i);
  assert.match(res.body, /Control administration/);
  assert.match(res.body, />Team</);
  assert.match(res.body, /Add team member/);
  assert.doesNotMatch(res.body, />People</);
  assert.doesNotMatch(res.body, /ControlT/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(res.headers.get("x-request-id"));
});

await test("serves the packaged ngenious logo and robot favicon", async () => {
  const { handler } = harness();
  const logo = await invoke(handler, { url: "/assets/ngenious-logo.png" });
  const favicon = await invoke(handler, { url: "/favicon.ico" });
  assert.equal(logo.statusCode, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.ok(logo.body.length > 100);
  assert.equal(favicon.statusCode, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");
  assert.ok(favicon.body.length > 100);
});

await test("rejects an unauthenticated API request", async () => {
  const { handler } = harness();
  const res = await invoke(handler, { url: "/api/organizations" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.error, "authentication_required");
});

await test("returns only the signed-in user's safe session fields", async () => {
  const { handler, authHeaders, created } = harness();
  const res = await invoke(handler, { url: "/api/session", headers: authHeaders });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.user, {
    sub: "admin-1",
    email: "admin@example.test",
    name: "Test Admin",
    roles: ["ngenious-admin"],
  });
  assert.equal(res.json.csrf, created.session.csrf);
  assert.equal(res.json.user.expiresAt, undefined);
});

await test("rejects a write when the CSRF token is missing", async () => {
  const { handler, authHeaders, calls } = harness();
  const headers = { cookie: authHeaders.cookie, "content-type": "application/json" };
  const res = await invoke(handler, { method: "POST", url: "/api/organizations/org-1/users", headers, body: "{}" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, "csrf_failed");
  assert.equal(calls.length, 0);
});

await test("rejects a write when the CSRF token is invalid", async () => {
  const { handler, authHeaders, calls } = harness();
  const headers = { ...authHeaders, "x-controlt-csrf": "wrong", "content-type": "application/json" };
  const res = await invoke(handler, { method: "POST", url: "/api/organizations/org-1/users", headers, body: "{}" });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

await test("accepts a valid protected create-user request", async () => {
  const { handler, authHeaders, calls } = harness();
  const body = { email: "new@example.test", firstName: "New", lastName: "User", applications: ["streamer"] };
  const res = await invoke(handler, {
    method: "POST",
    url: "/api/organizations/customer%20one/users",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.user.status, "invited");
  assert.equal(calls[0][0], "createAndInvite");
  assert.equal(calls[0][2], "customer one");
  assert.deepEqual(calls[0][3], body);
});

await test("requires JSON for a request with a body", async () => {
  const { handler, authHeaders } = harness();
  const res = await invoke(handler, { method: "POST", url: "/api/organizations/org-1/users", headers: authHeaders, body: "email=x" });
  assert.equal(res.statusCode, 415);
  assert.equal(res.json.error, "json_required");
});

await test("rejects malformed JSON", async () => {
  const { handler, authHeaders } = harness();
  const res = await invoke(handler, {
    method: "POST", url: "/api/organizations/org-1/users", headers: { ...authHeaders, "content-type": "application/json" }, body: "{",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "invalid_json");
});

await test("rejects a request body over the size limit", async () => {
  const { handler, authHeaders } = harness();
  const res = await invoke(handler, {
    method: "POST", url: "/api/organizations/org-1/users", headers: { ...authHeaders, "content-type": "application/json" }, body: Buffer.alloc(65_537, 32),
  });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json.error, "request_too_large");
});

await test("logout invalidates the local session and returns the identity logout URL", async () => {
  const { handler, authHeaders } = harness();
  const logout = await invoke(handler, { method: "POST", url: "/auth/logout", headers: authHeaders });
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.json.redirect, "https://id.example.test/logout");
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  const after = await invoke(handler, { url: "/api/session", headers: { cookie: authHeaders.cookie } });
  assert.equal(after.statusCode, 401);
});

await test("does not expose an identity-provider error body", async () => {
  const h = harness();
  h.service.listOrganizations = async () => { throw new KeycloakApiError(500, "failed", "sensitive upstream response"); };
  const res = await invoke(h.handler, { url: "/api/organizations", headers: h.authHeaders });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json.error, "identity_service_error");
  assert.doesNotMatch(res.body, /sensitive/);
});

await test("returns a secured 404 for an unknown route", async () => {
  const { handler } = harness();
  const res = await invoke(handler, { url: "/not-a-route" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.error, "not_found");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

await test("rejects a callback without a matching login flow", async () => {
  const { handler } = harness();
  const res = await invoke(handler, { url: "/auth/callback?state=wrong&code=code-1" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.error, "login_failed");
});

await test("starts an authorization flow with a short-lived protected cookie", async () => {
  const { handler } = harness();
  const res = await invoke(handler, { url: "/auth/login" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.get("location"), "https://id.example.test/authorize");
  assert.match(res.headers.get("set-cookie")[0], /^controlt_oidc=/);
  assert.match(res.headers.get("set-cookie")[0], /HttpOnly/);
  assert.match(res.headers.get("set-cookie")[0], /Secure/);
});

if (!process.exitCode) process.stdout.write(`${passed} HTTP and security tests passed\n`);
