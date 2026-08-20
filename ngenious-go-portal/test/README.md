# ngenious Go Portal — shared-test prototype

## Approved footprint

- AWS account profile: `ai-coder` (`919519434125`)
- Region: `us-east-1`
- Existing VPC: `vpc-07bd3f5eb5ecaa0b1`
- Subnet: `subnet-0a414d17ab28e035f` (`us-east-1a`)
- One ARM `t4g.medium` EC2 instance
- One 20 GiB encrypted `gp3` root volume
- Keycloak 26.7.0 and PostgreSQL 17.6 on the same instance
- AWS Systems Manager access; no inbound security-group rules
- External DNS for `got.ngenious.app` and `id.ngenious.app`; Keycloak email
  delivery through the existing Google Workspace SMTP relay, with no load
  balancer, NAT gateway, AWS monitoring, or automatic recovery

The VPC is shared with Media Monitoring and has peering routes to private
networks. The instance has a dedicated security group with no inbound rules.
Host and container firewall rules reject traffic to RFC1918 private networks,
apart from the VPC DNS resolver and the isolated container network.

## Approved ControlT direction

The approved target architecture and security boundaries are defined in
[`CONTROLT-ARCHITECTURE.md`](CONTROLT-ARCHITECTURE.md). Keycloak remains the
identity engine and source of truth. ControlT is a small, restricted
administration layer that combines user creation, organization and application
assignment, and Keycloak's setup-email action into one customer-safe workflow.
It does not store passwords or implement authentication.

ControlT's runtime and user-onboarding path use only the restricted service
credential in the host's root-only `controlt.env`; they do not read AWS Secrets
Manager or create offline recovery administrators.

The backend implementation is in [`controlt/`](controlt/). It provides the
organization-scoped JSON API, Keycloak OIDC sign-in, protected server sessions,
invitation orchestration, application-role assignment, and audit events. The
same directory now includes the responsive customer-administrator interface.
The hostname cutover is performed by `scripts/deploy-controlt.sh` only after
the staged application passes its isolated checks and local health check.

## Deploy

Validate the template first:

```sh
aws cloudformation validate-template \
  --profile ai-coder \
  --region us-east-1 \
  --template-body file://template.yaml
```

Create the stack:

```sh
aws cloudformation deploy \
  --profile ai-coder \
  --region us-east-1 \
  --stack-name ngenious-go-portal-test \
  --template-file template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
```

`template.yaml` is the local-secret replacement design for a new stack. Do not
apply it as an in-place update to the currently running legacy stack: that stack
still owns historical Secrets Manager resources, and removing resources through
an update can schedule them for deletion. The running PoC is migrated at the
host/application layer and should be replaced deliberately when the new-stack
path is exercised.

No secret values are accepted as parameters or stored in Git. A new stack
generates its database password, one-time bootstrap credential, ControlT client
secret, and session secret on the encrypted instance. It provisions the
restricted ControlT client, deletes the bootstrap identity, and removes the
bootstrap values from the Keycloak environment before bootstrap completes.

## Access

The Keycloak HTTP port is bound only to the instance loopback interface. Use an
AWS Systems Manager port-forwarding session to map local port `18080` to remote
port `8080`, then open `http://localhost:18080`.

The instance ID is a CloudFormation output. Runtime credentials exist only in
root-protected files on the encrypted instance. Do not print them into
terminals, tickets, or logs.

## Public customer portal

`public-ingress.yaml` creates the stable IPv4 address and opens only ports 80 and
443. `got.ngenious.app` is the protected relying-party test application;
`id.ngenious.app` is the permanent Keycloak identity and self-service address.
`controlt.ngenious.app` routes to the simplified ControlT application described
in `CONTROLT-ARCHITECTURE.md`. None of these hostnames exposes SSH, Keycloak
port 8080, or the management port.

After DNS points all three hostnames to the stack output, place `Caddyfile` at
`/opt/go-portal/caddy/Caddyfile` and the version-controlled `theme/ngenious-go`
directory at `/opt/go-portal/theme/ngenious-go` on the host, then run
`scripts/configure-public-portal.sh` through Systems Manager. Caddy obtains and
renews HTTPS automatically. The native administration console is not published
as the customer interface. Browser-authentication endpoints remain reachable
through `id.ngenious.app`.
Opening the root of `id.ngenious.app` redirects to the test realm's Keycloak
account console for self-service password and session management.

Caddy continues to terminate HTTPS and route the three public hostnames;
customer administrators do not receive a link to the native Keycloak
administration console.

To deploy on the existing identity host, stage `controlt/`, `Caddyfile`, and
`scripts/deploy-controlt.sh` under `/tmp/controlt-deploy/`, then run the script
as root. It runs the complete automated suite in an isolated container, starts
ControlT on loopback port 3100, verifies local health, and only then restarts
Caddy. It verifies the public page, sign-in redirect, and unauthenticated API
boundary. If any step fails, the prior Caddy route and ControlT container are
restored. Keycloak is not stopped or restarted.

