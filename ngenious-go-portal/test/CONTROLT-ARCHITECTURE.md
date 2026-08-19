# ControlT administration architecture

Status: approved target for the shared-test PoC

Decision date: 2026-08-18

## Objective

ControlT gives ngenious and customer administrators a simple, safe way to add
people, assign permitted applications, and send an account-setup email. It
removes Keycloak-specific concepts such as required actions, email-verification
flags, credentials, WebAuthn, realm roles, and authentication flows from the
customer workflow.

The target operation is:

> Create user and send invitation

That single operation creates or validates the identity, assigns the authorized
organization and applications, and asks Keycloak to send an expiring action
link containing `VERIFY_EMAIL` and `UPDATE_PASSWORD`.

## System boundary

Keycloak remains the identity engine and source of truth. It continues to own:

- users and email-verification state;
- password credentials and password policy;
- login, logout, sessions, cookies, and tokens;
- organizations, memberships, roles, and application access;
- required actions and expiring action tokens;
- future MFA and passwordless authentication; and
- branded verification, setup, and recovery email generation.

ControlT is an administration facade over supported Keycloak APIs. It owns:

- the customer-administrator user experience;
- authorization checks that bind a customer administrator to one organization;
- orchestration of user creation, membership, application access, and email;
- safe duplicate-user and resend behavior; and
- minimal invitation and administrator audit metadata.

ControlT must never store passwords, validate passwords, issue identity tokens,
implement login, or reproduce Keycloak authentication flows.

## Components

### ControlT

ControlT is a small Node.js web application with a server-side backend. The
browser never receives the Keycloak administration credential. The backend uses
a dedicated Keycloak confidential service client with only the permissions
required by the approved operations.

The PoC uses no separate ControlT database. Keycloak remains authoritative for
users, organization membership, application roles, enabled state, and email
verification. Small audit fields such as invitation time and inviter may be
stored as namespaced Keycloak user attributes until a dedicated audit store is
justified.

### Keycloak

Keycloak authenticates both administrators and application users. ControlT
calls Keycloak's administration API from the server and uses the
`execute-actions-email` endpoint to send the setup link. Merely saving required
actions on a user is not treated as sending an invitation.

### Google Workspace SMTP relay

Keycloak sends branded messages through the existing TLS-protected Google
Workspace SMTP relay. ControlT does not connect to SMTP and does not construct
verification or password links.

### Caddy

Caddy is the existing HTTPS web gateway, equivalent in purpose to Nginx or an
AWS application load balancer for this PoC. It obtains and renews TLS
certificates, applies public security headers, writes access logs, and routes:

- `got.ngenious.app` to the protected test application;
- `id.ngenious.app` to Keycloak login and self-service; and
- `controlt.ngenious.app` to the ControlT application.

Caddy does not authenticate users or store identity data. Keycloak port 8080
and its management port remain unavailable from the public internet.

### PostgreSQL

PostgreSQL remains Keycloak's private database. ControlT must use supported
Keycloak APIs and must not read or write Keycloak database tables directly.

## Administrator roles

### Customer administrator

A customer administrator is bound to exactly one Keycloak organization and may:

- list people in that organization;
- create and invite a person into that organization;
- grant only applications approved for that organization;
- resend a pending invitation;
- enable or disable a member when policy permits; and
- change that member's approved application assignments.

A customer administrator may not select or supply another organization, view
another organization's members, manage Keycloak clients or roles, edit login
flows, configure MFA, or open the native Keycloak administration console.

### ngenious internal administrator

An ngenious internal administrator uses the same ControlT workflow but may
select among authorized customer organizations. This role does not
automatically grant unrestricted Keycloak realm administration. Operational
access to the native console is a separate emergency capability.

Authorization is enforced by the ControlT backend using authenticated token
claims and server-side organization lookup. An organization identifier supplied
by the browser is never trusted by itself.

The confidential `controlt-web` login client defines two application roles:
`ngenious-admin` and `organization-admin`. These roles identify the type of
ControlT administrator; they do not grant native Keycloak console access. For a
customer administrator, the backend additionally requires exactly one current
Keycloak organization membership on every organization-scoped request.

Each organization's approved applications are stored in its
`ngenious.allowedApplications` attribute as Keycloak client IDs. Every listed
client must expose the dedicated `access` client role. ControlT resolves this
allowlist and the roles server-side and rejects browser-supplied applications
that are not listed.

## User invitation workflow

### New identity

