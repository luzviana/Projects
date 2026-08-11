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
`/opt/go-portal/caddy/Caddyfile` on the host and run
`scripts/configure-public-portal.sh` through Systems Manager. Caddy obtains and
renews HTTPS automatically. Public requests to `/admin` and the master realm are
answered with 404; administration continues through the Systems Manager tunnel.

Run `scripts/configure-test-realm-security.sh` after public exposure to enable
the version-controlled test-realm brute-force delay and temporary lockout policy.

## Synthetic organizations

Run `scripts/seed-prototype-organizations.sh` on the test instance through an
approved Systems Manager command. It idempotently creates the two synthetic
organizations used by Prototype A and reads the temporary administrator only
from Secrets Manager.