For an existing `got.ngenious.app` deployment, stage the reviewed `Caddyfile`
as `/tmp/Caddyfile.identity` and run `scripts/activate-identity-host.sh` through
Systems Manager. The script changes only Keycloak's public hostname and the
test application's issuer, validates both services and the public redirect, and
leaves the stopped pre-migration containers available for rollback review.

Run `scripts/configure-login-theme.sh` after the themed Keycloak container is
ready. The script activates the `ngenious-go` login, account, and email themes
for the test realm, applies the `ngenious Account` display name, and verifies
the saved realm settings. The email theme provides branded password-setup and
password-reset messages with expiring links; it does not send passwords in
email. The login theme extends Keycloak's built-in v2 theme and the account
theme extends the built-in v3 Account Console. All preserve Keycloak's standard
authentication and self-service behavior while applying the approved ngenious
branding. The login theme's checked-in `css/styles.css` is the exact base
stylesheet from the pinned Keycloak 26.7.0 release and must be refreshed when
the Keycloak image is upgraded.

## Keycloak email delivery

Keycloak owns invitation, verification, and password-reset behavior and sends
the branded messages directly through standard SMTP. The shared-test PoC uses
the existing `viana.ooo` Google Workspace SMTP relay; Amazon SES and Resend are
not part of this configuration.

In Google Workspace Admin, create an SMTP relay rule that accepts mail only
from the identity server's fixed public IPv4 address, `18.215.111.250`, requires
TLS, restricts senders to registered Workspace users, and permits delivery to
external recipients. Store the provider-neutral Keycloak configuration in the
version-controlled deployment script; it contains no SMTP credential. The
effective configuration is:

```json
{
  "host": "smtp-relay.gmail.com",
  "port": 587,
  "auth": false,
  "from": "aws@viana.ooo",
  "fromDisplayName": "ngenious",
  "replyTo": "aws@viana.ooo"
}
```

The running PoC already has this realm-level SMTP setting. It is not part of
normal ControlT operation. Future realm-level changes require a separately
approved maintenance session; the restricted ControlT service identity cannot
change SMTP or realm configuration.

## Organization user invitation

This command-line workflow is transitional. ControlT will perform the same
Keycloak operations server-side through a restricted service client and expose
one customer-facing action: **Create user and send invitation**.

The backend-only `controlt-service` client has `manage-users`, `view-users`,
`query-users`, `query-organizations`, `view-clients`, and `query-clients`. Only
those roles are included in its token scope; realm, realm-client, and
client-management roles are forbidden. Its credential and the ControlT session
secret are stored in `/opt/go-portal/secrets/controlt.env` with
`root:root:600` permissions and are never printed. New stacks provision this
identity during their one-time local bootstrap. The existing PoC was migrated
once with `scripts/provision-controlt-service.sh`.

Run `scripts/invite-organization-user.sh` as root on the identity instance with
`USER_EMAIL`, `FIRST_NAME`, `LAST_NAME`, and `ORGANIZATION_ALIAS` set. The script:

1. refuses to change or relink an identity that already exists;
2. creates an unverified identity without a password;
3. adds it to exactly the named organization;
4. sends one branded, expiring action link for email verification and password
   creation; and
5. removes the newly created identity if delivery fails.

The script authenticates only as `controlt-service` through the protected local
environment. It never reads AWS Secrets Manager, creates a bootstrap
administrator, stops Keycloak, or restarts Keycloak.

The script does not grant application access or application roles. Its default
link lifetime is 12 hours and can be changed with
`ACTION_LIFESPAN_SECONDS`. `DELETE_AFTER_SEND=true` is reserved for synthetic
delivery tests. The Workspace relay can deliver to external recipients without
provider-specific recipient verification.
For an explicitly approved onboarding retest, `REPLACE_EXISTING=true` removes
only the matching identity before recreating it and sending a fresh invitation.
The default remains refusal to alter an existing identity.
Use `RESEND_EXISTING=true` to send a fresh setup link without recreating the
identity. The script first verifies that the existing identity is already a
member of the named organization, and it preserves all current permissions.
`RESEND_EXISTING` cannot be combined with `REPLACE_EXISTING` or
`DELETE_AFTER_SEND`.

After the invited user completes onboarding, run
`scripts/grant-organization-admin.sh` with `USER_EMAIL` and
`ORGANIZATION_ALIAS` to grant the existing organization-scoped delegated
administrator permissions. The script adds only the query navigation roles,
the named organization's `view` and `manage` scopes, and the administrator's
own user-record scopes. It does not grant realm-wide administration.

For an ngenious internal operator who must create and manage identities across
customers, run `scripts/grant-ngenious-user-admin.sh` with `USER_EMAIL`. It
grants the `manage-users`, `view-users`, `query-users`, and
`query-organizations` roles. It does not grant realm, client, application-role,
identity-provider, authentication-flow, or event administration. Customer
administrators must not receive this role set.

