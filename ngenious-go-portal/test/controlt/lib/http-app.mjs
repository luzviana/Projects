import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HttpError, publicError } from "./errors.mjs";
import { KeycloakApiError } from "./keycloak.mjs";

const staticFiles = new Map([
  ["/", { url: new URL("../public/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/assets/app.css", { url: new URL("../public/app.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ["/assets/app.js", { url: new URL("../public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/assets/ngenious-logo.png", { url: new URL("../public/ngenious-logo.png", import.meta.url), type: "image/png" }],
  ["/favicon.ico", { url: new URL("../public/ngenious-robot-v1.ico", import.meta.url), type: "image/x-icon" }],
]);

function securityHeaders(response, requestId) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-request-id", requestId);
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function redirect(response, location, cookies = []) {
  response.statusCode = 302;
  response.setHeader("location", location);
  if (cookies.length) response.setHeader("set-cookie", cookies);
  response.end();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new HttpError(413, "request_too_large", "The request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_required", "Send the request as JSON.");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid_json", "The request contains invalid JSON."); }
}

async function staticFile(response, pathname) {
  const asset = staticFiles.get(pathname);
  if (!asset) return false;
  const payload = await readFile(asset.url);
  response.writeHead(200, { "content-type": asset.type, "content-length": payload.length });
  response.end(payload);
  return true;
}

const part = (value) => {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, "invalid_path", "The request path is invalid."); }
};

export function createRequestHandler({ config, sessions, oidc, service, logError = (record) => process.stderr.write(`${JSON.stringify(record)}\n`) }) {
  function authenticated(request) {
    const found = sessions.getSession(request.headers.cookie);
    if (!found) throw new HttpError(401, "authentication_required", "Sign in to continue.");
    return found.session;
  }

  function csrf(request, session) {
    const supplied = request.headers["x-controlt-csrf"];
    if (typeof supplied !== "string") throw new HttpError(403, "csrf_failed", "The request security token is missing.");
    const a = Buffer.from(supplied);
    const b = Buffer.from(session.csrf);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, "csrf_failed", "The request security token is invalid.");
  }

  async function api(request, response, url) {
    const session = authenticated(request);
    const segments = url.pathname.split("/").filter(Boolean).map(part);
    if (request.method === "GET" && url.pathname === "/api/session") return json(response, 200, { user: { sub: session.sub, email: session.email, name: session.name, roles: session.roles }, csrf: session.csrf });
    if (request.method === "GET" && url.pathname === "/api/team") return json(response, 200, { team: await service.team(session) });
    if (request.method === "POST" && url.pathname === "/api/team/users") {
      csrf(request, session);
      return json(response, 201, { user: await service.addTeamMember(session, await readJson(request)) });
    }
    if (segments[0] === "api" && segments[1] === "team" && segments[2] === "users" && segments[3]) {
      if (request.method === "PATCH" && segments.length === 4) {
        csrf(request, session);
        return json(response, 200, { user: await service.updateTeamMember(session, segments[3], await readJson(request)) });
      }
      if (request.method === "POST" && segments.length === 5 && segments[4] === "resend") {
        csrf(request, session);
        return json(response, 200, { user: await service.resendTeamInvitation(session, segments[3]) });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/organizations") return json(response, 200, { organizations: await service.listOrganizations(session) });
    if (segments[0] !== "api" || segments[1] !== "organizations" || !segments[2]) throw new HttpError(404, "not_found", "The requested endpoint does not exist.");
    const organizationId = segments[2];
    if (request.method === "GET" && segments.length === 4 && segments[3] === "applications") return json(response, 200, { applications: await service.listApplications(session, organizationId) });
    if (request.method === "GET" && segments.length === 4 && segments[3] === "members") return json(response, 200, { members: await service.listMembers(session, organizationId) });
    if (request.method === "POST" && segments.length === 4 && segments[3] === "users") {
      csrf(request, session);
      return json(response, 201, { user: await service.createAndInvite(session, organizationId, await readJson(request)) });
    }
    if (request.method === "POST" && segments.length === 6 && segments[3] === "users" && segments[5] === "resend") {
      csrf(request, session);
      return json(response, 200, { user: await service.resendInvitation(session, organizationId, segments[4]) });
    }
    if (request.method === "PATCH" && segments.length === 5 && segments[3] === "users") {
      csrf(request, session);
      return json(response, 200, { user: await service.updateMember(session, organizationId, segments[4], await readJson(request)) });
    }
    throw new HttpError(404, "not_found", "The requested endpoint does not exist.");
  }

  async function route(request, response) {
    const url = new URL(request.url, config.publicOrigin);
    if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && (url.pathname === "/auth/login" || (url.pathname === "/" && !sessions.getSession(request.headers.cookie)))) {
      const { url: authorizationUrl, flow } = await oidc.createAuthorization();
      return redirect(response, authorizationUrl, [sessions.createOauthFlow(flow)]);
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") {
      const flow = sessions.takeOauthFlow(request.headers.cookie);
      if (!flow || !url.searchParams.get("state") || url.searchParams.get("state") !== flow.state || !url.searchParams.get("code")) throw new HttpError(401, "login_failed", "The sign-in response expired or could not be matched.");
      const identity = await oidc.exchange(url.searchParams.get("code"), flow);
      const user = await service.sessionForAdministrator(identity);
      const created = sessions.createSession(user);
      return redirect(response, config.postLoginPath, [created.cookie, sessions.clearOauthCookie()]);
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const session = authenticated(request);
      csrf(request, session);
      response.setHeader("set-cookie", sessions.deleteSession(request.headers.cookie));
      return json(response, 200, { redirect: await oidc.logoutUrl() });
    }
    if (url.pathname.startsWith("/api/")) return api(request, response, url);
    if (request.method === "GET" && await staticFile(response, url.pathname)) return;
    throw new HttpError(404, "not_found", "The requested endpoint does not exist.");
  }

  return async function handle(request, response) {
    const requestId = randomUUID();
    securityHeaders(response, requestId);
    try {
      await route(request, response);
    } catch (error) {
      const mapped = error instanceof KeycloakApiError ? new HttpError(502, "identity_service_error", "The identity service could not complete the request.") : error;
      const result = publicError(mapped);
      if (!(error instanceof HttpError) && !(error instanceof KeycloakApiError)) logError({ type: "controlt.error", time: new Date().toISOString(), requestId, message: error?.message || "Unknown error" });
      if (!response.headersSent) json(response, result.status, result.body);
      else response.destroy();
    }
  };
}
