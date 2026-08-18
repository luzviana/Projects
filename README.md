# ngenious infrastructure projects

This private repository contains reviewable infrastructure automation for ngenious
systems.

## ngenious Go Portal

The initial shared-test prototype is defined under
`ngenious-go-portal/test/`. It intentionally uses a single low-cost EC2 host in
the existing AI-Coder account VPC. Keycloak and PostgreSQL run as pinned
containers on the same encrypted volume.

The prototype does not create or change DNS, email-provider accounts, load
balancers, NAT gateways, monitoring services, or production resources.

The approved administration direction is documented in
`ngenious-go-portal/test/CONTROLT-ARCHITECTURE.md`. Keycloak remains the
identity engine. ControlT will provide a restricted, customer-oriented user
administration workflow over Keycloak's supported APIs; it will not implement
authentication, passwords, tokens, sessions, MFA, or email verification.
