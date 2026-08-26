import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const encode = (value) => Buffer.from(value).toString("base64url");

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

export function createSessionStore(secret, { ttlSeconds = 1_800, secure = true } = {}) {
  const key = Buffer.from(secret, "utf8");
  const sessions = new Map();
  const oauthFlows = new Map();

  function signature(id) {
    return createHmac("sha256", key).update(id).digest("base64url");
  }

  function token(id) {
    return `${id}.${signature(id)}`;
  }

  function verifiedId(value) {
    if (!value) return null;
    const [id, supplied, extra] = value.split(".");
    if (!id || !supplied || extra) return null;
    const expected = signature(id);
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? id : null;
  }

  function cookie(name, value, maxAge, sameSite = "Lax") {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  function createSession(user) {
    const id = encode(randomBytes(32));
    const now = Date.now();
    const session = { ...user, csrf: encode(randomBytes(24)), createdAt: now, expiresAt: now + ttlSeconds * 1000 };
    sessions.set(id, session);
    return { session, cookie: cookie("controlt_session", token(id), ttlSeconds) };
  }

  function getSession(cookieHeader) {
    const id = verifiedId(parseCookies(cookieHeader).controlt_session);
    const session = id ? sessions.get(id) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (id) sessions.delete(id);
      return null;
    }
    return { id, session };
  }

  function deleteSession(cookieHeader) {
    const id = verifiedId(parseCookies(cookieHeader).controlt_session);
    if (id) sessions.delete(id);
    return cookie("controlt_session", "", 0);
  }

  function createOauthFlow(flow) {
    const id = encode(randomBytes(24));
    oauthFlows.set(id, { ...flow, expiresAt: Date.now() + 600_000 });
    return cookie("controlt_oidc", token(id), 600);
  }

  function takeOauthFlow(cookieHeader) {
    const id = verifiedId(parseCookies(cookieHeader).controlt_oidc);
    if (!id) return null;
    const flow = oauthFlows.get(id);
    oauthFlows.delete(id);
    return flow?.expiresAt > Date.now() ? flow : null;
  }

  function clearOauthCookie() {
    return cookie("controlt_oidc", "", 0);
  }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [id, flow] of oauthFlows) if (flow.expiresAt <= now) oauthFlows.delete(id);
  }, 300_000);
  timer.unref();

  return { createSession, getSession, deleteSession, createOauthFlow, takeOauthFlow, clearOauthCookie };
}
