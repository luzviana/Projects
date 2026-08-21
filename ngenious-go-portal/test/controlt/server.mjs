import http from "node:http";
import { loadConfig } from "./lib/config.mjs";
import { createRequestHandler } from "./lib/http-app.mjs";
import { KeycloakAdmin } from "./lib/keycloak.mjs";
import { OidcClient } from "./lib/oidc.mjs";
import { ControlTService } from "./lib/service.mjs";
import { createSessionStore } from "./lib/sessions.mjs";
import { InvitationStore, invitationCss, invitationPage } from "./lib/invitations.mjs";
import { createIdentitySmtpServer, IdentityMailRelay } from "./lib/identity-mail-relay.mjs";

const config = loadConfig();
const sessions = createSessionStore(config.sessionSecret, {
  ttlSeconds: config.sessionTtlSeconds,
  secure: config.cookieSecure,
});
const oidc = new OidcClient(config);
const keycloak = new KeycloakAdmin(config);
const service = new ControlTService(config, keycloak);
const invitations = new InvitationStore(config);
const relay = new IdentityMailRelay(config, invitations);
const smtpServer = createIdentitySmtpServer(config, relay);
const server = http.createServer(createRequestHandler({ config, sessions, oidc, service, invitations, invitationPage, invitationCss }));

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
smtpServer.listen(config.identityRelayPort, "0.0.0.0", () => {
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ type: "controlt.start", port: config.port, identityRelayPort: config.identityRelayPort })}\n`);
  });
});

const cleanupTimer = setInterval(() => invitations.cleanup().catch(() => {}), 60 * 60 * 1000);
cleanupTimer.unref();

function shutdown(signal) {
  process.stdout.write(`${JSON.stringify({ type: "controlt.stop", signal })}\n`);
  clearInterval(cleanupTimer);
  smtpServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
