#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak
ACTION_LIFESPAN_SECONDS=${ACTION_LIFESPAN_SECONDS:-43200}
DELETE_AFTER_SEND=${DELETE_AFTER_SEND:-false}
REPLACE_EXISTING=${REPLACE_EXISTING:-false}
RESEND_EXISTING=${RESEND_EXISTING:-false}

: "${USER_EMAIL:?Set USER_EMAIL}"
: "${FIRST_NAME:?Set FIRST_NAME}"
: "${LAST_NAME:?Set LAST_NAME}"
: "${ORGANIZATION_ALIAS:?Set ORGANIZATION_ALIAS}"

USER_EMAIL=${USER_EMAIL,,}
if [[ ! "$USER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  printf 'USER_EMAIL is not a valid email address.\n' >&2
  exit 2
fi
if [[ ! "$ACTION_LIFESPAN_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ACTION_LIFESPAN_SECONDS must be a positive number.\n' >&2
  exit 2
fi
if [[ "$DELETE_AFTER_SEND" != true && "$DELETE_AFTER_SEND" != false ]]; then
  printf 'DELETE_AFTER_SEND must be true or false.\n' >&2
  exit 2
fi
if [[ "$REPLACE_EXISTING" != true && "$REPLACE_EXISTING" != false ]]; then
  printf 'REPLACE_EXISTING must be true or false.\n' >&2
  exit 2
fi
if [[ "$RESEND_EXISTING" != true && "$RESEND_EXISTING" != false ]]; then
  printf 'RESEND_EXISTING must be true or false.\n' >&2
  exit 2
fi
if [[ "$REPLACE_EXISTING" = true && "$RESEND_EXISTING" = true ]]; then
  printf 'REPLACE_EXISTING and RESEND_EXISTING cannot both be true.\n' >&2
  exit 2
fi
if [[ "$RESEND_EXISTING" = true && "$DELETE_AFTER_SEND" = true ]]; then
  printf 'DELETE_AFTER_SEND cannot be used when resending to an existing identity.\n' >&2
  exit 2
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
user_created=false
cleanup() {
  set +e
  if [[ "$user_created" = true && "${invite_sent:-false}" != true ]]; then
    kc delete "users/$user_id" -r "$REALM" >/dev/null
    printf 'Rolled back the new user because the invitation was not sent.\n' >&2
  fi
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
  RECOVERY_ADMIN_USER="user-invite-$(openssl rand -hex 6)"
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

organization_id=$(kc get organizations -r "$REALM" --fields id,alias \
  | jq -er --arg alias "$ORGANIZATION_ALIAS" \
    '.[] | select(.alias == $alias) | .id')

existing_user_id=$(kc get users -r "$REALM" \
  -q exact=true -q username="$USER_EMAIL" \
  --fields id,username | jq -r '.[0].id // empty')
if [[ -n "$existing_user_id" ]]; then
  if [[ "$RESEND_EXISTING" = true ]]; then
    if ! kc get "organizations/$organization_id/members" -r "$REALM" \
      --fields id | jq -e --arg id "$existing_user_id" \
      '.[] | select(.id == $id)' >/dev/null; then
      printf 'The existing identity is not a member of organization %s; no invitation was sent.\n' \
        "$ORGANIZATION_ALIAS" >&2
      exit 4
    fi
    user_id=$existing_user_id
  elif [[ "$REPLACE_EXISTING" != true ]]; then
    printf 'The identity already exists; no organization or invitation change was made. Contact support for review.\n' >&2
    exit 3
  else
    kc delete "users/$existing_user_id" -r "$REALM" >/dev/null
    printf 'Removed the existing test identity before recreating it.\n'
  fi
fi

if [[ -z "$existing_user_id" || "$REPLACE_EXISTING" = true ]]; then
  user_id=$(kc create users -r "$REALM" \
    -s username="$USER_EMAIL" \
    -s email="$USER_EMAIL" \
    -s firstName="$FIRST_NAME" \
    -s lastName="$LAST_NAME" \
    -s enabled=true \
    -s emailVerified=false \
    -i)
  user_created=true

  kc create "organizations/$organization_id/members" \
    -r "$REALM" \
    -b "\"$user_id\"" >/dev/null
fi

printf '%s' '["VERIFY_EMAIL","UPDATE_PASSWORD"]' \
  | docker exec -i "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh update \
      "users/$user_id/execute-actions-email" \
      -r "$REALM" \
      -q lifespan="$ACTION_LIFESPAN_SECONDS" \
      -f - >/dev/null

invite_sent=true
if [[ "$RESEND_EXISTING" = true ]]; then
  printf 'Sent a fresh password-setup email to the existing identity in organization %s.\n' \
    "$ORGANIZATION_ALIAS"
else
  printf 'Created identity, assigned organization %s, and sent the password-setup email.\n' \
    "$ORGANIZATION_ALIAS"
fi

if [[ "$DELETE_AFTER_SEND" = true ]]; then
  kc delete "users/$user_id" -r "$REALM" >/dev/null
  user_created=false
  printf 'Deleted the synthetic invitation-test identity after delivery.\n'
fi