Run `scripts/configure-account-overview.sh` after the synthetic organizations
and protected test application exist. It assigns the ordinary synthetic tester
to `prototype-alpha` and configures `got.ngenious.app` with a display name,
home URL, and Account Console visibility. The branded Account Console reads the
signed-in user's organizations and applications from Keycloak's user-scoped
Account API; it does not call the administration API or expose the native
administration console.

The login-tab favicon is the robot-head component extracted without redesign
from the approved `ngenious-logo.png`. Run
`scripts/build-robot-favicon.mjs` with Node.js to reproducibly regenerate the
16, 32, 48, and 64 pixel images stored in `ngenious-robot-v1.ico`. The
`favicons.ngenious` entry in `theme.properties` gives the branded icon a
versioned URL so browsers do not reuse the former long-lived Keycloak favicon.
After installing a changed theme asset, restart the test Keycloak container. If
the favicon changes again, increment its version in the file name and property.

Run `scripts/configure-test-realm-security.sh` after public exposure to enable
the version-controlled test-realm brute-force delay and temporary lockout policy.

## Synthetic organizations

Run `scripts/seed-prototype-organizations.sh` on the test instance through an
approved Systems Manager command. It idempotently creates the two synthetic
organizations used by Prototype A and reads the temporary administrator only
from Secrets Manager.

For Prototype A customer-administrator isolation, run
`scripts/provision-prototype-admin-secrets.sh` from an approved operator machine.
It creates two generated shared-test credentials in Secrets Manager and grants
only the test instance role permission to read them. Then run
`scripts/seed-prototype-customer-admins.sh` and
`scripts/validate-prototype-customer-isolation.sh` on the instance through
Systems Manager. No generated password, access token, or secret value is stored
in Git or printed by these scripts.

The customer administrators receive the query-only `query-organizations` and
`query-users` navigation roles plus a fine-grained `view` and `manage`
permission for their assigned synthetic
organization. The prototype also grants each administrator user-level `view`
and `manage` permission only to that administrator's own synthetic user record,
because Keycloak separately applies user permissions when returning organization
members. The query-only roles expose no user or organization record unless a
fine-grained permission also permits it. The administrators do not receive
realm-wide view or management roles. Keycloak
26.7 currently makes organization `manage` broader than ngenious needs because
it includes organization updates and deletion, not only member invitations and
membership. This permission is therefore for the synthetic prototype only. Real
customer administrators must use an ngenious-controlled restricted management
surface unless a future Keycloak release adds member-only organization scopes.
Keycloak's delegated administration API also returns basic realm metadata needed
to load its own administration interface. The customer-facing portal must not
link to or grant customer access to the native Keycloak administration console;
during the transition, that native route is reserved for ngenious internal
administrators. The approved ControlT target does not expose the native console
to customer administrators. Tests must confirm that clients, roles,
authentication flows, and unauthorized user records remain denied to customer
administrators.

## Protected OIDC test application

The direct-authentication prototype uses one ordinary synthetic user,
`oidc.tester@example.invalid`. It receives no customer-administrator or realm
roles. Its temporary password is generated on the test host at deployment time,
shown once to the authorized operator, and changed by the tester during first
sign-in. It is not stored in Git or Secrets Manager.

Place the reviewed application `server.mjs` at
`/opt/go-portal/test-app/server.mjs`, install this directory's updated
`Caddyfile`, and run `scripts/deploy-oidc-test-app.sh` through Systems Manager.
The script idempotently configures the confidential Keycloak client, resets the
synthetic tester to a new temporary password, starts the constrained Node
container, checks its health, and reloads Caddy. Keycloak realm and static-resource
routes remain on port 8080; all other public routes go to the protected test
application on host-loopback port 3000.

If the historical bootstrap administrator has already been disabled, the
deployment script uses Keycloak's offline `bootstrap-admin` command while the
single test node is stopped. It creates a random local recovery administrator,
uses it only for this deployment, and deletes it before the script exits. No
recovery credential is printed or retained.

## Ole Media relying application

Ole Media uses direct application authentication at
`https://streamer.ngenious.app`; it is not launched from an application portal.
Run `scripts/provision-media-monitoring-oidc.sh` from an authenticated AWS
operator shell, then run `scripts/configure-media-monitoring-client.sh` on this
identity instance through Systems Manager. The first script creates a restricted
Secrets Manager handoff and a least-privilege instance profile for the existing
dashboard server. The second idempotently configures the confidential
`media-monitoring` Keycloak client and writes its client and cookie secrets to
that handoff without printing either value.

The dashboard-side installation is maintained in the Ole Media repository.
Its gateway redirects page requests to `id.ngenious.app`, returns authenticated
users to their original Ole Media URL, and rejects unsigned monitoring-data
requests with HTTP 401. Ole Media continues to own its application roles and
customer permissions.
