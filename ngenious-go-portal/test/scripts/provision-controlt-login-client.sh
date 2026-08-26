#!/bin/bash
set -Eeuo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
KEYCLOAK_ENV=/opt/go-portal/secrets/keycloak.env
CONTROLT_ENV=/opt/go-portal/secrets/controlt.env
OIDC_CLIENT_ID=controlt-web

test -s "$KEYCLOAK_ENV"
test -s "$CONTROLT_ENV"
[[ $(stat -c '%U:%G:%a' "$CONTROLT_ENV") == root:root:600 ]]

keycloak_image=$(docker inspect "$KEYCLOAK_CONTAINER" --format '{{.Image}}')
recovery_user="controlt-login-$(openssl rand -hex 6)"
recovery_password="Ngr!2026-$(openssl rand -hex 20)"
recovery_created=false
recovery_authenticated=false
env_temp=

kc() {
  docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
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

cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [[ -n "$env_temp" && -e "$env_temp" ]]; then
    rm -f -- "$env_temp"
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$KEYCLOAK_CONTAINER"; then
    docker start "$KEYCLOAK_CONTAINER" >/dev/null 2>&1
    wait_for_keycloak >/dev/null 2>&1
  fi
  if [[ "$recovery_created" == true ]]; then
    if [[ "$recovery_authenticated" != true ]]; then
      docker exec \
        --env RECOVERY_USER="$recovery_user" \
        --env RECOVERY_PASSWORD="$recovery_password" \
        "$KEYCLOAK_CONTAINER" \
        sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
          --server http://localhost:8080 --realm master \
          --user "$RECOVERY_USER" --password "$RECOVERY_PASSWORD" >/dev/null' \
        >/dev/null 2>&1
    fi
    recovery_id=$(kc get users -r master -q exact=true \
      -q username="$recovery_user" --fields id 2>/dev/null \
      | jq -r '.[0].id // empty')
    if [[ -n "$recovery_id" ]]; then
      kc delete "users/$recovery_id" -r master >/dev/null 2>&1
    fi
  fi
  unset recovery_password oidc_secret recovery_id
  exit "$status"
}
trap cleanup EXIT

docker stop "$KEYCLOAK_CONTAINER" >/dev/null
docker run --rm \
  --network go-portal \
  --env-file "$KEYCLOAK_ENV" \
  --env RECOVERY_PASSWORD="$recovery_password" \
  "$keycloak_image" \
  bootstrap-admin user \
  --username "$recovery_user" \
  --password:env RECOVERY_PASSWORD \
  --no-prompt >/dev/null
recovery_created=true
docker start "$KEYCLOAK_CONTAINER" >/dev/null
wait_for_keycloak

docker exec \
  --env RECOVERY_USER="$recovery_user" \
  --env RECOVERY_PASSWORD="$recovery_password" \
  "$KEYCLOAK_CONTAINER" \
  sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 --realm master \
    --user "$RECOVERY_USER" --password "$RECOVERY_PASSWORD" >/dev/null'
recovery_authenticated=true

client_uuid=$(kc get clients -r "$REALM" -q clientId="$OIDC_CLIENT_ID" \
  --fields id | jq -r '.[0].id // empty')
client_config=$(jq -cn --arg clientId "$OIDC_CLIENT_ID" '{
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

if [[ -z "$client_uuid" ]]; then
  client_uuid=$(kc create clients -r "$REALM" -b "$client_config" -i)
else
  kc update "clients/$client_uuid" -r "$REALM" -b "$client_config" >/dev/null
fi

for role_name in ngenious-admin organization-admin; do
  if ! kc get "clients/$client_uuid/roles/$role_name" -r "$REALM" \
    >/dev/null 2>&1; then
    kc create "clients/$client_uuid/roles" -r "$REALM" \
      -s name="$role_name" >/dev/null
  fi
  role_json=$(kc get "clients/$client_uuid/roles/$role_name" -r "$REALM" -c)
  kc create "clients/$client_uuid/scope-mappings/clients/$client_uuid" \
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
role_mapper_id=$(kc get "clients/$client_uuid/protocol-mappers/models" \
  -r "$REALM" --fields id,name | jq -r --arg name "$role_mapper_name" \
  '.[] | select(.name == $name) | .id' | head -n 1)
if [[ -z "$role_mapper_id" ]]; then
  kc create "clients/$client_uuid/protocol-mappers/models" \
    -r "$REALM" -b "$role_mapper" >/dev/null
else
  kc update "clients/$client_uuid/protocol-mappers/models/$role_mapper_id" \
    -r "$REALM" -b "$role_mapper" >/dev/null
fi

oidc_secret=$(kc get "clients/$client_uuid/client-secret" -r "$REALM" \
  | jq -er .value)
[[ ${#oidc_secret} -ge 20 ]]

umask 077
env_temp=$(mktemp /opt/go-portal/secrets/controlt.env.XXXXXX)
grep -v '^CONTROLT_OIDC_CLIENT_' "$CONTROLT_ENV" >"$env_temp"
{
  printf 'CONTROLT_OIDC_CLIENT_ID=%s\n' "$OIDC_CLIENT_ID"
  printf 'CONTROLT_OIDC_CLIENT_SECRET=%s\n' "$oidc_secret"
} >>"$env_temp"
chown root:root "$env_temp"
chmod 0600 "$env_temp"
mv -f -- "$env_temp" "$CONTROLT_ENV"
env_temp=
unset oidc_secret

for required_key in CONTROLT_OIDC_CLIENT_ID CONTROLT_OIDC_CLIENT_SECRET; do
  grep -q "^${required_key}=.." "$CONTROLT_ENV"
done

printf 'Provisioned the confidential ControlT login client.\n'
printf 'Stored its existing secret only in the root-protected host environment.\n'
