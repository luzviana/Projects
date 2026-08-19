import assert from "node:assert/strict";
import test from "node:test";
import { createSessionStore } from "../lib/sessions.mjs";
import { ControlTService } from "../lib/service.mjs";
import { OidcClient } from "../lib/oidc.mjs";

const config = {
  internalAdminRole: "ngenious-admin",
  customerAdminRole: "organization-admin",
  allowedApplicationsAttribute: "ngenious.allowedApplications",
  invitationLifespanSeconds: 43_200,
};

function fakeKeycloak(overrides = {}) {
  const calls = [];
  const organization = { id: "org-a", name: "Alpha", attributes: { "ngenious.allowedApplications": ["app-a"] } };
  const application = { id: "client-a", clientId: "app-a", name: "Application A", role: { id: "role-a", name: "access" } };
  const api = {
    calls,
    listOrganizations: async () => [organization],
    getOrganization: async () => organization,
    userOrganizations: async () => [organization],
    organizationMembers: async () => [],
    application: async () => application,
    userClientRoles: async () => [],
    findUserByEmail: async () => null,
    createUser: async (user) => { calls.push(["createUser", user]); return "user-new"; },
    addOrganizationMember: async (...args) => calls.push(["addOrganizationMember", ...args]),
    addClientRole: async (...args) => calls.push(["addClientRole", ...args]),
    removeClientRole: async (...args) => calls.push(["removeClientRole", ...args]),
    sendSetupEmail: async (...args) => calls.push(["sendSetupEmail", ...args]),
    deleteUser: async (...args) => calls.push(["deleteUser", ...args]),
    getUser: async (id) => ({ id, username: "person@example.com", email: "person@example.com", enabled: true, emailVerified: false }),
    updateUser: async (...args) => calls.push(["updateUser", ...args]),
    ...overrides,
  };
  return api;
}

const internal = { sub: "admin-1", email: "admin@example.com", roles: ["ngenious-admin"] };
const customer = { sub: "admin-2", email: "customer@example.com", roles: ["organization-admin"] };

test("session cookies reject tampering", () => {
  const store = createSessionStore("a".repeat(64), { secure: false });
  const created = store.createSession(internal);
  assert.equal(store.getSession(created.cookie.split(";")[0]).session.sub, internal.sub);
  assert.equal(store.getSession(`${created.cookie.split(";")[0]}x`), null);
});

test("OIDC metadata is fetched internally while browser authorization remains public", async () => {
  const requested = [];
  const oidcConfig = {
    issuer: "https://id.ngenious.app/realms/go-portal-test",
    keycloakInternalUrl: "http://keycloak:8080",
    realm: "go-portal-test",
    oidcClientId: "controlt-web",
    oidcClientSecret: "secret",
    redirectUri: "https://controlt.ngenious.app/auth/callback",
  };
  const client = new OidcClient(oidcConfig, async (url) => {
    requested.push(url);
    return new Response(JSON.stringify({
      issuer: oidcConfig.issuer,
      authorization_endpoint: `${oidcConfig.issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${oidcConfig.issuer}/protocol/openid-connect/token`,
      jwks_uri: `${oidcConfig.issuer}/protocol/openid-connect/certs`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const authorization = await client.createAuthorization();
  assert.equal(requested[0], "http://keycloak:8080/realms/go-portal-test/.well-known/openid-configuration");
  assert.equal(new URL(authorization.url).origin, "https://id.ngenious.app");
});

test("customer administrators are bound to one organization", async () => {
  const keycloak = fakeKeycloak();
  const service = new ControlTService(config, keycloak);
  assert.deepEqual(await service.listOrganizations(customer), [{ id: "org-a", name: "Alpha", alias: undefined, enabled: undefined }]);
  await assert.rejects(() => service.listApplications(customer, "org-b"), (error) => error.status === 403 && error.code === "organization_forbidden");
});

test("create and invite never handles a password and assigns only allowed access", async () => {
  const keycloak = fakeKeycloak();
  const service = new ControlTService(config, keycloak);
  const result = await service.createAndInvite(internal, "org-a", {
    email: " PERSON@Example.com ", firstName: " Person ", lastName: " Example ", applications: ["app-a"],
  });
  assert.equal(result.email, "person@example.com");
  assert.equal(result.status, "Pending");
  const create = keycloak.calls.find(([name]) => name === "createUser")[1];
  assert.equal("credentials" in create, false);
  assert.deepEqual(keycloak.calls.map(([name]) => name), ["createUser", "addOrganizationMember", "addClientRole", "sendSetupEmail"]);
});

test("unapproved application access is rejected before user creation", async () => {
  const keycloak = fakeKeycloak();
  const service = new ControlTService(config, keycloak);
  await assert.rejects(() => service.createAndInvite(internal, "org-a", {
    email: "person@example.com", firstName: "Person", lastName: "Example", applications: ["not-approved"],
  }), (error) => error.status === 403 && error.code === "application_forbidden");
  assert.equal(keycloak.calls.length, 0);
});

test("cross-organization duplicate identities are refused", async () => {
  const keycloak = fakeKeycloak({
    findUserByEmail: async () => ({ id: "existing", emailVerified: false }),
    userOrganizations: async (userId) => userId === "existing" ? [{ id: "org-b" }] : [{ id: "org-a" }],
  });
  const service = new ControlTService(config, keycloak);
  await assert.rejects(() => service.createAndInvite(internal, "org-a", {
    email: "person@example.com", firstName: "Person", lastName: "Example", applications: [],
  }), (error) => error.status === 409 && error.code === "incompatible_identity");
});

test("failed email delivery rolls back a newly created identity", async () => {
  const keycloak = fakeKeycloak({ sendSetupEmail: async () => { throw new Error("relay unavailable"); } });
  const service = new ControlTService(config, keycloak);
  await assert.rejects(() => service.createAndInvite(internal, "org-a", {
    email: "person@example.com", firstName: "Person", lastName: "Example", applications: [],
  }), /relay unavailable/);
  assert.deepEqual(keycloak.calls.at(-1), ["deleteUser", "user-new"]);
});
