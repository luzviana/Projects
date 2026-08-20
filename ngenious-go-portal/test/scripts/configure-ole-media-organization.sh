#!/bin/bash
set -Eeuo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
KEYCLOAK_ENV=/opt/go-portal/secrets/keycloak.env
ORGANIZATION_NAME='Ole Media'
ORGANIZATION_ALIAS=ole-media
NGENIOUS_ORGANIZATION_NAME=ngenious
NGENIOUS_ORGANIZATION_ALIAS=ngenious
NGENIOUS_ADMIN_EMAIL=cleber@ngenious.ai
APPLICATION_CLIENT_ID=media-monitoring
APPLICATION_ROLE=access
ALLOWED_APPLICATIONS_ATTRIBUTE=ngenious.allowedApplications
CONTROL_SERVICE_CLIENT_ID=controlt-service

test -s "$KEYCLOAK_ENV"

keycloak_image=$(docker inspect "$KEYCLOAK_CONTAINER" --format '{{.Image}}')
recovery_user="ole-media-setup-$(openssl rand -hex 6)"
recovery_password="Ngr!2026-$(openssl rand -hex 20)"
recovery_created=false
recovery_authenticated=false

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
  unset recovery_password recovery_id
  exit "$status"
}
trap cleanup EXIT

# The permanent Control service is intentionally unable to create organizations
# or client roles. Use a one-time local recovery administrator and remove it on
# exit, so no standing realm administrator credential is retained.
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

# Keycloak 26.7 separates listing organizations from viewing their records.
# Control needs the read-only view role, but never manage-organizations.
control_service_uuid=$(kc get clients -r "$REALM" \
  -q clientId="$CONTROL_SERVICE_CLIENT_ID" --fields id,clientId \
  | jq -er '.[0].id')
control_service_user_id=$(kc get \
  "clients/$control_service_uuid/service-account-user" -r "$REALM" \
  --fields id | jq -er .id)
realm_management_uuid=$(kc get clients -r "$REALM" \
  -q clientId=realm-management --fields id,clientId | jq -er '.[0].id')
view_organizations_role=$(kc get \
  "clients/$realm_management_uuid/roles/view-organizations" \
  -r "$REALM" -c)
kc create \
  "users/$control_service_user_id/role-mappings/clients/$realm_management_uuid" \
  -r "$REALM" -b "[$view_organizations_role]" >/dev/null 2>&1 || true
kc create \
  "clients/$control_service_uuid/scope-mappings/clients/$realm_management_uuid" \
  -r "$REALM" -b "[$view_organizations_role]" >/dev/null 2>&1 || true

client_uuid=$(kc get clients -r "$REALM" \
  -q clientId="$APPLICATION_CLIENT_ID" --fields id,clientId \
  | jq -r '.[0].id // empty')
if [[ -z "$client_uuid" ]]; then
  printf 'Required Keycloak client does not exist: %s\n' "$APPLICATION_CLIENT_ID" >&2
  exit 1
fi

if ! kc get "clients/$client_uuid/roles/$APPLICATION_ROLE" -r "$REALM" \
  >/dev/null 2>&1; then
  kc create "clients/$client_uuid/roles" -r "$REALM" \
    -s name="$APPLICATION_ROLE" \
    -s 'description=Allows a team member to use this application' >/dev/null
  printf 'Created application role: %s/%s\n' \
    "$APPLICATION_CLIENT_ID" "$APPLICATION_ROLE"
else
  printf 'Application role already exists: %s/%s\n' \
    "$APPLICATION_CLIENT_ID" "$APPLICATION_ROLE"
fi

kc update "clients/$client_uuid" -r "$REALM" \
  -s 'name=Streamer Monitor' >/dev/null

# Allow Control to map only this application's ordinary access role. Keycloak
# requires both the service-account mapping and the client's token scope; this
# does not grant Control permission to configure the application client.
application_role_json=$(kc get \
  "clients/$client_uuid/roles/$APPLICATION_ROLE" -r "$REALM" -c)
kc create \
  "users/$control_service_user_id/role-mappings/clients/$client_uuid" \
  -r "$REALM" -b "[$application_role_json]" >/dev/null 2>&1 || true
kc create \
  "clients/$control_service_uuid/scope-mappings/clients/$client_uuid" \
  -r "$REALM" -b "[$application_role_json]" >/dev/null 2>&1 || true

organization=$(kc get organizations -r "$REALM" --fields id,name,alias,enabled,attributes \
  | jq -c --arg alias "$ORGANIZATION_ALIAS" \
    '.[] | select(.alias == $alias)' | head -n 1)

