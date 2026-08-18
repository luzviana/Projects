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
- External DNS for `got.ngenious.app` and `id.ngenious.app`; SES sandbox email
  delivery, with no load balancer, NAT gateway, AWS monitoring, or automatic
  recovery

The VPC is shared with Media Monitoring and has peering routes to private
networks. The instance has a dedicated security group with no inbound rules.
Host and container firewall rules reject traffic to RFC1918 private networks,
apart from the VPC DNS resolver and the isolated container network.

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

No secret values are accepted as parameters or stored in Git. CloudFormation
creates random database and bootstrap-administrator passwords in AWS Secrets
Manager.

## Access

The Keycloak HTTP port is bound only to the instance loopback interface. Use an
AWS Systems Manager port-forwarding session to map local port `18080` to remote
port `8080`, then open `http://localhost:18080`.

The instance ID and secret names are CloudFormation outputs. Do not print secret
values into terminals, tickets, or logs.

## Public customer portal

`public-ingress.yaml` creates the stable IPv4 address and opens only ports 80 and
443. `got.ngenious.app` is the protected relying-party test application;
`id.ngenious.app` is the permanent Keycloak identity and self-service address.
`controlt.ngenious.app` is the public login surface for the ngenious internal
administration console. None of these hostnames exposes SSH, Keycloak port 8080,
or the management port.

After DNS points all three hostnames to the stack output, place `Caddyfile` at
`/opt/go-portal/caddy/Caddyfile` and the version-controlled `theme/ngenious-go`
directory at `/opt/go-portal/theme/ngenious-go` on the host, then run
`scripts/configure-public-portal.sh` through Systems Manager. Caddy obtains and
renews HTTPS automatically. The ngenious internal administration console is
available at `https://controlt.ngenious.app/admin/master/console/`. Access still
requires a Keycloak realm-administrator account; publishing the login page does
not grant administrative privileges to ordinary or customer users.
Opening the root of `id.ngenious.app` redirects to the test realm's Keycloak
account console for self-service password and session management.

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

## Organization user invitation

Run `scripts/invite-organization-user.sh` on the identity instance with
`USER_EMAIL`, `FIRST_NAME`, `LAST_NAME`, and `ORGANIZATION_ALIAS` set. The script:

1. refuses to change or relink an identity that already exists;
2. creates an unverified identity without a password;
3. adds it to exactly the named organization;
4. sends one branded, expiring action link for email verification and password
   creation; and
5. removes the newly created identity if delivery fails.

The script does not grant application access or application roles. Its default
link lifetime is 12 hours and can be changed with
`ACTION_LIFESPAN_SECONDS`. `DELETE_AFTER_SEND=true` is reserved for synthetic
mailbox-simulator tests. While SES remains sandboxed, do not use this workflow
for customer addresses.
For an explicitly approved onboarding retest, `REPLACE_EXISTING=true` removes
only the matching identity before recreating it and sending a fresh invitation.
The default remains refusal to alter an existing identity.

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
the public admin route is reserved for ngenious internal administrators. Tests
must confirm that clients, roles, authentication flows, and unauthorized user
records remain denied to customer administrators.

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
