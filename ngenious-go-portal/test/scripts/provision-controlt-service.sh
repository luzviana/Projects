#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak
CLIENT_ID=controlt-service
OIDC_CLIENT_ID=controlt-web
SECRETS_DIR=/opt/go-portal/secrets
CONTROLT_ENV=$SECRETS_DIR/controlt.env

ADMIN_JSON=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$ADMIN_SECRET" \
  --query SecretString \
  --output text)
ADMIN_USER=$(printf '%s' "$ADMIN_JSON" | jq -er .username)
ADMIN_PASSWORD=$(printf '%s' "$ADMIN_JSON" | jq -er .password)

kc() {
  docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}

authenticate_admin() {
  docker exec \
    -e ADMIN_USER="$1" \
    -e ADMIN_PASSWORD="$2" \
    "$KEYCLOAK_CONTAINER" \
    sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
      --server http://localhost:8080 \
      --realm master \
      --user "$ADMIN_USER" \
      --password "$ADMIN_PASSWORD" >/dev/null'
}

wait_for_keycloak() {
  local ready=false
  for attempt in $(seq 1 90); do
    if curl --max-time 5 -fsS \
      -H 'Host: id.ngenious.app' \
      http://127.0.0.1:8080/realms/go-portal-test/.well-known/openid-configuration \
      | jq -e '.issuer == "https://id.ngenious.app/realms/go-portal-test"' >/dev/null; then
      ready=true
      break
    fi
    sleep 2
  done
  test "$ready" = true
}

recovery_admin_created=false
env_temp=
cleanup() {
  set +e
  if [[ -n "$env_temp" && -e "$env_temp" ]]; then
    rm -f -- "$env_temp"
  fi
  if [[ "$recovery_admin_created" = true ]]; then
    recovery_admin_id=$(kc get users -r master \
      -q exact=true -q username="$RECOVERY_ADMIN_USER" \
      --fields id,username | jq -r '.[0].id // empty')
    if [[ -n "$recovery_admin_id" ]]; then
      kc delete "users/$recovery_admin_id" -r master >/dev/null
    fi
  fi
  unset ADMIN_JSON ADMIN_USER ADMIN_PASSWORD RECOVERY_ADMIN_USER \
    RECOVERY_ADMIN_PASSWORD CLIENT_SECRET OIDC_CLIENT_SECRET CONTROLT_SESSION_SECRET ACCESS_TOKEN \
    recovery_admin_id env_temp
}
trap cleanup EXIT

if ! authenticate_admin "$ADMIN_USER" "$ADMIN_PASSWORD"; then
  RECOVERY_ADMIN_USER="controlt-provision-$(openssl rand -hex 6)"
  RECOVERY_ADMIN_PASSWORD="Ngr!2026-$(openssl rand -hex 16)"
  keycloak_image_id=$(docker inspect "$KEYCLOAK_CONTAINER" --format '{{.Image}}')

  docker stop "$KEYCLOAK_CONTAINER" >/dev/null
  if ! docker run --rm \
    --network go-portal \
    --env-file /opt/go-portal/secrets/keycloak.env \
    -e RECOVERY_ADMIN_PASSWORD="$RECOVERY_ADMIN_PASSWORD" \
    "$keycloak_image_id" \
    bootstrap-admin user \
    --username "$RECOVERY_ADMIN_USER" \
    --password:env RECOVERY_ADMIN_PASSWORD \
    --no-prompt; then
    docker start "$KEYCLOAK_CONTAINER" >/dev/null
    exit 1
  fi
  docker start "$KEYCLOAK_CONTAINER" >/dev/null
  wait_for_keycloak
  authenticate_admin "$RECOVERY_ADMIN_USER" "$RECOVERY_ADMIN_PASSWORD"
  recovery_admin_created=true
fi

unset ADMIN_JSON ADMIN_USER ADMIN_PASSWORD

client_uuid=$(kc get clients -r "$REALM" -q clientId="$CLIENT_ID" \
  --fields id,clientId | jq -r '.[0].id // empty')

client_config=$(jq -cn --arg clientId "$CLIENT_ID" '{
  clientId: $clientId,
  name: "ControlT administration service",
  description: "Backend-only least-privilege client for ControlT user administration",
  enabled: true,
  protocol: "openid-connect",
  publicClient: false,
  bearerOnly: false,
  serviceAccountsEnabled: true,
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  authorizationServicesEnabled: false,
  fullScopeAllowed: false,
  clientAuthenticatorType: "client-secret"
}')

if [[ -z "$client_uuid" ]]; then
  client_uuid=$(kc create clients -r "$REALM" -b "$client_config" -i)
  printf 'Created the ControlT service client.\n'
else
  kc update "clients/$client_uuid" -r "$REALM" -b "$client_config" >/dev/null
  printf 'Updated the existing ControlT service client.\n'
fi

