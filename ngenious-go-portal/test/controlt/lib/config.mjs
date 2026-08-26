function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value == null || value === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function secretHex(env, name) {
  const value = required(env, name);
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be 32 bytes encoded as hexadecimal`);
  return value.toLowerCase();
}

export function loadConfig(env = process.env) {
  const publicOrigin = new URL(env.CONTROLT_PUBLIC_ORIGIN || "https://controlt.ngenious.app");
  const issuer = required(env, "KEYCLOAK_ISSUER").replace(/\/$/, "");
  const realm = required(env, "KEYCLOAK_REALM");

  return Object.freeze({
    port: positiveInteger(env.PORT, 3100, "PORT"),
    publicOrigin: publicOrigin.origin,
    redirectUri: new URL("/auth/callback", publicOrigin).href,
    postLoginPath: "/",
    keycloakInternalUrl: required(env, "KEYCLOAK_INTERNAL_URL").replace(/\/$/, ""),
    issuer,
    realm,
    serviceClientId: required(env, "KEYCLOAK_ADMIN_CLIENT_ID"),
    serviceClientSecret: required(env, "KEYCLOAK_ADMIN_CLIENT_SECRET"),
    oidcClientId: env.CONTROLT_OIDC_CLIENT_ID?.trim() || "controlt-web",
    oidcClientSecret: required(env, "CONTROLT_OIDC_CLIENT_SECRET"),
    sessionSecret: required(env, "CONTROLT_SESSION_SECRET"),
    sessionTtlSeconds: positiveInteger(env.CONTROLT_SESSION_TTL_SECONDS, 1_800, "CONTROLT_SESSION_TTL_SECONDS"),
    invitationLifespanSeconds: positiveInteger(env.CONTROLT_INVITATION_LIFESPAN_SECONDS, 43_200, "CONTROLT_INVITATION_LIFESPAN_SECONDS"),
    invitationPublicOrigin: new URL(env.CONTROLT_INVITATION_PUBLIC_ORIGIN || new URL(issuer).origin).origin,
    invitationDirectory: env.CONTROLT_INVITATION_DIRECTORY?.trim() || "/var/lib/controlt/invitations",
    invitationSecret: secretHex(env, "CONTROLT_INVITATION_SECRET"),
    identityRelayPort: positiveInteger(env.CONTROLT_IDENTITY_RELAY_PORT, 2_525, "CONTROLT_IDENTITY_RELAY_PORT"),
    identityRelayMaxBytes: positiveInteger(env.CONTROLT_IDENTITY_RELAY_MAX_BYTES, 524_288, "CONTROLT_IDENTITY_RELAY_MAX_BYTES"),
    postmarkServerToken: required(env, "POSTMARK_SERVER_TOKEN"),
    postmarkMessageStream: env.POSTMARK_MESSAGE_STREAM?.trim() || "outbound",
    applicationRole: env.CONTROLT_APPLICATION_ROLE?.trim() || "access",
    internalAdminRole: env.CONTROLT_INTERNAL_ADMIN_ROLE?.trim() || "ngenious-admin",
    customerAdminRole: env.CONTROLT_CUSTOMER_ADMIN_ROLE?.trim() || "organization-admin",
    allowedApplicationsAttribute: env.CONTROLT_ALLOWED_APPLICATIONS_ATTRIBUTE?.trim() || "ngenious.allowedApplications",
    cookieSecure: publicOrigin.protocol === "https:",
  });
}
