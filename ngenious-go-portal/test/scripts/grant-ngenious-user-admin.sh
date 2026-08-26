#!/bin/bash
set -euo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/keycloak-controlt.sh
source "$SCRIPT_DIR/lib/keycloak-controlt.sh"

: "${USER_EMAIL:?Set USER_EMAIL}"

USER_EMAIL=${USER_EMAIL,,}
[[ "$USER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]

cleanup() {
  set +e
  unset KEYCLOAK_ADMIN_CLIENT_SECRET CONTROLT_SESSION_SECRET
}
trap cleanup EXIT

controlt_authenticate

realm_management_client_id=$(kc get clients \
  -r "$REALM" -q clientId=realm-management \
  --fields id,clientId | jq -er '.[0].id')
control_client_id=$(kc get clients \
  -r "$REALM" -q clientId=controlt-web \
  --fields id,clientId | jq -er '.[0].id')
user_id=$(kc get users -r "$REALM" \
  -q exact=true -q username="$USER_EMAIL" \
  --fields id,username | jq -er '.[0].id')

roles_json=$(for role_name in manage-users view-users query-users query-organizations; do
  kc get "clients/$realm_management_client_id/roles/$role_name" -r "$REALM" -c
done | jq -s '.')

kc create "users/$user_id/role-mappings/clients/$realm_management_client_id" \
  -r "$REALM" -b "$roles_json" >/dev/null 2>&1 || true

control_role=$(kc get "clients/$control_client_id/roles/ngenious-admin" \
  -r "$REALM" -c)
kc create "users/$user_id/role-mappings/clients/$control_client_id" \
  -r "$REALM" -b "[$control_role]" >/dev/null 2>&1 || true

printf 'Granted ngenious user-administrator and Control administration permissions to %s without realm, client, role, or authentication-flow management.\n' \
  "$USER_EMAIL"
