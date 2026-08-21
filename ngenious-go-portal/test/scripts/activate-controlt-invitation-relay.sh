#!/bin/bash
set -Eeuo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
CONTROLT_CONTAINER=controlt

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

recovery_admin_created=false
cleanup() {
  local status=$?
  set +e
  if [[ "$recovery_admin_created" = true ]]; then
    recovery_admin_id=$(kc get users -r master \
      -q exact=true -q username="$RECOVERY_ADMIN_USER" \
      --fields id,username | jq -r '.[0].id // empty')
    if [[ -n "$recovery_admin_id" ]]; then
      kc delete "users/$recovery_admin_id" -r master >/dev/null
    fi
  fi
  unset RECOVERY_ADMIN_USER RECOVERY_ADMIN_PASSWORD recovery_admin_id
  exit "$status"
}
trap cleanup EXIT

test "$(docker inspect "$CONTROLT_CONTAINER" --format '{{.State.Running}}')" = true
docker exec "$CONTROLT_CONTAINER" node -e \
  'const net=require("node:net");const socket=net.connect(2525,"127.0.0.1",()=>socket.end());socket.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),3000).unref()'

if ! kc get "realms/$REALM" --fields realm >/dev/null 2>&1; then
  RECOVERY_ADMIN_USER="invitation-relay-$(openssl rand -hex 6)"
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

original_smtp=$(kc get "realms/$REALM" --fields smtpServer | jq -c '.smtpServer // {}')
smtp_payload=$(jq -cn '{smtpServer: {
  host: "controlt",
  port: "2525",
  auth: "false",
  starttls: "false",
  ssl: "false",
  from: "no-reply@ngenious.app",
  fromDisplayName: "ngenious"
}}')

if ! kc update "realms/$REALM" -b "$smtp_payload" >/dev/null; then
  kc update "realms/$REALM" -b "$(jq -cn --argjson smtp "$original_smtp" '{smtpServer:$smtp}')" >/dev/null 2>&1 || true
  exit 1
fi

saved=$(kc get "realms/$REALM" --fields smtpServer | jq -c .smtpServer)
printf '%s' "$saved" | jq -e '
  .host == "controlt" and .port == "2525" and
  .auth == "false" and .starttls == "false" and .ssl == "false" and
  .from == "no-reply@ngenious.app" and
  (.username == null) and (.password == null) and (.replyTo == null)' >/dev/null

printf 'Keycloak identity email now uses the internal Control invitation relay.\n'
printf 'Postmark credentials remain only in the protected Control environment file.\n'
