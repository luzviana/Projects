#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak

ADMIN_JSON=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$ADMIN_SECRET" \
  --query SecretString \
  --output text)
ADMIN_USER=$(printf '%s' "$ADMIN_JSON" | jq -r .username)
ADMIN_PASSWORD=$(printf '%s' "$ADMIN_JSON" | jq -r .password)

docker exec \
  -e ADMIN_USER="$ADMIN_USER" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  "$KEYCLOAK_CONTAINER" \
  sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user "$ADMIN_USER" \
    --password "$ADMIN_PASSWORD" >/dev/null'

unset ADMIN_JSON ADMIN_USER ADMIN_PASSWORD

kc() {
  docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}

realm_permissions=$(kc get "realms/$REALM" --fields adminPermissionsEnabled)
if [[ $(printf '%s' "$realm_permissions" | jq -r '.adminPermissionsEnabled // false') != true ]]; then
  kc update "realms/$REALM" -s adminPermissionsEnabled=true >/dev/null
  printf 'Enabled fine-grained administration for %s.\n' "$REALM"
fi

admin_permissions_client_id=$(kc get clients \
  -r "$REALM" \
  -q clientId=admin-permissions \
  --fields id,clientId | jq -er '.[0].id')
realm_management_client_id=$(kc get clients \
  -r "$REALM" \
  -q clientId=realm-management \
  --fields id,clientId | jq -er '.[0].id')
query_organizations_role=$(kc get \
  "clients/$realm_management_client_id/roles/query-organizations" \
  -r "$REALM" -c)
query_users_role=$(kc get \
  "clients/$realm_management_client_id/roles/query-users" \
  -r "$REALM" -c)

ensure_customer_admin() {
  local alias=$1
  local secret_name=$2
  local policy_name="customer-admin-$alias"
  local permission_name="manage-organization-$alias"
  local user_permission_name="manage-customer-admin-user-$alias"
  local secret_json email first_name last_name password
  local organization_id user_id policy_id

  secret_json=$(aws secretsmanager get-secret-value \
    --region us-east-1 \
    --secret-id "$secret_name" \
    --query SecretString \
    --output text)
  email=$(printf '%s' "$secret_json" | jq -er .email)
  first_name=$(printf '%s' "$secret_json" | jq -er .firstName)
  last_name=$(printf '%s' "$secret_json" | jq -er .lastName)
  password=$(printf '%s' "$secret_json" | jq -er .password)

  organization_id=$(kc get organizations -r "$REALM" \
    --fields id,alias | jq -er --arg alias "$alias" \
    '.[] | select(.alias == $alias) | .id')

  user_id=$(kc get users -r "$REALM" \
    -q exact=true -q username="$email" \
    --fields id,username | jq -r '.[0].id // empty')
  if [[ -z "$user_id" ]]; then
    user_id=$(kc create users -r "$REALM" \
      -s username="$email" \
      -s email="$email" \
      -s firstName="$first_name" \
      -s lastName="$last_name" \
      -s enabled=true \
      -s emailVerified=true \
      -i)
    printf 'Created synthetic customer administrator: %s\n' "$email"
  else
    printf 'Synthetic customer administrator already exists: %s\n' "$email"
  fi

  docker exec \
    -e USER_PASSWORD="$password" \
    "$KEYCLOAK_CONTAINER" \
    sh -c '/opt/keycloak/bin/kcadm.sh set-password \
      -r '"$REALM"' \
      --userid '"$user_id"' \
      --new-password "$USER_PASSWORD" >/dev/null'

  if ! kc get "organizations/$organization_id/members" -r "$REALM" \
    --fields id | jq -e --arg id "$user_id" \
    'any(.[]; .id == $id)' >/dev/null; then
    kc create "organizations/$organization_id/members" \
      -r "$REALM" \
      -b "\"$user_id\"" >/dev/null
    printf 'Added %s to %s.\n' "$email" "$alias"
  fi

  kc create "users/$user_id/role-mappings/clients/$realm_management_client_id" \
    -r "$REALM" \
    -b "[$query_organizations_role,$query_users_role]" >/dev/null 2>&1 || true

  policy_id=$(kc get \
    "clients/$admin_permissions_client_id/authz/resource-server/policy" \
    -r "$REALM" \
    -q name="$policy_name" \
    -q exact=true \
    --fields id,name | jq -r '.[0].id // empty')
  if [[ -z "$policy_id" ]]; then
    policy_id=$(kc create \
      "clients/$admin_permissions_client_id/authz/resource-server/policy/user" \
      -r "$REALM" \
      -b "$(jq -cn --arg name "$policy_name" --arg user "$user_id" \
        '{name: $name, logic: "POSITIVE", users: [$user]}')" \
      -i)
    printf 'Created customer administrator policy: %s\n' "$policy_name"
  fi

  if ! kc get \
    "clients/$admin_permissions_client_id/authz/resource-server/permission" \
    -r "$REALM" \
    -q name="$permission_name" \
    -q exact=true \
    --fields id,name | jq -e 'length > 0' >/dev/null; then
    kc create \
      "clients/$admin_permissions_client_id/authz/resource-server/permission/scope" \
      -r "$REALM" \
      -b "$(jq -cn \
        --arg name "$permission_name" \
        --arg resource "$organization_id" \
        --arg policy "$policy_name" \
        '{name: $name, resourceType: "Organizations", scopes: ["view", "manage"], resources: [$resource], policies: [$policy]}')" \
      >/dev/null
    printf 'Granted organization-scoped test permission: %s\n' "$alias"
  fi

  if ! kc get \
    "clients/$admin_permissions_client_id/authz/resource-server/permission" \
    -r "$REALM" \
    -q name="$user_permission_name" \
    -q exact=true \
    --fields id,name | jq -e 'length > 0' >/dev/null; then
    kc create \
      "clients/$admin_permissions_client_id/authz/resource-server/permission/scope" \
      -r "$REALM" \
      -b "$(jq -cn \
        --arg name "$user_permission_name" \
        --arg resource "$user_id" \
        --arg policy "$policy_name" \
        '{name: $name, resourceType: "Users", scopes: ["view", "manage"], resources: [$resource], policies: [$policy]}')" \
      >/dev/null
    printf 'Granted test permission for the administrator own user record: %s\n' "$alias"
  fi

  unset secret_json email first_name last_name password
}

ensure_customer_admin \
  prototype-alpha \
  ngenious-go-portal/test/synthetic-admin-alpha

ensure_customer_admin \
  prototype-beta \
  ngenious-go-portal/test/synthetic-admin-beta

printf 'Synthetic customer administrators are configured.\n'
