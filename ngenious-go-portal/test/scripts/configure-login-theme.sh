#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak
THEME=ngenious-go

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
  local username=$1
  local password=$2
  docker exec \
    -e ADMIN_USER="$username" \
    -e ADMIN_PASSWORD="$password" \
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
cleanup_recovery_admin() {
  if [[ "$recovery_admin_created" != true ]]; then
    return
  fi
  set +e
  recovery_admin_id=$(kc get users -r master \
    -q exact=true -q username="$RECOVERY_ADMIN_USER" \
    --fields id,username | jq -r '.[0].id // empty')
  if [[ -n "$recovery_admin_id" ]]; then
    kc delete "users/$recovery_admin_id" -r master >/dev/null
    printf 'Removed temporary recovery administrator.\n'
  fi
  unset RECOVERY_ADMIN_USER RECOVERY_ADMIN_PASSWORD recovery_admin_id
}

if ! authenticate_admin "$ADMIN_USER" "$ADMIN_PASSWORD"; then
  printf 'Bootstrap administrator is unavailable; creating a local temporary recovery administrator.\n'
  RECOVERY_ADMIN_USER="theme-config-$(openssl rand -hex 6)"
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
  trap cleanup_recovery_admin EXIT
fi

unset ADMIN_JSON ADMIN_USER ADMIN_PASSWORD

kc update "realms/$REALM" \
    -s "loginTheme=$THEME" \
    -s "accountTheme=$THEME" \
    -s "emailTheme=$THEME" \
    -s 'displayName=ngenious Account'

ACTIVE_THEMES=$(kc get "realms/$REALM" \
    --fields loginTheme,accountTheme,emailTheme,displayName)

test "$(printf '%s' "$ACTIVE_THEMES" | jq -r .loginTheme)" = "$THEME"
test "$(printf '%s' "$ACTIVE_THEMES" | jq -r .accountTheme)" = "$THEME"
test "$(printf '%s' "$ACTIVE_THEMES" | jq -r .emailTheme)" = "$THEME"
test "$(printf '%s' "$ACTIVE_THEMES" | jq -r .displayName)" = 'ngenious Account'
printf 'Active themes: login=%s account=%s email=%s\n' \
  "$(printf '%s' "$ACTIVE_THEMES" | jq -r .loginTheme)" \
  "$(printf '%s' "$ACTIVE_THEMES" | jq -r .accountTheme)" \
  "$(printf '%s' "$ACTIVE_THEMES" | jq -r .emailTheme)"
