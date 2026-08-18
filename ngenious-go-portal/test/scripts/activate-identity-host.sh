#!/bin/bash
set -Eeuo pipefail

KEYCLOAK_ENV=/opt/go-portal/secrets/keycloak.env
APP_ENV=/opt/go-portal/secrets/oidc-test-app.env
CADDYFILE=/opt/go-portal/caddy/Caddyfile
STAGED_CADDYFILE=/tmp/Caddyfile.identity
KEYCLOAK_BACKUP=keycloak-pre-identity
APP_BACKUP=oidc-test-app-pre-identity

test -s "$KEYCLOAK_ENV"
test -s "$APP_ENV"
test -s "$CADDYFILE"
test -s "$STAGED_CADDYFILE"
! docker container inspect "$KEYCLOAK_BACKUP" >/dev/null 2>&1
! docker container inspect "$APP_BACKUP" >/dev/null 2>&1

caddy_image=$(docker inspect caddy --format '{{.Image}}')
keycloak_image=$(docker inspect keycloak --format '{{.Image}}')
app_image=$(docker inspect oidc-test-app --format '{{.Image}}')

docker run --rm \
  --mount type=bind,src="$STAGED_CADDYFILE",dst=/etc/caddy/Caddyfile,readonly \
  "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

cp -p "$KEYCLOAK_ENV" "$KEYCLOAK_ENV.pre-identity"
cp -p "$APP_ENV" "$APP_ENV.pre-identity"
cp -p "$CADDYFILE" "$CADDYFILE.pre-identity"

sed -i 's|^KC_HOSTNAME=.*|KC_HOSTNAME=https://id.ngenious.app|' "$KEYCLOAK_ENV"
if grep -q '^KC_HOSTNAME_ADMIN=' "$KEYCLOAK_ENV"; then
  sed -i 's|^KC_HOSTNAME_ADMIN=.*|KC_HOSTNAME_ADMIN=https://controlt.ngenious.app|' "$KEYCLOAK_ENV"
else
  printf '%s\n' 'KC_HOSTNAME_ADMIN=https://controlt.ngenious.app' >> "$KEYCLOAK_ENV"
fi
sed -i 's|^OIDC_ISSUER=.*|OIDC_ISSUER=https://id.ngenious.app/realms/go-portal-test|' "$APP_ENV"
cp "$STAGED_CADDYFILE" "$CADDYFILE"
chmod 0640 "$CADDYFILE"

rollback() {
  set +e
  docker stop keycloak oidc-test-app >/dev/null 2>&1
  docker rename keycloak keycloak-failed-identity >/dev/null 2>&1
  docker rename oidc-test-app oidc-test-app-failed-identity >/dev/null 2>&1
  cp -p "$KEYCLOAK_ENV.pre-identity" "$KEYCLOAK_ENV"
  cp -p "$APP_ENV.pre-identity" "$APP_ENV"
  cp -p "$CADDYFILE.pre-identity" "$CADDYFILE"
  docker rename "$KEYCLOAK_BACKUP" keycloak >/dev/null 2>&1
  docker rename "$APP_BACKUP" oidc-test-app >/dev/null 2>&1
  docker start keycloak oidc-test-app >/dev/null 2>&1
  docker restart caddy >/dev/null 2>&1
}
trap rollback ERR

docker stop oidc-test-app keycloak >/dev/null
docker rename keycloak "$KEYCLOAK_BACKUP"
docker rename oidc-test-app "$APP_BACKUP"

docker run -d \
  --name keycloak \
  --restart unless-stopped \
  --memory 2304m \
  --cpus 1.5 \
  --network go-portal \
  --env-file "$KEYCLOAK_ENV" \
  --mount type=bind,src=/opt/go-portal/import,dst=/opt/keycloak/data/import,readonly \
  --mount type=bind,src=/opt/go-portal/theme/ngenious-go,dst=/opt/keycloak/themes/ngenious-go,readonly \
  --publish 127.0.0.1:8080:8080 \
  --log-driver journald \
  "$keycloak_image" \
  start --import-realm >/dev/null

keycloak_ready=false
for attempt in $(seq 1 90); do
  if curl --max-time 5 -fsS \
    -H 'Host: id.ngenious.app' \
    http://127.0.0.1:8080/realms/go-portal-test/.well-known/openid-configuration \
    | jq -e '.issuer == "https://id.ngenious.app/realms/go-portal-test"' >/dev/null; then
    keycloak_ready=true
    break
  fi
  sleep 2
done
test "$keycloak_ready" = true

docker run -d \
  --name oidc-test-app \
  --restart unless-stopped \
  --memory 192m \
  --cpus 0.25 \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 1000:1000 \
  --env-file "$APP_ENV" \
  --mount type=bind,src=/opt/go-portal/test-app/server.mjs,dst=/app/server.mjs,readonly \
  --log-driver journald \
  "$app_image" \
  node /app/server.mjs >/dev/null

app_ready=false
for attempt in $(seq 1 30); do
  if curl --max-time 2 -fsS http://127.0.0.1:3000/healthz | grep -qx ok; then
    app_ready=true
    break
  fi
  sleep 1
done
test "$app_ready" = true

docker restart caddy >/dev/null

public_ready=false
for attempt in $(seq 1 90); do
  if curl --max-time 10 -fsS \
    https://id.ngenious.app/realms/go-portal-test/.well-known/openid-configuration \
    | jq -e '.issuer == "https://id.ngenious.app/realms/go-portal-test"' >/dev/null; then
    public_ready=true
    break
  fi
  sleep 2
done
test "$public_ready" = true

redirect_location=$(curl --max-time 10 -fsS -o /dev/null -w '%{redirect_url}' \
  https://got.ngenious.app/)
[[ "$redirect_location" == https://id.ngenious.app/realms/go-portal-test/* ]]

admin_status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' \
  https://controlt.ngenious.app/admin/master/console/)
[[ "$admin_status" == 200 || "$admin_status" == 302 ]]

trap - ERR
printf 'Identity host activated; rollback containers remain stopped.\n'