service_user_id=$(kc get "clients/$client_uuid/service-account-user" -r "$REALM" \
  --fields id,username | jq -er .id)
realm_management_client_id=$(kc get clients -r "$REALM" \
  -q clientId=realm-management --fields id,clientId | jq -er '.[0].id')

required_roles=(
  manage-users
  view-users
  query-users
  query-organizations
  view-organizations
  view-clients
  query-clients
)

for role_name in "${required_roles[@]}"; do
  role_json=$(kc get "clients/$realm_management_client_id/roles/$role_name" \
    -r "$REALM" -c)
  kc create \
    "users/$service_user_id/role-mappings/clients/$realm_management_client_id" \
    -r "$REALM" -b "[$role_json]" >/dev/null 2>&1 || true
  kc create \
    "clients/$client_uuid/scope-mappings/clients/$realm_management_client_id" \
    -r "$REALM" -b "[$role_json]" >/dev/null 2>&1 || true
done

assigned_roles=$(kc get \
  "users/$service_user_id/role-mappings/clients/$realm_management_client_id" \
  -r "$REALM" --fields name)
for role_name in "${required_roles[@]}"; do
  printf '%s' "$assigned_roles" | jq -e --arg role "$role_name" \
    'any(.[]; .name == $role)' >/dev/null
done
scope_roles=$(kc get \
  "clients/$client_uuid/scope-mappings/clients/$realm_management_client_id" \
  -r "$REALM" --fields name)
for role_name in "${required_roles[@]}"; do
  printf '%s' "$scope_roles" | jq -e --arg role "$role_name" \
    'any(.[]; .name == $role)' >/dev/null
done
if printf '%s' "$assigned_roles" | jq -e \
  'any(.[]; .name == "realm-admin" or .name == "manage-realm" or .name == "manage-clients")' \
  >/dev/null; then
  printf 'The ControlT service client has a forbidden administration role.\n' >&2
  exit 1
fi
if printf '%s' "$scope_roles" | jq -e \
  'any(.[]; .name == "realm-admin" or .name == "manage-realm" or .name == "manage-clients")' \
  >/dev/null; then
  printf 'The ControlT service client exposes a forbidden administration scope.\n' >&2
  exit 1
fi

CLIENT_SECRET=$(kc get "clients/$client_uuid/client-secret" -r "$REALM" \
  | jq -er .value)

oidc_client_uuid=$(kc get clients -r "$REALM" -q clientId="$OIDC_CLIENT_ID" \
  --fields id,clientId | jq -r '.[0].id // empty')
oidc_client_config=$(jq -cn --arg clientId "$OIDC_CLIENT_ID" '{
  clientId: $clientId,
  name: "ControlT",
  description: "Customer-safe ngenious administration interface",
  enabled: true,
  protocol: "openid-connect",
  publicClient: false,
  serviceAccountsEnabled: false,
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  fullScopeAllowed: false,
  clientAuthenticatorType: "client-secret",
  rootUrl: "https://controlt.ngenious.app",
  baseUrl: "/",
  redirectUris: ["https://controlt.ngenious.app/auth/callback"],
  webOrigins: ["https://controlt.ngenious.app"],
  attributes: {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": "https://controlt.ngenious.app/"
  }
}')
if [[ -z "$oidc_client_uuid" ]]; then
  oidc_client_uuid=$(kc create clients -r "$REALM" -b "$oidc_client_config" -i)
else
  kc update "clients/$oidc_client_uuid" -r "$REALM" -b "$oidc_client_config" >/dev/null
fi

for role_name in ngenious-admin organization-admin; do
  if ! kc get "clients/$oidc_client_uuid/roles/$role_name" -r "$REALM" \
    >/dev/null 2>&1; then
    kc create "clients/$oidc_client_uuid/roles" -r "$REALM" \
      -s name="$role_name" >/dev/null
  fi
  role_json=$(kc get "clients/$oidc_client_uuid/roles/$role_name" \
    -r "$REALM" -c)
  kc create "clients/$oidc_client_uuid/scope-mappings/clients/$oidc_client_uuid" \
    -r "$REALM" -b "[$role_json]" >/dev/null 2>&1 || true
done
role_mapper_name=controlt-client-roles
role_mapper=$(jq -cn --arg name "$role_mapper_name" --arg clientId "$OIDC_CLIENT_ID" '{
  name: $name,
  protocol: "openid-connect",
  protocolMapper: "oidc-usermodel-client-role-mapper",
  consentRequired: false,
  config: {
    "usermodel.clientRoleMapping.clientId": $clientId,
    "claim.name": ("resource_access." + $clientId + ".roles"),
    "jsonType.label": "String",
    "multivalued": "true",
    "access.token.claim": "true",
    "id.token.claim": "true",
    "userinfo.token.claim": "true",
    "introspection.token.claim": "true"
  }
}')
role_mapper_id=$(kc get "clients/$oidc_client_uuid/protocol-mappers/models" \
  -r "$REALM" --fields id,name | jq -r --arg name "$role_mapper_name" \
  '.[] | select(.name == $name) | .id' | head -n 1)
