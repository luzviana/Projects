import { HttpError } from "./errors.mjs";

export class KeycloakApiError extends Error {
  constructor(status, message, responseBody) {
    super(message);
    this.name = "KeycloakApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class KeycloakAdmin {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.adminBase = `${config.keycloakInternalUrl}/admin/realms/${encodeURIComponent(config.realm)}`;
  }

  async accessToken(force = false) {
    if (!force && this.token && this.tokenExpiresAt > Date.now() + 15_000) return this.token;
    const response = await this.fetch(`${this.config.keycloakInternalUrl}/realms/${encodeURIComponent(this.config.realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.serviceClientId,
        client_secret: this.config.serviceClientSecret,
      }),
    });
    if (!response.ok) throw new Error(`Keycloak service authentication failed with HTTP ${response.status}`);
    const body = await response.json();
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(30, body.expires_in || 60) * 1000;
    return this.token;
  }

  async request(path, { method = "GET", body, expected = [200], retry = true } = {}) {
    const response = await this.fetch(`${this.adminBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && retry) {
      await this.accessToken(true);
      return this.request(path, { method, body, expected, retry: false });
    }
    if (!expected.includes(response.status)) {
      const responseBody = await response.text();
      throw new KeycloakApiError(response.status, `Keycloak request failed with HTTP ${response.status}`, responseBody.slice(0, 1000));
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") return null;
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("json") ? response.json() : response.text();
  }

  listOrganizations() {
    return this.request("/organizations?first=0&max=200");
  }

  getOrganization(id) {
    return this.request(`/organizations/${encodeURIComponent(id)}`);
  }

  userOrganizations(userId) {
    return this.request(`/users/${encodeURIComponent(userId)}/organizations`);
  }

  organizationMembers(organizationId) {
    return this.request(`/organizations/${encodeURIComponent(organizationId)}/members?first=0&max=200`);
  }

  addOrganizationMember(organizationId, userId) {
    return this.request(`/organizations/${encodeURIComponent(organizationId)}/members`, { method: "POST", body: userId, expected: [201, 204] });
  }

  async findUserByEmail(email) {
    const matches = await this.request(`/users?exact=true&username=${encodeURIComponent(email)}&max=2`);
    return matches.find((user) => user.username?.toLowerCase() === email) || null;
  }

  getUser(userId) {
    return this.request(`/users/${encodeURIComponent(userId)}`);
  }

  async createUser(user, retry = true) {
    const token = await this.accessToken();
    const response = await this.fetch(`${this.adminBase}/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(user),
    });
    if (response.status === 401 && retry) {
      await this.accessToken(true);
      return this.createUser(user, false);
    }
    if (response.status !== 201) throw new KeycloakApiError(response.status, `Keycloak user creation failed with HTTP ${response.status}`, (await response.text()).slice(0, 1000));
    const location = response.headers.get("location");
    const id = location?.split("/").pop();
    if (!id) throw new Error("Keycloak did not return the created user identifier");
    return id;
  }

  updateUser(userId, representation) {
    return this.request(`/users/${encodeURIComponent(userId)}`, { method: "PUT", body: representation, expected: [204] });
  }

  deleteUser(userId) {
    return this.request(`/users/${encodeURIComponent(userId)}`, { method: "DELETE", expected: [204] });
  }

  sendSetupEmail(userId, lifespanSeconds) {
    return this.request(`/users/${encodeURIComponent(userId)}/execute-actions-email?lifespan=${lifespanSeconds}`, {
      method: "PUT",
      body: ["VERIFY_EMAIL", "UPDATE_PASSWORD"],
      expected: [204],
    });
  }

  async application(clientId) {
    const client = await this.client(clientId);
    if (!client || client.enabled === false || client.protocol !== "openid-connect") {
      throw new HttpError(500, "application_configuration_error", `Application ${clientId} is not configured for ControlT.`);
    }
    let role;
    try {
      role = await this.request(`/clients/${encodeURIComponent(client.id)}/roles/${encodeURIComponent(this.config.applicationRole)}`);
    } catch (error) {
      if (error instanceof KeycloakApiError && error.status === 404) {
        throw new HttpError(500, "application_configuration_error", `Application ${clientId} is missing its ControlT access role.`);
      }
      throw error;
    }
    return { id: client.id, clientId, name: client.name || clientId, role };
  }

  async client(clientId) {
    const clients = await this.request(`/clients?clientId=${encodeURIComponent(clientId)}`);
    return clients.find((candidate) => candidate.clientId === clientId) || null;
  }

  userClientRoles(userId, clientUuid) {
    return this.request(`/users/${encodeURIComponent(userId)}/role-mappings/clients/${encodeURIComponent(clientUuid)}`);
  }

  addClientRole(userId, clientUuid, role) {
    return this.request(`/users/${encodeURIComponent(userId)}/role-mappings/clients/${encodeURIComponent(clientUuid)}`, {
      method: "POST", body: [role], expected: [204],
    });
  }

  removeClientRole(userId, clientUuid, role) {
    return this.request(`/users/${encodeURIComponent(userId)}/role-mappings/clients/${encodeURIComponent(clientUuid)}`, {
      method: "DELETE", body: [role], expected: [204],
    });
  }
}

export function attributeValues(attributes, name) {
  const raw = attributes?.[name];
  if (Array.isArray(raw)) return raw.flatMap((value) => String(value).split(","));
  if (raw == null) return [];
  return String(raw).split(",");
}
