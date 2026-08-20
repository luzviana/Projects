const state = { session: null, csrf: null, mode: null, organizations: [], applications: [], members: [], editingMember: null, deletingMember: null };
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "signin-panel", "workspace", "loading-panel", "user-menu", "user-menu-button", "user-menu-popover",
  "menu-user-name", "menu-user-email", "sign-out-button", "organization-description", "add-user-button",
  "error-notice", "error-message", "retry-button", "total-count", "pending-count", "active-count",
  "member-search", "result-count", "member-list", "empty-state", "empty-title", "empty-copy",
  "add-user-dialog", "add-user-form", "add-organization-fieldset", "add-organization-options",
  "add-application-options", "add-user-error", "create-user-button", "access-dialog", "access-form",
  "access-user", "edit-organization-fieldset", "edit-organization-options", "edit-application-options",
  "access-error", "save-access-button", "delete-user-dialog", "delete-user-form", "delete-user-name",
  "delete-user-organizations", "delete-user-error", "confirm-delete-user-button", "toast",
].map((id) => [id, byId(id)]));

class ApiError extends Error {
  constructor(status, body) { super(body?.message || "The request could not be completed."); this.status = status; this.code = body?.error; }
}

async function api(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.method && options.method !== "GET") headers["x-controlt-csrf"] = state.csrf;
  const response = await fetch(path, { ...options, credentials: "same-origin", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
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

function showSignin() { elements["loading-panel"].hidden = true; elements.workspace.hidden = true; elements["user-menu"].hidden = true; elements["signin-panel"].hidden = false; }
function showError(error) { elements["error-message"].textContent = error?.message || "Control could not load the team."; elements["error-notice"].hidden = false; }
function clearError() { elements["error-notice"].hidden = true; elements["error-message"].textContent = ""; }
function setFormError(element, error) { element.textContent = error?.message || "The request could not be completed."; element.hidden = false; }

let toastTimer;
function toast(message) { clearTimeout(toastTimer); elements.toast.textContent = message; elements.toast.hidden = false; toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 5000); }
function selected(container, name) { return [...container.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value); }
const organizationNames = () => new Map(state.organizations.map((organization) => [organization.id, organization.name || organization.alias]));
const applicationNames = () => new Map(state.applications.map((application) => [application.id, application.name]));

function checkboxList(container, items, name, chosen = [], disabled = () => false) {
  container.replaceChildren();
  for (const item of items) {
    const label = document.createElement("label"); label.className = "application-option";
    const input = document.createElement("input"); input.type = "checkbox"; input.name = name; input.value = item.id; input.checked = chosen.includes(item.id); input.disabled = disabled(item);
    const text = document.createElement("span"); text.textContent = item.name || item.alias || item.id;
    label.append(input, text); container.append(label);
  }
  if (!items.length) { const empty = document.createElement("p"); empty.className = "none"; empty.textContent = "None available."; container.append(empty); }
}

function enabledApplications(organizationIds) {
  const ids = new Set(organizationIds);
  return state.applications.filter((application) => application.organizationIds.some((id) => ids.has(id)));
}

function syncApplicationOptions(organizationContainer, applicationContainer, chosen = []) {
  const organizationIds = selected(organizationContainer, "organizations");
  const available = enabledApplications(organizationIds);
  checkboxList(applicationContainer, state.applications, "applications", chosen, (application) => !available.some((item) => item.id === application.id));
}

function tags(ids, names, className) {
  const container = document.createElement("div"); container.className = `${className}-tags`;
  if (!ids.length) { const none = document.createElement("span"); none.className = "none"; none.textContent = "None"; container.append(none); return container; }
  for (const id of ids) { const tag = document.createElement("span"); tag.className = className === "organization" ? "organization-tag" : "tag"; tag.textContent = names.get(id) || id; container.append(tag); }
  return container;
}

function actionButton(label, className, action) {
  const button = document.createElement("button"); button.type = "button"; button.className = `button small ${className}`; button.textContent = label; button.addEventListener("click", action); return button;
}

function renderMembers() {
  const query = elements["member-search"].value.trim().toLowerCase();
  const filtered = state.members.filter((member) => `${member.firstName} ${member.lastName} ${member.email}`.toLowerCase().includes(query));
  elements["member-list"].replaceChildren(); elements["member-list"].hidden = filtered.length === 0; elements["empty-state"].hidden = filtered.length !== 0;
  elements["result-count"].textContent = `${filtered.length} ${filtered.length === 1 ? "team member" : "team members"}`;
  if (!filtered.length) {
    elements["empty-title"].textContent = state.members.length ? "No matching team members" : "No team members yet";
    elements["empty-copy"].textContent = state.members.length ? "Try a different name or email." : "Add the first member of this team.";
  } else {
    const header = document.createElement("div"); header.className = `member-row header ${state.mode}`;
    const labels = state.mode === "internal" ? ["Team member", "Organizations", "Status", "Applications", "Actions"] : ["Team member", "Status", "Applications", "Actions"];
    for (const label of labels) { const cell = document.createElement("span"); cell.textContent = label; header.append(cell); }
    elements["member-list"].append(header);
  }
  const orgNames = organizationNames(); const appNames = applicationNames();
  for (const member of filtered) {
    const row = document.createElement("article"); row.className = `member-row ${state.mode}`;
    const person = document.createElement("div"); person.className = "person";
    const name = document.createElement("strong"); name.textContent = `${member.firstName} ${member.lastName}`.trim() || member.email;
    const email = document.createElement("span"); email.textContent = member.email; person.append(name, email);
    const status = document.createElement("span"); status.className = `status ${member.status.toLowerCase()}`; status.textContent = member.status;
    const actions = document.createElement("div"); actions.className = "actions";
    if (member.status === "Pending") actions.append(actionButton("Resend invitation", "secondary", (event) => resendInvitation(member, event.currentTarget)));
    actions.append(actionButton(state.mode === "internal" ? "Manage" : "Manage access", "secondary", () => openAccess(member)));
    const enable = member.status === "Disabled"; actions.append(actionButton(enable ? "Enable" : "Disable", enable ? "secondary" : "danger", () => changeEnabled(member, enable)));
    if (state.mode === "internal" && member.id !== state.session.user.sub) actions.append(actionButton("Delete", "danger", () => openDelete(member)));
    row.append(person);
    if (state.mode === "internal") row.append(tags(member.organizationIds, orgNames, "organization"));
    row.append(status, tags(member.applications, appNames, "application"), actions);
    elements["member-list"].append(row);
  }
  elements["total-count"].textContent = state.members.length;
  elements["pending-count"].textContent = state.members.filter((member) => member.status === "Pending").length;
  elements["active-count"].textContent = state.members.filter((member) => member.status === "Active").length;
}

function renderLoading() {
  elements["member-list"].hidden = false; elements["empty-state"].hidden = true; elements["member-list"].replaceChildren();
  const row = document.createElement("div"); row.className = "member-row"; row.textContent = "Loading team…"; elements["member-list"].append(row);
  for (const id of ["total-count", "pending-count", "active-count"]) elements[id].textContent = "–";
}

async function loadTeam() {
  clearError(); renderLoading();
  try {
    const { team } = await api("/api/team"); Object.assign(state, team);
    elements["organization-description"].textContent = state.mode === "internal" ? "Manage people, organization memberships, and application access." : `Manage the ${state.organizations[0].name} team and its access.`;
    renderMembers();
  } catch (error) { showError(error); state.members = []; renderMembers(); }
}

async function initialize() {
  elements["loading-panel"].hidden = false; elements["signin-panel"].hidden = true; elements.workspace.hidden = true;
  try { state.session = await api("/api/session"); state.csrf = state.session.csrf; showAuthenticated(); await loadTeam(); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return showSignin(); showAuthenticated(); showError(error); }
}

function prepareOrganizationOptions(container, chosen) {
  checkboxList(container, state.organizations, "organizations", chosen);
  container.closest("fieldset").hidden = state.mode !== "internal";
}

function openAddUser() {
  elements["add-user-form"].reset(); elements["add-user-error"].hidden = true;
  const organizationIds = state.mode === "internal" ? [] : [state.organizations[0].id];
  prepareOrganizationOptions(elements["add-organization-options"], organizationIds);
  syncApplicationOptions(elements["add-organization-options"], elements["add-application-options"]);
  elements["add-user-dialog"].showModal(); elements["add-user-form"].elements.firstName.focus();
}

function openAccess(member) {
  state.editingMember = member; elements["access-error"].hidden = true;
  elements["access-user"].textContent = `Manage organizations and applications for ${`${member.firstName} ${member.lastName}`.trim() || member.email}.`;
  prepareOrganizationOptions(elements["edit-organization-options"], member.organizationIds);
  syncApplicationOptions(elements["edit-organization-options"], elements["edit-application-options"], member.applications);
  elements["access-dialog"].showModal();
}

function openDelete(member) {
  state.deletingMember = member;
  elements["delete-user-error"].hidden = true;
  elements["delete-user-name"].textContent = `${member.firstName} ${member.lastName}`.trim() || member.email;
  const names = organizationNames();
  const organizations = member.organizationIds.map((id) => names.get(id) || id);
  elements["delete-user-organizations"].textContent = organizations.length
    ? `Organizations affected: ${organizations.join(", ")}.`
    : "No organization memberships are currently assigned.";
  elements["delete-user-dialog"].showModal();
}

async function submitAddUser(event) {
  event.preventDefault(); elements["add-user-error"].hidden = true; elements["create-user-button"].disabled = true;
  const form = new FormData(elements["add-user-form"]); const organizationIds = state.mode === "internal" ? selected(elements["add-organization-options"], "organizations") : [state.organizations[0].id];
  try {
    const result = await api("/api/team/users", { method: "POST", body: { firstName: form.get("firstName"), lastName: form.get("lastName"), email: form.get("email"), organizationIds, applications: selected(elements["add-application-options"], "applications") } });
    elements["add-user-dialog"].close(); toast(result.user.invitationSent ? `Invitation sent to ${form.get("email")}.` : `${form.get("email")} was added to the selected organizations.`); await loadTeam();
  } catch (error) { setFormError(elements["add-user-error"], error); } finally { elements["create-user-button"].disabled = false; }
}

async function submitAccess(event) {
  event.preventDefault(); elements["access-error"].hidden = true; elements["save-access-button"].disabled = true;
  const organizationIds = state.mode === "internal" ? selected(elements["edit-organization-options"], "organizations") : state.editingMember.organizationIds;
  try {
    await api(`/api/team/users/${encodeURIComponent(state.editingMember.id)}`, { method: "PATCH", body: { organizationIds, applications: selected(elements["edit-application-options"], "applications") } });
    elements["access-dialog"].close(); toast("Team membership and application access updated."); await loadTeam();
  } catch (error) { setFormError(elements["access-error"], error); } finally { elements["save-access-button"].disabled = false; }
}

async function submitDeleteUser(event) {
  event.preventDefault();
  elements["delete-user-error"].hidden = true;
  elements["confirm-delete-user-button"].disabled = true;
  const member = state.deletingMember;
  try {
    await api(`/api/team/users/${encodeURIComponent(member.id)}`, { method: "DELETE" });
    elements["delete-user-dialog"].close();
    state.deletingMember = null;
    toast(`${member.email} was permanently deleted.`);
    await loadTeam();
  } catch (error) {
    setFormError(elements["delete-user-error"], error);
  } finally {
    elements["confirm-delete-user-button"].disabled = false;
  }
}

async function resendInvitation(member, button) {
  button.disabled = true;
  try { await api(`/api/team/users/${encodeURIComponent(member.id)}/resend`, { method: "POST" }); toast(`A new invitation was sent to ${member.email}.`); }
  catch (error) { showError(error); } finally { button.disabled = false; }
}

async function changeEnabled(member, enabled) {
  try { await api(`/api/team/users/${encodeURIComponent(member.id)}`, { method: "PATCH", body: { enabled, organizationIds: member.organizationIds } }); toast(`${member.email} is now ${enabled ? "enabled" : "disabled"}.`); await loadTeam(); }
  catch (error) { showError(error); }
}

elements["user-menu-button"].addEventListener("click", () => { const open = elements["user-menu-popover"].hidden; elements["user-menu-popover"].hidden = !open; elements["user-menu-button"].setAttribute("aria-expanded", String(open)); });
document.addEventListener("click", (event) => { if (!elements["user-menu"].contains(event.target)) { elements["user-menu-popover"].hidden = true; elements["user-menu-button"].setAttribute("aria-expanded", "false"); } });
elements["sign-out-button"].addEventListener("click", async () => { try { const result = await api("/auth/logout", { method: "POST" }); location.assign(result.redirect || "/"); } catch { location.assign("/"); } });
elements["member-search"].addEventListener("input", renderMembers);
elements["add-user-button"].addEventListener("click", openAddUser);
elements["add-user-form"].addEventListener("submit", submitAddUser);
elements["access-form"].addEventListener("submit", submitAccess);
elements["delete-user-form"].addEventListener("submit", submitDeleteUser);
elements["add-organization-options"].addEventListener("change", () => syncApplicationOptions(elements["add-organization-options"], elements["add-application-options"], selected(elements["add-application-options"], "applications")));
elements["edit-organization-options"].addEventListener("change", () => syncApplicationOptions(elements["edit-organization-options"], elements["edit-application-options"], selected(elements["edit-application-options"], "applications")));
elements["retry-button"].addEventListener("click", loadTeam);
for (const button of document.querySelectorAll("[data-close-dialog]")) button.addEventListener("click", () => byId(button.dataset.closeDialog).close());
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("click", (event) => { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); });

initialize();
