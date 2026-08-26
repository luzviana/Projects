#!/bin/bash
set -euo pipefail

REALM=go-portal-test
CLIENT_ID=media-monitoring
SECRET_ID=ngenious/media-monitoring/test/oidc
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak

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
  printf 'Bootstrap administrator is unavailable; using a temporary local recovery administrator.\n'
  RECOVERY_ADMIN_USER="media-client-$(openssl rand -hex 6)"
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

client_payload=$(jq -cn --arg client_id "$CLIENT_ID" '{
  clientId:$client_id,
  name:"Streamer Monitor",
  description:"Ole Media direct application authentication",
  enabled:true,
  alwaysDisplayInConsole:true,
  protocol:"openid-connect",
  clientAuthenticatorType:"client-secret",
  publicClient:false,
  standardFlowEnabled:true,
  implicitFlowEnabled:false,
  directAccessGrantsEnabled:false,
  serviceAccountsEnabled:false,
  frontchannelLogout:true,
  rootUrl:"https://streamer.ngenious.app",
  baseUrl:"/",
  redirectUris:["https://streamer.ngenious.app/oauth2/callback"],
  webOrigins:["https://streamer.ngenious.app"],
  attributes:{
    "pkce.code.challenge.method":"S256",
    "post.logout.redirect.uris":"https://streamer.ngenious.app/*"
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
existing_json=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$SECRET_ID" \
  --query SecretString --output text)
cookie_secret=$(printf '%s' "$existing_json" | jq -r '.cookie_secret // "pending"')
if [[ "$cookie_secret" == pending ]]; then
  cookie_secret=$(openssl rand -base64 32 | tr -- '+/' '-_')
fi

secret_json=$(jq -cn \
  --arg client_id "$CLIENT_ID" \
  --arg client_secret "$client_secret" \
  --arg cookie_secret "$cookie_secret" \
  '{client_id:$client_id,client_secret:$client_secret,cookie_secret:$cookie_secret}')
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id "$SECRET_ID" \
  --secret-string "$secret_json" >/dev/null
unset client_secret cookie_secret existing_json secret_json

stored_client=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$SECRET_ID" \
  --query SecretString --output text | jq -er .client_id)
test "$stored_client" = "$CLIENT_ID"
printf 'Stored the client credentials in the restricted AWS secret.\n'