if [[ -z "$organization" ]]; then
  organization_payload=$(jq -cn \
    --arg name "$ORGANIZATION_NAME" \
    --arg alias "$ORGANIZATION_ALIAS" \
    --arg attribute "$ALLOWED_APPLICATIONS_ATTRIBUTE" \
    --arg application "$APPLICATION_CLIENT_ID" \
    '{name:$name, alias:$alias, enabled:true, attributes:{($attribute):[$application]}}')
  organization_id=$(kc create organizations -r "$REALM" \
    -b "$organization_payload" -i)
  printf 'Created organization: %s\n' "$ORGANIZATION_NAME"
else
  organization_id=$(printf '%s' "$organization" | jq -er .id)
  organization_payload=$(printf '%s' "$organization" | jq -c \
    --arg name "$ORGANIZATION_NAME" \
    --arg alias "$ORGANIZATION_ALIAS" \
    --arg attribute "$ALLOWED_APPLICATIONS_ATTRIBUTE" \
    --arg application "$APPLICATION_CLIENT_ID" \
    '.name=$name | .alias=$alias | .enabled=true |
     .attributes=((.attributes // {}) + {($attribute):[$application]})')
  kc update "organizations/$organization_id" -r "$REALM" \
    -b "$organization_payload" >/dev/null
  printf 'Updated organization: %s\n' "$ORGANIZATION_NAME"
fi

configured_organization=$(kc get "organizations/$organization_id" -r "$REALM")
printf '%s' "$configured_organization" | jq -e \
  --arg alias "$ORGANIZATION_ALIAS" \
  --arg attribute "$ALLOWED_APPLICATIONS_ATTRIBUTE" \
  --arg application "$APPLICATION_CLIENT_ID" \
  '.alias == $alias and .enabled == true and
   (.attributes[$attribute] | index($application) != null)' >/dev/null

ngenious_organization=$(kc get organizations -r "$REALM" \
  --fields id,name,alias,enabled,attributes \
  | jq -c --arg alias "$NGENIOUS_ORGANIZATION_ALIAS" \
    '.[] | select(.alias == $alias)' | head -n 1)
if [[ -z "$ngenious_organization" ]]; then
  ngenious_organization_payload=$(jq -cn \
    --arg name "$NGENIOUS_ORGANIZATION_NAME" \
    --arg alias "$NGENIOUS_ORGANIZATION_ALIAS" \
    '{name:$name, alias:$alias, enabled:true, attributes:{}}')
  ngenious_organization_id=$(kc create organizations -r "$REALM" \
    -b "$ngenious_organization_payload" -i)
  printf 'Created organization: %s\n' "$NGENIOUS_ORGANIZATION_NAME"
else
  ngenious_organization_id=$(printf '%s' "$ngenious_organization" | jq -er .id)
  printf 'Organization already exists: %s\n' "$NGENIOUS_ORGANIZATION_NAME"
fi

ngenious_admin_id=$(kc get users -r "$REALM" \
  -q exact=true -q username="$NGENIOUS_ADMIN_EMAIL" \
  --fields id,username,email | jq -r '.[0].id // empty')
if [[ -z "$ngenious_admin_id" ]]; then
  ngenious_admin_id=$(kc get users -r "$REALM" \
    -q exact=true -q email="$NGENIOUS_ADMIN_EMAIL" \
    --fields id,username,email | jq -r '.[0].id // empty')
fi
if [[ -z "$ngenious_admin_id" ]]; then
  printf 'Required administrator does not exist: %s\n' "$NGENIOUS_ADMIN_EMAIL" >&2
  exit 1
fi

for membership_organization_id in "$organization_id" "$ngenious_organization_id"; do
  if ! kc get "organizations/$membership_organization_id/members" -r "$REALM" \
    --fields id | jq -e --arg id "$ngenious_admin_id" \
    'any(.[]; .id == $id)' >/dev/null; then
    kc create "organizations/$membership_organization_id/members" \
      -r "$REALM" -b "\"$ngenious_admin_id\"" >/dev/null
  fi
done

for membership_organization_id in "$organization_id" "$ngenious_organization_id"; do
  kc get "organizations/$membership_organization_id/members" -r "$REALM" \
    --fields id | jq -e --arg id "$ngenious_admin_id" \
    'any(.[]; .id == $id)' >/dev/null
done

printf '%s is a member of Ole Media and ngenious. No users were created or invited.\n' \
  "$NGENIOUS_ADMIN_EMAIL"
