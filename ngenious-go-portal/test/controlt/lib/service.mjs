import { HttpError } from "./errors.mjs";
import { attributeValues } from "./keycloak.mjs";
import { createHash } from "node:crypto";

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
  if (!user.enabled) return "Disabled";
  return user.emailVerified ? "Active" : "Pending";
}

function audit(event) {
  process.stdout.write(`${JSON.stringify({ type: "controlt.audit", time: new Date().toISOString(), ...event })}\n`);
}

const opaqueEmailTarget = (email) => `email-sha256:${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;

export class ControlTService {
  constructor(config, keycloak) {
    this.config = config;
    this.keycloak = keycloak;
  }

  actorType(session) {
    if (session.roles.includes(this.config.internalAdminRole)) return "internal";
    if (session.roles.includes(this.config.customerAdminRole)) return "customer";
    throw new HttpError(403, "administrator_required", "Your account is not authorized to administer users.");
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
      throw new HttpError(409, existing.emailVerified ? "active_identity_exists" : "pending_identity_exists", existing.emailVerified ? "This person is already active in the organization." : "This person is already pending. Use Resend invitation.", { userId: existing.id });
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
        attributes: {
          "ngenious.invitedAt": [now],
          "ngenious.invitedBy": [session.sub],
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
    if (user.emailVerified) throw new HttpError(409, "member_already_active", "This person has already completed setup.");
    await this.keycloak.sendSetupEmail(userId, this.config.invitationLifespanSeconds);
    await this.keycloak.updateUser(userId, {
      attributes: {
        ...(user.attributes || {}),
        "ngenious.lastInvitationAt": [new Date().toISOString()],
        "ngenious.lastInvitationBy": [session.sub],
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
