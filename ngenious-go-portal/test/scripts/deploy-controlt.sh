#!/bin/bash
set -Eeuo pipefail

STAGED_ROOT=/tmp/controlt-deploy
STAGED_APP=$STAGED_ROOT/controlt
STAGED_CADDYFILE=$STAGED_ROOT/Caddyfile
RELEASES_ROOT=/opt/go-portal/controlt-releases
CURRENT_LINK=/opt/go-portal/controlt
SECRETS_FILE=/opt/go-portal/secrets/controlt.env
CADDYFILE=/opt/go-portal/caddy/Caddyfile
CONTAINER=controlt
BACKUP_CONTAINER=controlt-pre-deploy
NODE_IMAGE=docker.io/library/node:22-alpine

test -s "$STAGED_APP/server.mjs"
test -s "$STAGED_APP/package.json"
test -s "$STAGED_CADDYFILE"
test -s "$SECRETS_FILE"
test -s "$CADDYFILE"
[[ $(stat -c '%U:%G:%a' "$SECRETS_FILE") == root:root:600 ]]
for required_key in \
  KEYCLOAK_INTERNAL_URL KEYCLOAK_ISSUER KEYCLOAK_REALM \
  KEYCLOAK_ADMIN_CLIENT_ID KEYCLOAK_ADMIN_CLIENT_SECRET \
  CONTROLT_OIDC_CLIENT_ID CONTROLT_OIDC_CLIENT_SECRET \
  CONTROLT_SESSION_SECRET; do
  grep -q "^${required_key}=.." "$SECRETS_FILE"
done
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  printf '%s must be a release symlink.\n' "$CURRENT_LINK" >&2
  exit 1
fi
previous_release=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)

node_image=$(docker image inspect "$NODE_IMAGE" --format '{{.Id}}' 2>/dev/null || true)
if [[ -z "$node_image" ]]; then
  docker pull "$NODE_IMAGE" >/dev/null
  node_image=$(docker image inspect "$NODE_IMAGE" --format '{{.Id}}')
fi
caddy_image=$(docker inspect caddy --format '{{.Image}}')

docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 1000:1000 \
  --mount type=bind,src="$STAGED_APP",dst=/app,readonly \
  --workdir /app \
  "$node_image" npm run check >/dev/null

docker run --rm \
  --mount type=bind,src="$STAGED_CADDYFILE",dst=/etc/caddy/Caddyfile,readonly \
  "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

release="$RELEASES_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0750 "$RELEASES_ROOT" "$release"
cp -a "$STAGED_APP/." "$release/"
chown -R root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
ln -sfn "$release" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

caddy_backup=$(mktemp /opt/go-portal/caddy/Caddyfile.pre-controlt.XXXXXX)
cp -p "$CADDYFILE" "$caddy_backup"

if docker container inspect "$BACKUP_CONTAINER" >/dev/null 2>&1; then
  archived_backup="${BACKUP_CONTAINER}-$(date -u +%Y%m%dT%H%M%SZ)"
  docker rename "$BACKUP_CONTAINER" "$archived_backup"
  printf 'Older rollback container preserved as %s.\n' "$archived_backup"
fi

had_previous=false
previous_stopped=false
previous_renamed=false
new_container_attempted=false
rollback() {
  status=$?
  trap - ERR
  set +e
  if [[ "$new_container_attempted" == true ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
  if [[ "$previous_renamed" == true ]]; then
    docker rename "$BACKUP_CONTAINER" "$CONTAINER" >/dev/null 2>&1
    docker start "$CONTAINER" >/dev/null 2>&1
  elif [[ "$previous_stopped" == true ]]; then
    docker start "$CONTAINER" >/dev/null 2>&1
  fi
  if [[ -n "$previous_release" ]]; then
    ln -sfn "$previous_release" "$CURRENT_LINK.next"
    mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
  else
    rm -f -- "$CURRENT_LINK"
  fi
  cp -p "$caddy_backup" "$CADDYFILE"
  docker restart caddy >/dev/null 2>&1
  printf 'ControlT deployment rolled back.\n' >&2
  exit "$status"
}
trap rollback ERR

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  had_previous=true
  docker stop "$CONTAINER" >/dev/null
  previous_stopped=true
  docker rename "$CONTAINER" "$BACKUP_CONTAINER"
  previous_renamed=true
fi

new_container_attempted=true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --memory 192m \
  --cpus 0.25 \
  --network go-portal \
  --publish 127.0.0.1:3100:3100 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 1000:1000 \
  --env-file "$SECRETS_FILE" \
  --env NODE_ENV=production \
  --env PORT=3100 \
  --mount type=bind,src="$release",dst=/app,readonly \
  --workdir /app \
  --log-driver journald \
  "$node_image" node server.mjs >/dev/null

ready=false
for attempt in $(seq 1 30); do
  if curl --max-time 2 -fsS http://127.0.0.1:3100/healthz \
    | jq -e '.status == "ok"' >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true

install -o root -g root -m 0640 "$STAGED_CADDYFILE" "$CADDYFILE"
docker restart caddy >/dev/null

public_ready=false
for attempt in $(seq 1 45); do
  if curl --max-time 10 -fsS https://controlt.ngenious.app/healthz \
    | jq -e '.status == "ok"' >/dev/null; then
    public_ready=true
    break
  fi
  sleep 2
done
test "$public_ready" = true

root_status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' \
  https://controlt.ngenious.app/)
root_location=$(curl --max-time 10 -sS -o /dev/null -w '%{redirect_url}' \
  https://controlt.ngenious.app/)
api_status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' \
  https://controlt.ngenious.app/api/organizations)
login_location=$(curl --max-time 10 -sS -o /dev/null -w '%{redirect_url}' \
  https://controlt.ngenious.app/auth/login)
[[ "$root_status" == 302 ]]
[[ "$root_location" == https://id.ngenious.app/realms/go-portal-test/* ]]
[[ "$api_status" == 401 ]]
[[ "$login_location" == https://id.ngenious.app/realms/go-portal-test/* ]]

trap - ERR
rm -f -- "$caddy_backup"
if [[ "$had_previous" == true ]]; then
  printf 'Previous ControlT container retained as %s for rollback.\n' "$BACKUP_CONTAINER"
fi
printf 'ControlT deployed from %s without restarting Keycloak.\n' "$release"
printf 'Automatic authentication redirect and protected API boundary verified.\n'