1. Validate and normalize the email address and names.
2. Resolve the administrator's permitted organization on the server.
3. Validate requested applications against that organization's allowlist.
4. Confirm that the email is not already owned by an incompatible identity.
5. Create an enabled Keycloak user with `emailVerified=false` and no password.
6. Add the user to the permitted organization.
7. Assign only the selected, permitted application access.
8. Call `execute-actions-email` with `VERIFY_EMAIL` and `UPDATE_PASSWORD` and a
   12-hour lifespan.
9. Record the inviter and invitation time without storing the action link.
10. Return a clear success response identifying the recipient and link expiry.

If Keycloak rejects the email request synchronously, ControlT removes access
created by that incomplete operation or records a recoverable pending state.
The implementation must be idempotent so a retry cannot create duplicate
memberships or roles.

### Existing identity

- If the identity belongs to the same organization and onboarding is pending,
  ControlT offers **Resend invitation** and preserves the user identifier and
  permissions.
- If the identity is already active in the same organization, ControlT reports
  that status instead of sending an unexpected password-change email.
- If the identity belongs to another customer or has an ambiguous ownership
  state, ControlT refuses the operation and directs the administrator to
  ngenious support.
- ControlT never deletes and recreates an existing identity merely to resend an
  invitation.

## Customer interface

The initial customer-administrator page contains:

- organization name, displayed read-only;
- a searchable member list;
- status values `Pending`, `Active`, and `Disabled`;
- permitted application assignments;
- **Add user**;
- **Resend invitation** for pending users; and
- **Enable** or **Disable** when permitted.

The Add user form contains only first name, last name, email, and permitted
applications. Its primary action is **Create user and send invitation**.

The interface does not expose email-verification flags, required-action lists,
credentials, OTP, WebAuthn, groups, raw roles, realm configuration, clients, or
authentication flows. MFA and passwordless administration are outside the
current PoC.

## Local credential policy

The approved PoC target has no AWS Secrets Manager dependency. The ControlT
service-client credential and server session secret are generated on the
identity host and stored only in:

`/opt/go-portal/secrets/controlt.env`

Required controls:

- directory owned by `root:root` with mode `0700`;
- file owned by `root:root` with mode `0600`;
- values generated randomly on the host and never printed;
- file excluded from Git, tickets, documentation, container images, and logs;
- injected only into the ControlT container at startup;
- credential rotation supported without recreating users; and
- encrypted EC2 root volume retained as the storage boundary.

The ControlT runtime and normal user-administration scripts must not read AWS
Secrets Manager. New identity stacks generate their secrets locally on the
encrypted instance, provision the restricted service client, and delete the
one-time bootstrap identity before initialization completes. Removing Secrets
Manager must not move secret values into CloudFormation parameters, GitHub
Actions variables, source files, shell history, or public container metadata.

## Availability requirement

Normal user creation, invitation, resend, enable, disable, and application
assignment must not stop or restart Keycloak. A one-time controlled maintenance
operation may provision the ControlT service client. The offline
`bootstrap-admin` recovery cycle is not part of normal ControlT operation.

## Security and acceptance criteria

The target is accepted only when tests demonstrate that:

1. one UI action creates the user and causes Keycloak to submit the branded
   setup email;
2. the recipient can verify the email, create a password, and sign in directly
   to an assigned application;
3. no initial or temporary password is emailed;
4. a customer administrator cannot view or modify another customer;
5. unapproved application access is rejected server-side;
6. duplicate and cross-organization email cases are safe and understandable;
7. invitation resend preserves the existing user and permissions;
8. failures return actionable messages and do not leave unintended access;
9. administrative actions record actor, target, organization, operation, and
   time without recording credentials or action links;
10. customer administrators cannot reach the native Keycloak administration
    console; and
11. all normal administration operations complete without a Keycloak restart
    or public 502 response.

## Automated verification

The pre-deployment suite runs entirely against isolated substitutes and cannot
create a live identity or send an email. It verifies the user lifecycle and
rollback rules, administrator and organization boundaries, approved-application
enforcement, signed sessions, CSRF protection, request limits, safe error
responses, security headers, logout invalidation, and cryptographic OIDC token
validation.

Passing the automated suite authorizes deployment testing; it does not by
itself satisfy the live-email and direct-application sign-in acceptance
criteria above. Those checks are performed after deployment with a designated
pilot account.

## Transition

Until ControlT is deployed, `controlt.ngenious.app` still points to the native
Keycloak administration console. The restricted service client and local
credential path are ready, and the normal invitation workflow no longer uses
AWS Secrets Manager or an offline bootstrap administrator. The native console
remains transitional, not the approved customer experience. Deployment must
switch the hostname only after the ControlT security and end-to-end tests pass.
