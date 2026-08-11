#!/bin/bash
set -euo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
BASE_URL=http://localhost:8080
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

kc() {
  docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}

organization_id() {
  kc get organizations -r "$REALM" --fields id,alias | \
    jq -er --arg alias "$1" '.[] | select(.alias == $alias) | .id'
}

access_token() {
  local secret_name=$1
  local alias=$2
  local secret_json email password response

  secret_json=$(aws secretsmanager get-secret-value \
    --region us-east-1 \
    --secret-id "$secret_name" \
    --query SecretString \
    --output text)
  email=$(printf '%s' "$secret_json" | jq -er .email)
  password=$(printf '%s' "$secret_json" | jq -er .password)
  response=$(curl --silent --show-error --fail \
    -X POST "$BASE_URL/realms/$REALM/protocol/openid-connect/token" \
    -d client_id=admin-cli \
    -d grant_type=password \
    --data-urlencode username="$email" \
    --data-urlencode password="$password" \
    --data-urlencode "scope=openid organization:$alias")
  printf '%s' "$response" | jq -er .access_token
  unset secret_json email password response
}

secret_email() {
  aws secretsmanager get-secret-value \
    --region us-east-1 \
    --secret-id "$1" \
    --query SecretString \
    --output text | jq -er .email
}

status_code() {
  local token=$1
  local path=$2
  curl --silent --show-error \
    -o "$WORK_DIR/response.json" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    "$BASE_URL$path"
}

validate_admin() {
  local own_alias=$1
  local other_alias=$2
  local secret_name=$3
  local token own_id other_id status aliases own_email usernames

  own_id=$(organization_id "$own_alias")
  other_id=$(organization_id "$other_alias")
  own_email=$(secret_email "$secret_name")
  token=$(access_token "$secret_name" "$own_alias")
  printf '%s: password sign-in passed.\n' "$own_alias"

  status=$(status_code "$token" "/admin/realms/$REALM/organizations")
  printf '%s: organization list returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 200 ]] || return 1
  aliases=$(jq -r '.[].alias' "$WORK_DIR/response.json")
  printf '%s: visible organization aliases: %s\n' "$own_alias" "${aliases:-none}"
  [[ "$aliases" == "$own_alias" ]] || return 1

  status=$(status_code "$token" "/admin/realms/$REALM/organizations/$own_id")
  printf '%s: own organization returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 200 ]] || return 1
  status=$(status_code "$token" "/admin/realms/$REALM/organizations/$own_id/members")
  printf '%s: own members returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 200 ]] || return 1

  status=$(status_code "$token" "/admin/realms/$REALM/organizations/$other_id")
  printf '%s: other organization returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 403 || "$status" == 404 ]] || return 1
  status=$(status_code "$token" "/admin/realms/$REALM/organizations/$other_id/members")
  printf '%s: other members returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 403 || "$status" == 404 ]] || return 1

  status=$(status_code "$token" "/admin/realms/$REALM")
  printf '%s: basic realm metadata returned HTTP %s (required by Keycloak admin UI).\n' \
    "$own_alias" "$status"
  [[ "$status" == 200 ]] || return 1

  status=$(status_code "$token" "/admin/realms/$REALM/clients")
  printf '%s: realm clients returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 403 ]] || return 1
  status=$(status_code "$token" "/admin/realms/$REALM/roles")
  printf '%s: realm roles returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 403 ]] || return 1
  status=$(status_code "$token" "/admin/realms/$REALM/authentication/flows")
  printf '%s: authentication flows returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 403 ]] || return 1

  status=$(status_code "$token" "/admin/realms/$REALM/users")
  printf '%s: filtered user search returned HTTP %s.\n' "$own_alias" "$status"
  [[ "$status" == 200 ]] || return 1
  usernames=$(jq -r '.[].username' "$WORK_DIR/response.json")
  printf '%s: visible user accounts: %s\n' "$own_alias" "${usernames:-none}"
  [[ "$usernames" == "$own_email" ]] || return 1

  printf '%s: sign-in passed; only %s is visible; cross-company and realm-wide access denied.\n' \
    "$own_alias" "$own_alias"
  unset token
}

validate_admin \
  prototype-alpha \
  prototype-beta \
  ngenious-go-portal/test/synthetic-admin-alpha

validate_admin \
  prototype-beta \
  prototype-alpha \
  ngenious-go-portal/test/synthetic-admin-beta

printf 'Prototype customer-isolation validation passed.\n'
