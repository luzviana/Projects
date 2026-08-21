#!/bin/bash
set -Eeuo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
CONTROLT_ENV=/opt/go-portal/secrets/controlt.env
DEPLOY_SCRIPT=/tmp/controlt-deploy/deploy-controlt.sh
ACTIVATE_SCRIPT=/tmp/controlt-deploy/activate-controlt-invitation-relay.sh

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

authenticate_admin() {
  docker exec \
    -e RECOVERY_ADMIN_USER="$1" \
    -e RECOVERY_ADMIN_PASSWORD="$2" \
    "$KEYCLOAK_CONTAINER" \
    sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
      --server http://localhost:8080 --realm master \
      --user "$RECOVERY_ADMIN_USER" --password "$RECOVERY_ADMIN_PASSWORD" >/dev/null'
}

test "$(id -u)" -eq 0
test -s "$CONTROLT_ENV"
test -x "$DEPLOY_SCRIPT"
test -x "$ACTIVATE_SCRIPT"
[[ $(stat -c '%U:%G:%a' "$CONTROLT_ENV") == root:root:600 ]]

RECOVERY_ADMIN_USER="invitation-migration-$(openssl rand -hex 6)"
RECOVERY_ADMIN_PASSWORD="Ngr!2026-$(openssl rand -hex 16)"
keycloak_image_id=$(docker inspect "$KEYCLOAK_CONTAINER" --format '{{.Image}}')
recovery_admin_created=false
env_temp=

cleanup() {
  local status=$?
  set +e
  if [[ -n "$env_temp" && -e "$env_temp" ]]; then rm -f -- "$env_temp"; fi
  if [[ "$recovery_admin_created" = true ]]; then
    recovery_admin_id=$(kc get users -r master \
      -q exact=true -q username="$RECOVERY_ADMIN_USER" \
      --fields id,username | jq -r '.[0].id // empty')
    if [[ -n "$recovery_admin_id" ]]; then
      kc delete "users/$recovery_admin_id" -r master >/dev/null
    fi
  fi
  unset RECOVERY_ADMIN_USER RECOVERY_ADMIN_PASSWORD POSTMARK_SERVER_TOKEN \
    EXISTING_POSTMARK_SERVER_TOKEN CONTROLT_INVITATION_SECRET \
    recovery_admin_id env_temp
  exit "$status"
}
trap cleanup EXIT

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

current_smtp=$(kc get "realms/$REALM" --fields smtpServer | jq -c '.smtpServer // {}')
EXISTING_POSTMARK_SERVER_TOKEN=$(sed -n \
  's/^POSTMARK_SERVER_TOKEN=\([[:alnum:]-]\+\)$/\1/p' "$CONTROLT_ENV" \
  | head -n 1)
if [[ -n "$EXISTING_POSTMARK_SERVER_TOKEN" ]]; then
  POSTMARK_SERVER_TOKEN=$EXISTING_POSTMARK_SERVER_TOKEN
else
  printf '%s' "$current_smtp" | jq -e '
    .host == "smtp.postmarkapp.com" and
    (.password | type == "string" and length > 10) and
    (.password | test("^[*]+$") | not)' >/dev/null
  POSTMARK_SERVER_TOKEN=$(printf '%s' "$current_smtp" | jq -er .password)
fi
CONTROLT_INVITATION_SECRET=$(openssl rand -hex 32)

backup="$CONTROLT_ENV.pre-invitation-relay.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$CONTROLT_ENV" "$backup"
umask 077
env_temp=$(mktemp /opt/go-portal/secrets/controlt.env.XXXXXX)
awk '!/^CONTROLT_INVITATION_SECRET=/ && !/^POSTMARK_SERVER_TOKEN=/ && !/^POSTMARK_MESSAGE_STREAM=/' \
  "$CONTROLT_ENV" >"$env_temp"
{
  printf 'CONTROLT_INVITATION_SECRET=%s\n' "$CONTROLT_INVITATION_SECRET"
  printf 'POSTMARK_SERVER_TOKEN=%s\n' "$POSTMARK_SERVER_TOKEN"
  printf 'POSTMARK_MESSAGE_STREAM=outbound\n'
} >>"$env_temp"
chown root:root "$env_temp"
chmod 0600 "$env_temp"
mv -f -- "$env_temp" "$CONTROLT_ENV"
env_temp=

"$DEPLOY_SCRIPT"
"$ACTIVATE_SCRIPT"

saved=$(kc get "realms/$REALM" --fields smtpServer | jq -c .smtpServer)
printf '%s' "$saved" | jq -e '
  .host == "controlt" and .port == "2525" and
  (.username == null) and (.password == null)' >/dev/null

printf 'Migrated identity mail to the scanner-safe Control invitation relay.\n'
printf 'The prior protected Control environment is retained at %s for rollback.\n' "$backup"
