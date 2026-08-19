const state = {
  session: null,
  csrf: null,
  organizations: [],
  organization: null,
  applications: [],
  members: [],
  editingMember: null,
  loadSequence: 0,
};

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "signin-panel", "workspace", "loading-panel", "user-menu", "user-menu-button", "user-menu-popover",
  "menu-user-name", "menu-user-email", "sign-out-button", "organization-picker", "organization-select",
  "organization-description", "add-user-button", "error-notice", "error-message", "retry-button",
  "total-count", "pending-count", "active-count", "member-search", "result-count", "member-list",
  "empty-state", "empty-title", "empty-copy", "add-user-dialog", "add-user-form", "add-application-options",
  "add-user-error", "create-user-button", "access-dialog", "access-form", "access-user",
  "edit-application-options", "access-error", "save-access-button", "toast",
].map((id) => [id, byId(id)]));

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || "The request could not be completed.");
    this.status = status;
    this.code = body?.error;
    this.details = body?.details;
  }
}

async function api(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.method && options.method !== "GET") headers["x-controlt-csrf"] = state.csrf;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function initials(name, email) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts.at(-1)[0]}`.toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return String(email || "NG").slice(0, 2).toUpperCase();
}

function showAuthenticated() {
  const user = state.session.user;
  elements["loading-panel"].hidden = true;
  elements["signin-panel"].hidden = true;
  elements.workspace.hidden = false;
  elements["user-menu"].hidden = false;
  elements["user-menu-button"].textContent = initials(user.name, user.email);
  elements["menu-user-name"].textContent = user.name || "Administrator";
  elements["menu-user-email"].textContent = user.email || "";
}

function showSignin() {
  elements["loading-panel"].hidden = true;
  elements.workspace.hidden = true;
  elements["user-menu"].hidden = true;
  elements["signin-panel"].hidden = false;
}

function showError(error) {
  elements["error-message"].textContent = error?.message || "ControlT could not load this organization.";
  elements["error-notice"].hidden = false;
}

function clearError() {
  elements["error-notice"].hidden = true;
  elements["error-message"].textContent = "";
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 5000);
}

function setFormError(element, error) {
  element.textContent = error?.message || "The request could not be completed.";
  element.hidden = false;
}

function optionList(container, selected = []) {
  container.replaceChildren();
  if (!state.applications.length) {
    const empty = document.createElement("p");
    empty.className = "none";
    empty.textContent = "No applications are available for this organization.";
    container.append(empty);
    return;
  }
  for (const application of state.applications) {
    const label = document.createElement("label");
    label.className = "application-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "applications";
    input.value = application.id;
    input.checked = selected.includes(application.id);
    const name = document.createElement("span");
    name.textContent = application.name;
    label.append(input, name);
    container.append(label);
  }
}

function applicationTags(member) {
  const container = document.createElement("div");
  container.className = "application-tags";
  const names = new Map(state.applications.map((application) => [application.id, application.name]));
  if (!member.applications.length) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = "No access";
    container.append(none);
    return container;
  }
  for (const id of member.applications) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = names.get(id) || id;
    container.append(tag);
  }
  return container;
}

function actionButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button small ${className}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderMembers() {
  const query = elements["member-search"].value.trim().toLowerCase();
  const filtered = state.members.filter((member) => `${member.firstName} ${member.lastName} ${member.email}`.toLowerCase().includes(query));
  elements["member-list"].replaceChildren();
  elements["member-list"].hidden = filtered.length === 0;
  elements["empty-state"].hidden = filtered.length !== 0;
  elements["result-count"].textContent = `${filtered.length} ${filtered.length === 1 ? "person" : "people"}`;

  if (!filtered.length) {
    elements["empty-title"].textContent = state.members.length ? "No matching people" : "No people yet";
    elements["empty-copy"].textContent = state.members.length ? "Try a different name or email." : "Add the first person to this organization.";
  } else {
    const header = document.createElement("div");
    header.className = "member-row header";
    for (const label of ["Person", "Status", "Applications", "Actions"]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      header.append(cell);
    }
    elements["member-list"].append(header);
  }

  for (const member of filtered) {
    const row = document.createElement("article");
    row.className = "member-row";
    const person = document.createElement("div");
    person.className = "person";
    const name = document.createElement("strong");
    name.textContent = `${member.firstName} ${member.lastName}`.trim() || member.email;
    const email = document.createElement("span");
    email.textContent = member.email;
    person.append(name, email);

    const status = document.createElement("span");
    status.className = `status ${member.status.toLowerCase()}`;
    status.textContent = member.status;

    const actions = document.createElement("div");
    actions.className = "actions";
    if (member.status === "Pending") {
      actions.append(actionButton("Resend invitation", "secondary", (event) => resendInvitation(member, event.currentTarget)));
    }
    if (state.applications.length) {
      actions.append(actionButton("Manage access", "secondary", () => openAccess(member)));
    }
    const enable = member.status === "Disabled";
    actions.append(actionButton(enable ? "Enable" : "Disable", enable ? "secondary" : "danger", () => changeEnabled(member, enable)));
    row.append(person, status, applicationTags(member), actions);
    elements["member-list"].append(row);
  }

  elements["total-count"].textContent = state.members.length;
  elements["pending-count"].textContent = state.members.filter((member) => member.status === "Pending").length;
  elements["active-count"].textContent = state.members.filter((member) => member.status === "Active").length;
}

function renderLoadingRows() {
  elements["member-list"].hidden = false;
  elements["empty-state"].hidden = true;
  elements["member-list"].replaceChildren();
  const row = document.createElement("div");
  row.className = "member-row";
  const copy = document.createElement("span");
  copy.className = "muted";
  copy.textContent = "Loading people…";
  row.append(copy);
  elements["member-list"].append(row);
  for (const id of ["total-count", "pending-count", "active-count"]) elements[id].textContent = "–";
}

async function loadOrganization(organizationId) {
  const sequence = ++state.loadSequence;
  clearError();
  renderLoadingRows();
  state.organization = state.organizations.find((organization) => organization.id === organizationId);
  elements["organization-description"].textContent = state.organization ? `Manage people and access for ${state.organization.name}.` : "Manage people and application access.";
  try {
    const [applications, members] = await Promise.all([
      api(`/api/organizations/${encodeURIComponent(organizationId)}/applications`),
      api(`/api/organizations/${encodeURIComponent(organizationId)}/members`),
    ]);
    if (sequence !== state.loadSequence) return;
    state.applications = applications.applications;
    state.members = members.members;
    renderMembers();
  } catch (error) {
    if (sequence !== state.loadSequence) return;
    showError(error);
    state.applications = [];
    state.members = [];
    renderMembers();
  }
}

function renderOrganizations() {
  const select = elements["organization-select"];
  select.replaceChildren();
  for (const organization of state.organizations) {
    const option = document.createElement("option");
    option.value = organization.id;
    option.textContent = organization.name || organization.alias;
    select.append(option);
  }
  elements["organization-picker"].hidden = state.organizations.length < 2;
}

async function initialize() {
  elements["loading-panel"].hidden = false;
  elements["signin-panel"].hidden = true;
  elements.workspace.hidden = true;
  try {
    state.session = await api("/api/session");
    state.csrf = state.session.csrf;
    const organizations = await api("/api/organizations");
    state.organizations = organizations.organizations;
    if (!state.organizations.length) throw new Error("No organizations are assigned to this administrator.");
    renderOrganizations();
    showAuthenticated();
    await loadOrganization(state.organizations[0].id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return showSignin();
    showAuthenticated();
    showError(error);
  }
}

function selectedApplications(container) {
  return [...container.querySelectorAll('input[name="applications"]:checked')].map((input) => input.value);
}

function openAddUser() {
  elements["add-user-form"].reset();
  elements["add-user-error"].hidden = true;
  optionList(elements["add-application-options"]);
  elements["add-user-dialog"].showModal();
  elements["add-user-form"].elements.firstName.focus();
}

function openAccess(member) {
  state.editingMember = member;
  elements["access-error"].hidden = true;
  elements["access-user"].textContent = `Choose applications for ${`${member.firstName} ${member.lastName}`.trim() || member.email}.`;
  optionList(elements["edit-application-options"], member.applications);
  elements["access-dialog"].showModal();
}

async function submitAddUser(event) {
  event.preventDefault();
  elements["add-user-error"].hidden = true;
  const form = new FormData(elements["add-user-form"]);
  elements["create-user-button"].disabled = true;
  try {
    await api(`/api/organizations/${encodeURIComponent(state.organization.id)}/users`, {
      method: "POST",
      body: {
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        email: form.get("email"),
        applications: selectedApplications(elements["add-application-options"]),
      },
    });
    elements["add-user-dialog"].close();
    toast(`Invitation sent to ${form.get("email")}.`);
    await loadOrganization(state.organization.id);
  } catch (error) {
    setFormError(elements["add-user-error"], error);
  } finally {
    elements["create-user-button"].disabled = false;
  }
}

async function submitAccess(event) {
  event.preventDefault();
  elements["access-error"].hidden = true;
  elements["save-access-button"].disabled = true;
  try {
    await api(`/api/organizations/${encodeURIComponent(state.organization.id)}/users/${encodeURIComponent(state.editingMember.id)}`, {
      method: "PATCH",
      body: { applications: selectedApplications(elements["edit-application-options"]) },
    });
    elements["access-dialog"].close();
    toast("Application access updated.");
    await loadOrganization(state.organization.id);
  } catch (error) {
    setFormError(elements["access-error"], error);
  } finally {
    elements["save-access-button"].disabled = false;
  }
}

async function resendInvitation(member, button) {
  if (button) button.disabled = true;
  try {
    await api(`/api/organizations/${encodeURIComponent(state.organization.id)}/users/${encodeURIComponent(member.id)}/resend`, { method: "POST" });
    toast(`A new invitation was sent to ${member.email}.`);
  } catch (error) {
    showError(error);
  } finally {
    if (button) button.disabled = false;
  }
}

async function changeEnabled(member, enabled) {
  try {
    await api(`/api/organizations/${encodeURIComponent(state.organization.id)}/users/${encodeURIComponent(member.id)}`, {
      method: "PATCH", body: { enabled },
    });
    toast(`${member.email} is now ${enabled ? "enabled" : "disabled"}.`);
    await loadOrganization(state.organization.id);
  } catch (error) {
    showError(error);
  }
}

elements["user-menu-button"].addEventListener("click", () => {
  const open = elements["user-menu-popover"].hidden;
  elements["user-menu-popover"].hidden = !open;
  elements["user-menu-button"].setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (!elements["user-menu"].contains(event.target)) {
    elements["user-menu-popover"].hidden = true;
    elements["user-menu-button"].setAttribute("aria-expanded", "false");
  }
});
elements["sign-out-button"].addEventListener("click", async () => {
  try {
    const result = await api("/auth/logout", { method: "POST" });
    location.assign(result.redirect || "/");
  } catch {
    location.assign("/");
  }
});
elements["organization-select"].addEventListener("change", (event) => loadOrganization(event.target.value));
elements["member-search"].addEventListener("input", renderMembers);
elements["add-user-button"].addEventListener("click", openAddUser);
elements["add-user-form"].addEventListener("submit", submitAddUser);
elements["access-form"].addEventListener("submit", submitAccess);
elements["retry-button"].addEventListener("click", () => state.organization ? loadOrganization(state.organization.id) : initialize());
for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", () => byId(button.dataset.closeDialog).close());
}
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}

initialize();
