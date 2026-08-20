# Control administration backend

This directory contains the server-side implementation of **Control**, the
broader Customer Account Manager administration workspace approved in
`../CONTROLT-ARCHITECTURE.md`. It uses Node.js 22 built-in APIs and has no
runtime package dependencies.

`ControlT` was the early test-environment name. The public product name is
**Control**, and its administration page is labeled **Control administration**.
Technical identifiers such as the `controlt.ngenious.app` test hostname,
container name, environment-variable prefix, and Keycloak client IDs remain
unchanged to avoid a risky infrastructure migration.

The `public/` directory contains the responsive customer-administrator
interface. It presents people, status, approved application access, invitations,
and enable/disable actions without exposing Keycloak concepts or credentials.

## Responsibilities

- authenticate administrators with Keycloak Authorization Code + PKCE;
- maintain signed, server-side, 30-minute administrator sessions;
- enforce the `ngenious-admin` and `organization-admin` ControlT client roles;
- bind customer administrators to exactly one organization server-side;
- validate application requests against the organization's
  `ngenious.allowedApplications` attribute;
- create identities without passwords and ask Keycloak to send the branded
  `VERIFY_EMAIL` + `UPDATE_PASSWORD` action email;
- safely resend pending invitations, enable or disable members, and update
  approved application access; and
- write structured audit events without credentials or action links.

It does not connect to SMTP, build password links, store passwords, access the
Keycloak database, or expose the Keycloak service credential to the browser.

## Configuration

The container receives `/opt/go-portal/secrets/controlt.env` at startup. The
required values are:

- `KEYCLOAK_INTERNAL_URL`
- `KEYCLOAK_ISSUER`
- `KEYCLOAK_REALM`
- `KEYCLOAK_ADMIN_CLIENT_ID`
- `KEYCLOAK_ADMIN_CLIENT_SECRET`
- `CONTROLT_OIDC_CLIENT_ID`
- `CONTROLT_OIDC_CLIENT_SECRET`
- `CONTROLT_SESSION_SECRET`

Optional settings include `PORT`, `CONTROLT_PUBLIC_ORIGIN`,
`CONTROLT_SESSION_TTL_SECONDS`, `CONTROLT_INVITATION_LIFESPAN_SECONDS`, and
`CONTROLT_APPLICATION_ROLE`. The default application access role is `access`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Process health |
| `GET` | `/auth/login` | Start Keycloak sign-in |
| `GET` | `/auth/callback` | Complete Keycloak sign-in |
| `POST` | `/auth/logout` | End the local and Keycloak administrator sessions |
| `GET` | `/api/session` | Current administrator and CSRF token |
| `GET` | `/api/organizations` | Organizations permitted to the administrator |
| `GET` | `/api/organizations/:id/applications` | Approved applications |
| `GET` | `/api/organizations/:id/members` | Organization members and status |
| `POST` | `/api/organizations/:id/users` | Create a user and send the invitation |
| `POST` | `/api/organizations/:id/users/:userId/resend` | Resend a pending invitation |
| `PATCH` | `/api/organizations/:id/users/:userId` | Enable, disable, or change application access |

All state-changing browser requests require the `x-controlt-csrf` header from
`GET /api/session`. Organization identifiers and application identifiers from
the browser are always checked against server-side Keycloak data.

## Local verification

```sh
npm run check
```

The checked-in tests use an in-memory Keycloak substitute and never create
users or send email. The suite currently covers 38 workflow, authorization,
request-security, session, and identity-token checks, including:

- organization isolation and administrator-role enforcement;
- create, duplicate, resend, rollback, enable/disable, and application-access
  behavior;
- authentication, CSRF, request parsing and size limits, logout, safe errors,
  and browser security headers; and
- signed OIDC token verification for signature, issuer, audience, expiry,
  nonce, subject, algorithm, and malformed-token cases.

These automated checks are the pre-deployment gate. The deployed end-to-end
test with Keycloak and actual email delivery is a separate acceptance step.
