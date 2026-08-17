#!/bin/bash
set -euo pipefail

KEYCLOAK_IMAGE='quay.io/keycloak/keycloak@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13'
CADDY_IMAGE='docker.io/library/caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
KEYCLOAK_ENV=/opt/go-portal/secrets/keycloak.env
KEYCLOAK_ENV_BACKUP=/opt/go-portal/secrets/keycloak.env.pre-public
CADDY_ROOT=/opt/go-portal/caddy
THEME_ROOT=/opt/go-portal/theme/ngenious-go

test -s "$CADDY_ROOT/Caddyfile"
test -s "$THEME_ROOT/login/theme.properties"
test -s "$THEME_ROOT/login/resources/img/ngenious-logo.png"

docker pull "$CADDY_IMAGE"
cp -p "$KEYCLOAK_ENV" "$KEYCLOAK_ENV_BACKUP"

set_env_value() {
  local key=$1
  local value=$2
  if grep -q "^$key=" "$KEYCLOAK_ENV"; then
    sed -i "s|^$key=.*|$key=$value|" "$KEYCLOAK_ENV"
  else
    printf '%s=%s\n' "$key" "$value" >> "$KEYCLOAK_ENV"
  fi
}

set_env_value KC_HOSTNAME https://id.ngenious.app
if ! grep -q '^KC_HOSTNAME_ADMIN=' "$KEYCLOAK_ENV"; then
  set_env_value KC_HOSTNAME_ADMIN http://localhost:18080
fi
set_env_value KC_PROXY_HEADERS xforwarded
set_env_value KC_PROXY_TRUSTED_ADDRESSES 172.30.0.1

rollback_keycloak() {
  set +e
  docker rm -f keycloak >/dev/null 2>&1
  cp -p "$KEYCLOAK_ENV_BACKUP" "$KEYCLOAK_ENV"
  docker rename keycloak-pre-public keycloak >/dev/null 2>&1
  docker start keycloak >/dev/null 2>&1
}

docker stop keycloak >/dev/null
docker rename keycloak keycloak-pre-public
trap rollback_keycloak ERR

docker run -d \
  --name keycloak \
  --restart unless-stopped \
  --memory 2304m \
  --cpus 1.5 \
  --network go-portal \
  --env-file "$KEYCLOAK_ENV" \
  --mount type=bind,src=/opt/go-portal/import,dst=/opt/keycloak/data/import,readonly \
  --mount type=bind,src="$THEME_ROOT",dst=/opt/keycloak/themes/ngenious-go,readonly \
  --publish 127.0.0.1:8080:8080 \
  --log-driver journald \
  "$KEYCLOAK_IMAGE" \
  start --import-realm

ready=false
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

trap - ERR
docker rm keycloak-pre-public >/dev/null

install -d -m 0750 "$CADDY_ROOT/data" "$CADDY_ROOT/config" "$CADDY_ROOT/logs"
docker rm -f caddy >/dev/null 2>&1 || true
docker run -d \
  --name caddy \
  --restart unless-stopped \
  --memory 256m \
  --cpus 0.25 \
  --network host \
  --mount type=bind,src="$CADDY_ROOT/Caddyfile",dst=/etc/caddy/Caddyfile,readonly \
  --mount type=bind,src="$CADDY_ROOT/data",dst=/data \
  --mount type=bind,src="$CADDY_ROOT/config",dst=/config \
  --mount type=bind,src="$CADDY_ROOT/logs",dst=/var/log/caddy \
  --log-driver journald \
  "$CADDY_IMAGE" \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

echo 'Public customer portal configuration completed'
