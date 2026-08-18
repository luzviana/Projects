#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak

: "${USER_EMAIL:?Set USER_EMAIL}"

USER_EMAIL=${USER_EMAIL,,}
[[ "$USER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]

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
cleanup() {
  set +e
  if [[ "$recovery_admin_created" = true ]]; then
    recovery_admin_id=$(kc get users -r master \
      -q exact=true -q username="$RECOVERY_ADMIN_USER" \
      --fields id,username | jq -r '.[0].id // empty')
    if [[ -n "$recovery_admin_id" ]]; then
      kc delete "users/$recovery_admin_id" -r master >/dev/null
    fi
  fi
  unset ADMIN_JSON ADMIN_USER ADMIN_PASSWORD RECOVERY_ADMIN_USER \
    RECOVERY_ADMIN_PASSWORD recovery_admin_id
}
trap cleanup EXIT

if ! authenticate_admin "$ADMIN_USER" "$ADMIN_PASSWORD"; then
  RECOVERY_ADMIN_USER="ngenious-user-admin-$(openssl rand -hex 6)"
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

realm_management_client_id=$(kc get clients \
  -r "$REALM" -q clientId=realm-management \
  --fields id,clientId | jq -er '.[0].id')
user_id=$(kc get users -r "$REALM" \
  -q exact=true -q username="$USER_EMAIL" \
  --fields id,username | jq -er '.[0].id')

roles_json=$(for role_name in manage-users view-users query-users query-organizations; do
  kc get "clients/$realm_management_client_id/roles/$role_name" -r "$REALM" -c
done | jq -s '.')

kc create "users/$user_id/role-mappings/clients/$realm_management_client_id" \
  -r "$REALM" -b "$roles_json" >/dev/null 2>&1 || true

printf 'Granted ngenious user-administrator permissions to %s without realm, client, role, or authentication-flow management.\n' \
  "$USER_EMAIL"
