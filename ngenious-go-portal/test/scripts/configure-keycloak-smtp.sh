#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
SMTP_SECRET=${SMTP_SECRET:-ngenious-go-portal/test/smtp}
KEYCLOAK_CONTAINER=keycloak

SMTP_JSON=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$SMTP_SECRET" \
  --query SecretString \
  --output text)

configured=$(printf '%s' "$SMTP_JSON" | jq -er '.configured')
[[ "$configured" == true ]] || {
  printf 'The SMTP secret is not configured. No realm change was made.\n' >&2
  exit 2
}

smtp_host=$(printf '%s' "$SMTP_JSON" | jq -er '.host')
smtp_port=$(printf '%s' "$SMTP_JSON" | jq -er '.port | tostring')
smtp_user=$(printf '%s' "$SMTP_JSON" | jq -er '.username')
smtp_password=$(printf '%s' "$SMTP_JSON" | jq -er '.password')
smtp_from=$(printf '%s' "$SMTP_JSON" | jq -er '.from')
smtp_from_name=$(printf '%s' "$SMTP_JSON" | jq -er '.fromDisplayName')
smtp_reply_to=$(printf '%s' "$SMTP_JSON" | jq -r '.replyTo // empty')

[[ "$smtp_port" =~ ^[1-9][0-9]*$ ]]
[[ "$smtp_from" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
if [[ -n "$smtp_reply_to" ]]; then
  [[ "$smtp_reply_to" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
fi

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
  unset SMTP_JSON smtp_password ADMIN_JSON ADMIN_PASSWORD \
    RECOVERY_ADMIN_USER RECOVERY_ADMIN_PASSWORD recovery_admin_id
}
trap cleanup EXIT

if ! authenticate_admin "$ADMIN_USER" "$ADMIN_PASSWORD"; then
  RECOVERY_ADMIN_USER="smtp-config-$(openssl rand -hex 6)"
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

smtp_payload=$(jq -cn \
  --arg host "$smtp_host" \
  --arg port "$smtp_port" \
  --arg user "$smtp_user" \
  --arg password "$smtp_password" \
  --arg from "$smtp_from" \
  --arg from_name "$smtp_from_name" \
  --arg reply_to "$smtp_reply_to" \
  '{smtpServer: {
      host: $host,
      port: $port,
      auth: "true",
      starttls: "true",
      ssl: "false",
      user: $user,
      password: $password,
      from: $from,
      fromDisplayName: $from_name
    }}
    | if $reply_to == "" then . else
        .smtpServer.replyTo = $reply_to |
        .smtpServer.replyToDisplayName = $from_name
      end')

kc update "realms/$REALM" -b "$smtp_payload" >/dev/null
unset smtp_payload smtp_password

saved_smtp=$(kc get "realms/$REALM" --fields smtpServer)
printf '%s' "$saved_smtp" | jq -e \
  --arg host "$smtp_host" \
  --arg port "$smtp_port" \
  --arg from "$smtp_from" \
  '.smtpServer.host == $host and
   .smtpServer.port == $port and
   .smtpServer.from == $from and
   .smtpServer.auth == "true" and
   .smtpServer.starttls == "true" and
   (.smtpServer.password | length > 0)' >/dev/null

printf 'Configured Keycloak SMTP delivery through %s without printing credentials.\n' \
  "$smtp_host"