if [[ -z "$role_mapper_id" ]]; then
  kc create "clients/$oidc_client_uuid/protocol-mappers/models" \
    -r "$REALM" -b "$role_mapper" >/dev/null
else
  kc update "clients/$oidc_client_uuid/protocol-mappers/models/$role_mapper_id" \
    -r "$REALM" -b "$role_mapper" >/dev/null
fi
OIDC_CLIENT_SECRET=$(kc get "clients/$oidc_client_uuid/client-secret" -r "$REALM" \
  | jq -er .value)

install -d -o root -g root -m 0700 "$SECRETS_DIR"
if [[ -f "$CONTROLT_ENV" ]]; then
  CONTROLT_SESSION_SECRET=$(sed -n \
    's/^CONTROLT_SESSION_SECRET=\([[:alnum:]]\+\)$/\1/p' "$CONTROLT_ENV" \
    | head -n 1)
  EXISTING_INVITATION_SECRET=$(sed -n \
    's/^CONTROLT_INVITATION_SECRET=\([[:xdigit:]]\{64\}\)$/\1/p' "$CONTROLT_ENV" \
    | head -n 1)
  EXISTING_POSTMARK_SERVER_TOKEN=$(sed -n \
    's/^POSTMARK_SERVER_TOKEN=\([[:alnum:]-]\+\)$/\1/p' "$CONTROLT_ENV" \
    | head -n 1)
fi
if [[ -z "${CONTROLT_SESSION_SECRET:-}" ]]; then
  CONTROLT_SESSION_SECRET=$(openssl rand -hex 32)
fi
CONTROLT_INVITATION_SECRET=${EXISTING_INVITATION_SECRET:-$(openssl rand -hex 32)}
POSTMARK_SERVER_TOKEN=${POSTMARK_SERVER_TOKEN:-${EXISTING_POSTMARK_SERVER_TOKEN:-}}
if [[ -z "$POSTMARK_SERVER_TOKEN" ]]; then
  printf 'Set POSTMARK_SERVER_TOKEN for the existing Postmark server before provisioning Control.\n' >&2
  exit 1
fi

umask 077
env_temp=$(mktemp "$SECRETS_DIR/controlt.env.XXXXXX")
{
  printf 'KEYCLOAK_INTERNAL_URL=http://keycloak:8080\n'
  printf 'KEYCLOAK_ISSUER=https://id.ngenious.app/realms/%s\n' "$REALM"
  printf 'KEYCLOAK_REALM=%s\n' "$REALM"
  printf 'KEYCLOAK_ADMIN_CLIENT_ID=%s\n' "$CLIENT_ID"
  printf 'KEYCLOAK_ADMIN_CLIENT_SECRET=%s\n' "$CLIENT_SECRET"
  printf 'CONTROLT_OIDC_CLIENT_ID=%s\n' "$OIDC_CLIENT_ID"
  printf 'CONTROLT_OIDC_CLIENT_SECRET=%s\n' "$OIDC_CLIENT_SECRET"
  printf 'CONTROLT_SESSION_SECRET=%s\n' "$CONTROLT_SESSION_SECRET"
  printf 'CONTROLT_INVITATION_SECRET=%s\n' "$CONTROLT_INVITATION_SECRET"
  printf 'POSTMARK_SERVER_TOKEN=%s\n' "$POSTMARK_SERVER_TOKEN"
  printf 'POSTMARK_MESSAGE_STREAM=outbound\n'
} >"$env_temp"
chown root:root "$env_temp"
chmod 0600 "$env_temp"
mv -f -- "$env_temp" "$CONTROLT_ENV"
env_temp=

[[ $(stat -c '%U:%G:%a' "$SECRETS_DIR") == root:root:700 ]]
[[ $(stat -c '%U:%G:%a' "$CONTROLT_ENV") == root:root:600 ]]

ACCESS_TOKEN=$(curl --max-time 15 -fsS \
  -X POST "http://127.0.0.1:8080/realms/$REALM/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id="$CLIENT_ID" \
  --data-urlencode client_secret="$CLIENT_SECRET" \
  | jq -er .access_token)

curl --max-time 15 -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "http://127.0.0.1:8080/admin/realms/$REALM/users?max=1" >/dev/null
curl --max-time 15 -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "http://127.0.0.1:8080/admin/realms/$REALM/organizations?max=1" >/dev/null
curl --max-time 15 -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "http://127.0.0.1:8080/admin/realms/$REALM/clients?max=1" >/dev/null

printf 'Provisioned and verified the restricted ControlT service client.\n'
printf 'Stored its credential in %s with root:root:600 permissions.\n' \
  "$CONTROLT_ENV"
