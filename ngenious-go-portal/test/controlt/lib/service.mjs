import { HttpError } from "./errors.mjs";
import { attributeValues } from "./keycloak.mjs";
import { createHash, randomInt } from "node:crypto";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value, field, max = 120) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max) throw new HttpError(400, "invalid_input", `${field} is required and must be at most ${max} characters.`);
  return normalized;
}

function emailAddress(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  return email;
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(400, "invalid_input", `${field} must be a list.`);
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function statusOf(user) {
  if (user.enabled === false) return "Disabled";
  const requiredActions = Array.isArray(user.requiredActions) ? user.requiredActions : [];
  return requiredActions.includes("UPDATE_PASSWORD") || user.hasPasswordCredential === false ? "Pending" : "Active";
}

function audit(event) {
  process.stdout.write(`${JSON.stringify({ type: "controlt.audit", time: new Date().toISOString(), ...event })}\n`);
}

const opaqueEmailTarget = (email) => `email-sha256:${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;

function setupPassword() {
  const groups = [
    "abcdefghjkmnpqrstuvwxyz",
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "23456789",
    "!@#$%*-_=+",
  ];
  const all = groups.join("");
  const characters = groups.map((group) => group[randomInt(group.length)]);
  while (characters.length < 20) characters.push(all[randomInt(all.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [characters[index], characters[swap]] = [characters[swap], characters[index]];
  }
  return characters.join("");
}

export class ControlTService {
  constructor(config, keycloak) {
    this.config = config;
    this.keycloak = keycloak;
  }

  actorType(session) {
    if (session.roles.includes(this.config.internalAdminRole)) return "internal";
    if (session.roles.includes(this.config.customerAdminRole)) return "customer";
    throw new HttpError(403, "administrator_required", "Your account is not authorized to administer this team.");
  }

  async sessionForAdministrator(identity) {
    const client = await this.keycloak.client(this.config.oidcClientId);
    if (!client) throw new HttpError(500, "administrator_configuration_error", "Control administration is not configured correctly.");
    const assigned = await this.keycloak.userClientRoles(identity.sub, client.id);
    const allowed = new Set([this.config.internalAdminRole, this.config.customerAdminRole]);
    return { ...identity, roles: assigned.map((role) => role.name).filter((role) => allowed.has(role)) };
  }

  async permittedOrganizations(session) {
    const actorType = this.actorType(session);
    if (actorType === "internal") return this.keycloak.listOrganizations();
    const organizations = await this.keycloak.userOrganizations(session.sub);
    if (organizations.length !== 1) throw new HttpError(403, "organization_binding_error", "Your administrator account must be bound to exactly one organization. Contact ngenious support.");
    return organizations;
  }

  async organization(session, organizationId) {
    const organizations = await this.permittedOrganizations(session);
    const permitted = organizations.find((organization) => organization.id === organizationId);
    if (!permitted) throw new HttpError(403, "organization_forbidden", "You cannot administer this organization.");
    return this.keycloak.getOrganization(organizationId);
  }

  async applicationsFor(organization) {
    const clientIds = attributeValues(organization.attributes, this.config.allowedApplicationsAttribute).map((value) => value.trim()).filter(Boolean);
    return Promise.all(clientIds.map((clientId) => this.keycloak.application(clientId)));
  }

  async listOrganizations(session) {
    const organizations = await this.permittedOrganizations(session);
    return organizations.map(({ id, name, alias, enabled }) => ({ id, name, alias, enabled }));
  }

  async listApplications(session, organizationId) {
    const organization = await this.organization(session, organizationId);
    const applications = await this.applicationsFor(organization);
    return applications.map(({ clientId, name }) => ({ id: clientId, name }));
  }

  async assignedApplications(userId, applications) {
    const assignments = [];
    for (const application of applications) {
      const roles = await this.keycloak.userClientRoles(userId, application.id);
      if (roles.some((role) => role.name === application.role.name)) assignments.push(application.clientId);
    }
    return assignments;
  }

  async listMembers(session, organizationId) {
    const organization = await this.organization(session, organizationId);
    const applications = await this.applicationsFor(organization);
    const memberSummaries = await this.keycloak.organizationMembers(organizationId);
    const members = [];
    for (const summary of memberSummaries) {
      const user = await this.keycloak.getUser(summary.id);
      members.push({
        id: user.id,
        email: user.email || user.username,
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        status: statusOf(user),
        applications: await this.assignedApplications(user.id, applications),
      });
    }
    return members;
  }

  async team(session) {
    const actorType = this.actorType(session);
    const summaries = await this.permittedOrganizations(session);
    const organizations = await Promise.all(summaries.map((organization) => this.keycloak.getOrganization(organization.id)));
    const applicationMap = new Map();
    for (const organization of organizations) {
      for (const application of await this.applicationsFor(organization)) {
        const current = applicationMap.get(application.clientId) || { ...application, organizationIds: new Set() };
        current.organizationIds.add(organization.id);
        applicationMap.set(application.clientId, current);
      }
    }
    const applications = [...applicationMap.values()];
    const memberMap = new Map();
    for (const organization of organizations) {
      for (const summary of await this.keycloak.organizationMembers(organization.id)) {
        const current = memberMap.get(summary.id) || { id: summary.id, organizationIds: new Set() };
        current.organizationIds.add(organization.id);
        memberMap.set(summary.id, current);
      }
    }
    const members = [];
    for (const current of memberMap.values()) {
      const user = await this.keycloak.getUser(current.id);
      members.push({
        id: user.id,
        email: user.email || user.username,
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        status: statusOf(user),
        organizationIds: [...current.organizationIds],
        applications: await this.assignedApplications(user.id, applications),
      });
    }
    return {
      mode: actorType,
      organizations: organizations.map(({ id, name, alias, enabled }) => ({ id, name, alias, enabled })),
      applications: applications.map(({ clientId, name, organizationIds }) => ({ id: clientId, name, organizationIds: [...organizationIds] })),
      members,
    };
  }

  async resolveTeamSelection(session, input) {
    const actorType = this.actorType(session);
    const permitted = await this.permittedOrganizations(session);
    const requestedIds = stringArray(input.organizationIds, "organizationIds");
    const selectedIds = actorType === "customer" ? [permitted[0].id] : requestedIds;
    if (!selectedIds.length) throw new HttpError(400, "organization_required", "Choose at least one organization.");
    const permittedMap = new Map(permitted.map((organization) => [organization.id, organization]));
    if (requestedIds.some((id) => !permittedMap.has(id)) || (actorType === "customer" && requestedIds.some((id) => id !== permitted[0].id))) {
      throw new HttpError(403, "organization_forbidden", "One or more organizations are not available to this administrator.");
    }
    const organizations = await Promise.all(selectedIds.map((id) => this.keycloak.getOrganization(id)));
    const applicationMap = new Map();
    for (const organization of organizations) {
      for (const application of await this.applicationsFor(organization)) applicationMap.set(application.clientId, application);
    }
    const applications = [...applicationMap.values()];
    return { actorType, permitted, organizations, organizationIds: selectedIds, applications };
  }

  async addTeamMember(session, input) {
    const selection = await this.resolveTeamSelection(session, input);
    const selected = this.validateApplications(input.applications || [], selection.applications);
    const email = emailAddress(input.email);
    const firstName = text(input.firstName, "First name");
    const lastName = text(input.lastName, "Last name");
    const existing = await this.keycloak.findUserByEmail(email);
    if (existing) {
      const memberships = await this.keycloak.userOrganizations(existing.id);
      if (selection.actorType === "customer" && !memberships.some((organization) => organization.id === selection.organizationIds[0])) {
        throw new HttpError(409, "incompatible_identity", "This email belongs to an identity outside your organization. Contact ngenious support.");
      }
      const addedOrganizationIds = [];
      try {
        for (const organizationId of selection.organizationIds) {
          if (!memberships.some((organization) => organization.id === organizationId)) {
            await this.keycloak.addOrganizationMember(organizationId, existing.id);
            addedOrganizationIds.push(organizationId);
          }
        }
        await this.applyApplications(existing.id, selected, selection.applications);
        if (statusOf(existing) === "Pending") {
          await this.keycloak.sendSetupEmail(existing.id, this.config.invitationLifespanSeconds);
          await this.keycloak.updateUser(existing.id, {
            attributes: { ...(existing.attributes || {}), "ngenious.setupMethod": ["email-invitation"] },
          });
        }
      } catch (error) {
        for (const organizationId of addedOrganizationIds.reverse()) {
          try { await this.keycloak.removeOrganizationMember(organizationId, existing.id); } catch {}
        }
        audit({ outcome: "failed", operation: "assign_existing_member", actor: session.sub, target: existing.id, organizations: selection.organizationIds });
        throw error;
      }
      audit({ outcome: "success", operation: "assign_existing_member", actor: session.sub, target: existing.id, organizations: selection.organizationIds });
      return {
        id: existing.id,
        email,
        status: statusOf(existing),
        created: false,
        invitationSent: statusOf(existing) === "Pending",
      };
    }

    let userId;
    try {
      const now = new Date().toISOString();
      userId = await this.keycloak.createUser({
        username: email, email, firstName, lastName, enabled: true, emailVerified: false,
        requiredActions: ["UPDATE_PASSWORD"],
        attributes: {
          "ngenious.invitedAt": [now],
          "ngenious.invitedBy": [session.sub],
          "ngenious.setupMethod": ["email-invitation"],
        },
      });
      for (const organizationId of selection.organizationIds) await this.keycloak.addOrganizationMember(organizationId, userId);
      await this.applyApplications(userId, selected, selection.applications);
      await this.keycloak.sendSetupEmail(userId, this.config.invitationLifespanSeconds);
      audit({ outcome: "success", operation: "create_team_member", actor: session.sub, target: userId, organizations: selection.organizationIds });
      return { id: userId, email, status: "Pending", created: true, invitationSent: true };
    } catch (error) {
      if (userId) {
        try { await this.keycloak.deleteUser(userId); } catch {}
      }
      audit({ outcome: "failed", operation: "create_team_member", actor: session.sub, target: userId || opaqueEmailTarget(email), organizations: selection.organizationIds });
      throw error;
    }
  }

  async teamMember(session, userId) {
    const permitted = await this.permittedOrganizations(session);
    const memberships = await this.keycloak.userOrganizations(userId);
    if (!memberships.some((membership) => permitted.some((organization) => organization.id === membership.id))) {
      throw new HttpError(404, "member_not_found", "The team member was not found.");
    }
    return { user: await this.keycloak.getUser(userId), memberships, permitted };
  }

  async updateTeamMember(session, userId, input) {
    const actorType = this.actorType(session);
    const current = await this.teamMember(session, userId);
    const requestedOrganizationIds = actorType === "customer"
      ? [current.permitted[0].id]
      : stringArray(input.organizationIds, "organizationIds");
    const selection = await this.resolveTeamSelection(session, { organizationIds: requestedOrganizationIds });
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new HttpError(400, "invalid_input", "enabled must be true or false.");
      await this.keycloak.updateUser(userId, { enabled: input.enabled });
    }
    if (actorType === "internal") {
      const selectedIds = new Set(selection.organizationIds);
      for (const organization of current.memberships) {
        if (!selectedIds.has(organization.id)) await this.keycloak.removeOrganizationMember(organization.id, userId);
      }
      for (const organizationId of selection.organizationIds) {
        if (!current.memberships.some((organization) => organization.id === organizationId)) await this.keycloak.addOrganizationMember(organizationId, userId);
      }
    }
    const manageableMap = new Map();
    for (const organization of await Promise.all(current.permitted.map((item) => this.keycloak.getOrganization(item.id)))) {
      for (const application of await this.applicationsFor(organization)) manageableMap.set(application.clientId, application);
    }
    let selectedApplications = await this.assignedApplications(userId, selection.applications);
    if (input.applications !== undefined) {
      const resolved = this.validateApplications(input.applications, selection.applications);
      await this.applyApplications(userId, resolved, [...manageableMap.values()]);
      selectedApplications = resolved.map((application) => application.clientId);
    }
    audit({ outcome: "success", operation: "update_team_member", actor: session.sub, target: userId, organizations: selection.organizationIds });
    return {
      id: userId,
      enabled: input.enabled ?? current.user.enabled,
      status: statusOf({ ...current.user, enabled: input.enabled ?? current.user.enabled }),
      organizationIds: selection.organizationIds,
      applications: selectedApplications,
    };
  }

  async resendTeamInvitation(session, userId) {
    const { user } = await this.teamMember(session, userId);
    if (!user.enabled) throw new HttpError(409, "member_disabled", "Enable this person before resending the invitation.");
    if (statusOf(user) !== "Pending") throw new HttpError(409, "member_already_active", "This person has already completed setup.");
    await this.keycloak.sendSetupEmail(userId, this.config.invitationLifespanSeconds);
    await this.keycloak.updateUser(userId, {
      attributes: { ...(user.attributes || {}), "ngenious.setupMethod": ["email-invitation"] },
    });
    return { id: userId, email: user.email || user.username, status: "Pending" };
  }

  async generateSetupPassword(session, userId) {
    const { user } = await this.teamMember(session, userId);
    if (!user.enabled) throw new HttpError(409, "member_disabled", "Enable this person before generating a setup password.");
    if (statusOf(user) !== "Pending") throw new HttpError(409, "member_already_active", "This person has already completed setup.");
    const password = setupPassword();
    try {
      await this.keycloak.setTemporaryPassword(userId, password);
      const originalRequiredActions = Array.isArray(user.requiredActions) ? user.requiredActions : [];
      const requiredActions = [...new Set([
        ...originalRequiredActions.filter((action) => action !== "VERIFY_EMAIL"),
        "UPDATE_PASSWORD",
      ])];
      await this.keycloak.updateUser(userId, {
        requiredActions,
        attributes: {
          ...(user.attributes || {}),
          "ngenious.setupMethod": ["temporary-password"],
          "ngenious.setupPasswordIssuedAt": [new Date().toISOString()],
        },
      });
      audit({ outcome: "success", operation: "generate_setup_password", actor: session.sub, target: userId });
      return { id: userId, email: user.email || user.username, setupPassword: password, temporary: true };
    } catch (error) {
      audit({ outcome: "failed", operation: "generate_setup_password", actor: session.sub, target: userId });
      throw error;
    }
  }

  async deleteTeamMember(session, userId) {
    if (this.actorType(session) !== "internal") {
      throw new HttpError(403, "internal_administrator_required", "Only an ngenious administrator can permanently delete an account.");
    }
    if (userId === session.sub) throw new HttpError(409, "self_delete_forbidden", "You cannot delete your own administrator account.");
    const { user, memberships } = await this.teamMember(session, userId);
    await this.keycloak.deleteUser(userId);
    audit({ outcome: "success", operation: "remove_platform_account", actor: session.sub, target: userId, organizations: memberships.map(({ id }) => id) });
    return { id: userId, email: user.email || user.username, deleted: true, removedFromPlatform: true };
  }

  validateApplications(requested, applications) {
    const ids = stringArray(requested, "applications");
    const allowed = new Map(applications.map((application) => [application.clientId, application]));
    const invalid = ids.filter((id) => !allowed.has(id));
    if (invalid.length) throw new HttpError(403, "application_forbidden", "One or more applications are not approved for this organization.", { applications: invalid });
    return ids.map((id) => allowed.get(id));
  }

  async ensureMembership(userId, organizationId) {
    const memberships = await this.keycloak.userOrganizations(userId);
    return memberships.some((organization) => organization.id === organizationId);
  }

  async applyApplications(userId, selected, allowedApplications) {
    const selectedIds = new Set(selected.map((application) => application.clientId));
    for (const application of allowedApplications) {
      const roles = await this.keycloak.userClientRoles(userId, application.id);
      const assigned = roles.some((role) => role.name === application.role.name);
      if (selectedIds.has(application.clientId) && !assigned) await this.keycloak.addClientRole(userId, application.id, application.role);
      if (!selectedIds.has(application.clientId) && assigned) await this.keycloak.removeClientRole(userId, application.id, application.role);
    }
  }

  async createAndInvite(session, organizationId, input) {
    const organization = await this.organization(session, organizationId);
    const allowedApplications = await this.applicationsFor(organization);
    const selected = this.validateApplications(input.applications || [], allowedApplications);
    const email = emailAddress(input.email);
    const firstName = text(input.firstName, "First name");
    const lastName = text(input.lastName, "Last name");
    const existing = await this.keycloak.findUserByEmail(email);
    if (existing) {
      const member = await this.ensureMembership(existing.id, organizationId);
      if (!member) throw new HttpError(409, "incompatible_identity", "This email already belongs to another or unassigned identity. Contact ngenious support.");
      const existingStatus = statusOf(existing);
      throw new HttpError(409, existingStatus === "Active" ? "active_identity_exists" : "pending_identity_exists", existingStatus === "Active" ? "This person is already active in the organization." : "This person is already pending. Use Resend invitation.", { userId: existing.id });
    }

    let userId;
    try {
      const now = new Date().toISOString();
      userId = await this.keycloak.createUser({
        username: email,
        email,
        firstName,
        lastName,
        enabled: true,
        emailVerified: false,
        requiredActions: ["UPDATE_PASSWORD"],
        attributes: {
          "ngenious.invitedAt": [now],
          "ngenious.invitedBy": [session.sub],
          "ngenious.setupMethod": ["email-invitation"],
        },
      });
      await this.keycloak.addOrganizationMember(organizationId, userId);
      await this.applyApplications(userId, selected, allowedApplications);
      await this.keycloak.sendSetupEmail(userId, this.config.invitationLifespanSeconds);
      audit({ outcome: "success", operation: "create_and_invite", actor: session.sub, target: userId, organization: organizationId });
      return { id: userId, email, status: "Pending", applications: selected.map((application) => application.clientId), expiresInSeconds: this.config.invitationLifespanSeconds };
    } catch (error) {
      if (userId) {
        try { await this.keycloak.deleteUser(userId); } catch (rollbackError) {
          audit({ outcome: "rollback_failed", operation: "create_and_invite", actor: session.sub, target: userId, organization: organizationId });
        }
      }
      audit({ outcome: "failed", operation: "create_and_invite", actor: session.sub, target: userId || opaqueEmailTarget(email), organization: organizationId });
      throw error;
    }
  }

  async member(session, organizationId, userId) {
    await this.organization(session, organizationId);
    if (!(await this.ensureMembership(userId, organizationId))) throw new HttpError(404, "member_not_found", "The organization member was not found.");
    return this.keycloak.getUser(userId);
  }

  async resendInvitation(session, organizationId, userId) {
    const user = await this.member(session, organizationId, userId);
    if (!user.enabled) throw new HttpError(409, "member_disabled", "Enable this person before resending the invitation.");
    if (statusOf(user) !== "Pending") throw new HttpError(409, "member_already_active", "This person has already completed setup.");
    await this.keycloak.sendSetupEmail(userId, this.config.invitationLifespanSeconds);
    await this.keycloak.updateUser(userId, {
      attributes: {
        ...(user.attributes || {}),
        "ngenious.lastInvitationAt": [new Date().toISOString()],
        "ngenious.lastInvitationBy": [session.sub],
        "ngenious.setupMethod": ["email-invitation"],
      },
    });
    audit({ outcome: "success", operation: "resend_invitation", actor: session.sub, target: userId, organization: organizationId });
    return { id: userId, email: user.email || user.username, status: "Pending", expiresInSeconds: this.config.invitationLifespanSeconds };
  }

  async updateMember(session, organizationId, userId, input) {
    const organization = await this.organization(session, organizationId);
    const user = await this.member(session, organizationId, userId);
    const applications = await this.applicationsFor(organization);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new HttpError(400, "invalid_input", "enabled must be true or false.");
      await this.keycloak.updateUser(userId, { enabled: input.enabled });
    }
    let selected = await this.assignedApplications(userId, applications);
    if (input.applications !== undefined) {
      const resolved = this.validateApplications(input.applications, applications);
      await this.applyApplications(userId, resolved, applications);
      selected = resolved.map((application) => application.clientId);
    }
    audit({ outcome: "success", operation: "update_member", actor: session.sub, target: userId, organization: organizationId });
    return { id: userId, enabled: input.enabled ?? user.enabled, status: input.enabled === false ? "Disabled" : statusOf({ ...user, enabled: input.enabled ?? user.enabled }), applications: selected };
  }
}
