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
- No DNS, SES, load balancer, NAT gateway, AWS monitoring, or automatic recovery

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
443 for `got.ngenious.app`. It does not expose SSH, Keycloak port 8080, the
management port, or the administration console.

After DNS points `got.ngenious.app` to the stack output, place `Caddyfile` at
`/opt/go-portal/caddy/Caddyfile` and the version-controlled `theme/ngenious-go`
directory at `/opt/go-portal/theme/ngenious-go` on the host, then run
`scripts/configure-public-portal.sh` through Systems Manager. Caddy obtains and
renews HTTPS automatically. Public requests to `/admin` and the master realm are
answered with 404; administration continues through the Systems Manager tunnel.

Run `scripts/configure-login-theme.sh` after the themed Keycloak container is
ready. The script activates the `ngenious-go` login theme only for the test realm
and verifies the saved realm setting. The theme extends Keycloak's built-in v2
login theme, includes the approved ngenious logo locally, and preserves the
standard authentication templates. Its checked-in `css/styles.css` is the exact
base stylesheet from the pinned Keycloak 26.7.0 release and must be refreshed
when the Keycloak image is upgraded.

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
expose the native Keycloak administration console; tests must instead confirm
that clients, roles, authentication flows, and unauthorized user records remain
denied.

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
