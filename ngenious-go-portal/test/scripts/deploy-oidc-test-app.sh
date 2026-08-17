#!/bin/bash
set -euo pipefail

REALM=go-portal-test
CLIENT_ID=ngenious-oidc-test-app
TESTER_EMAIL=oidc.tester@example.invalid
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak
APP_CONTAINER=oidc-test-app
APP_ROOT=/opt/go-portal/test-app
APP_SOURCE=$APP_ROOT/server.mjs
APP_ENV=/opt/go-portal/secrets/oidc-test-app.env
NODE_IMAGE=docker.io/library/node:22-alpine
CADDYFILE=/opt/go-portal/caddy/Caddyfile
CADDYFILE_NEXT=/opt/go-portal/caddy/Caddyfile.next
CADDYFILE_BACKUP=/opt/go-portal/caddy/Caddyfile.pre-oidc-test

test -s "$APP_SOURCE"
test -s "$CADDYFILE"
install -d -m 0750 "$APP_ROOT"
chmod 0644 "$APP_SOURCE"

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
      -H 'Host: got.ngenious.app' \
      http://127.0.0.1:8080/realms/go-portal-test/.well-known/openid-configuration \
      | jq -e '.issuer == "https://got.ngenious.app/realms/go-portal-test"' >/dev/null; then
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
  RECOVERY_ADMIN_USER="oidc-deploy-$(openssl rand -hex 6)"
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

client_payload=$(jq -cn \
  --arg client_id "$CLIENT_ID" \
  '{
    clientId: $client_id,
    name: "ngenious protected OIDC test application",
    description: "Synthetic shared-test relying party only",
    enabled: true,
    protocol: "openid-connect",
    clientAuthenticatorType: "client-secret",
    publicClient: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    frontchannelLogout: true,
    redirectUris: ["https://got.ngenious.app/oidc/callback"],
    webOrigins: ["https://got.ngenious.app"],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": "https://got.ngenious.app/signed-out"
    }
  }')

client_uuid=$(kc get clients -r "$REALM" \
  -q clientId="$CLIENT_ID" --fields id,clientId | jq -r '.[0].id // empty')
if [[ -z "$client_uuid" ]]; then
  client_uuid=$(printf '%s' "$client_payload" | docker exec -i "$KEYCLOAK_CONTAINER" \
    /opt/keycloak/bin/kcadm.sh create clients -r "$REALM" -f - -i)
  printf 'Created OIDC client: %s\n' "$CLIENT_ID"
else
  printf '%s' "$client_payload" | docker exec -i "$KEYCLOAK_CONTAINER" \
    /opt/keycloak/bin/kcadm.sh update "clients/$client_uuid" -r "$REALM" -f - >/dev/null
  printf 'Updated OIDC client: %s\n' "$CLIENT_ID"
fi

client_secret=$(kc get "clients/$client_uuid/client-secret" -r "$REALM" | jq -er .value)

tester_id=$(kc get users -r "$REALM" \
  -q exact=true -q username="$TESTER_EMAIL" --fields id,username | jq -r '.[0].id // empty')
if [[ -z "$tester_id" ]]; then
  tester_id=$(kc create users -r "$REALM" \
    -s username="$TESTER_EMAIL" \
    -s email="$TESTER_EMAIL" \
    -s firstName=OIDC \
    -s lastName=Tester \
    -s enabled=true \
    -s emailVerified=true \
    -i)
  printf 'Created non-administrative synthetic tester: %s\n' "$TESTER_EMAIL"
else
  printf 'Synthetic tester already exists: %s\n' "$TESTER_EMAIL"
fi

tester_password="Ngt!2026-$(openssl rand -hex 6)"
docker exec \
  -e TESTER_PASSWORD="$tester_password" \
  "$KEYCLOAK_CONTAINER" \
  sh -c '/opt/keycloak/bin/kcadm.sh set-password \
    -r '"$REALM"' \
    --userid '"$tester_id"' \
    --new-password "$TESTER_PASSWORD" \
    --temporary >/dev/null'

session_secret=$(openssl rand -hex 32)
if [[ -s "$APP_ENV" ]]; then
  existing_session_secret=$(sed -n 's/^SESSION_SECRET=//p' "$APP_ENV" | head -n 1)
  if [[ -n "$existing_session_secret" ]]; then
    session_secret=$existing_session_secret
  fi
fi

umask 077
printf '%s\n' \
  'NODE_ENV=production' \
  'PORT=3000' \
  'APP_BASE_URL=https://got.ngenious.app' \
  'OIDC_ISSUER=https://got.ngenious.app/realms/go-portal-test' \
  "OIDC_CLIENT_ID=$CLIENT_ID" \
  "OIDC_CLIENT_SECRET=$client_secret" \
  "SESSION_SECRET=$session_secret" \
  > "$APP_ENV"
chmod 0600 "$APP_ENV"
unset client_secret session_secret existing_session_secret

docker pull "$NODE_IMAGE" >/dev/null
node_image_id=$(docker image inspect "$NODE_IMAGE" --format '{{.Id}}')

docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$APP_CONTAINER" \
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
  --mount type=bind,src="$APP_SOURCE",dst=/app/server.mjs,readonly \
  --log-driver journald \
  "$node_image_id" \
  node /app/server.mjs >/dev/null

ready=false
for attempt in $(seq 1 30); do
  if curl --max-time 2 -fsS http://127.0.0.1:3000/healthz | grep -qx ok; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true

rollback_caddy() {
  set +e
  if [[ -s "$CADDYFILE_BACKUP" ]]; then
    cp -p "$CADDYFILE_BACKUP" "$CADDYFILE"
    docker restart caddy >/dev/null 2>&1
  fi
}

if [[ -s "$CADDYFILE_NEXT" ]]; then
  if [[ ! -s "$CADDYFILE_BACKUP" ]]; then
    cp -p "$CADDYFILE" "$CADDYFILE_BACKUP"
  fi
  install -m 0640 "$CADDYFILE_NEXT" "$CADDYFILE"
fi

trap rollback_caddy ERR
docker exec caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker restart caddy >/dev/null
trap - ERR

printf 'Protected OIDC test application deployed with image %s.\n' "$node_image_id"
printf 'Temporary test username: %s\n' "$TESTER_EMAIL"
printf 'Temporary test password: %s\n' "$tester_password"
printf 'The tester must choose a private password at first sign-in.\n'
unset tester_password
