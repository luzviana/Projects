import http from "node:http";
import { loadConfig } from "./lib/config.mjs";
import { createRequestHandler } from "./lib/http-app.mjs";
import { KeycloakAdmin } from "./lib/keycloak.mjs";
import { OidcClient } from "./lib/oidc.mjs";
import { ControlTService } from "./lib/service.mjs";
import { createSessionStore } from "./lib/sessions.mjs";

const config = loadConfig();
const sessions = createSessionStore(config.sessionSecret, {
  ttlSeconds: config.sessionTtlSeconds,
  secure: config.cookieSecure,
});
const oidc = new OidcClient(config);
const keycloak = new KeycloakAdmin(config);
const service = new ControlTService(config, keycloak);
const server = http.createServer(createRequestHandler({ config, sessions, oidc, service }));

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ type: "controlt.start", port: config.port })}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${JSON.stringify({ type: "controlt.stop", signal })}\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
