#!/bin/bash
set -euo pipefail

REALM=go-portal-test
KEYCLOAK_CONTAINER=keycloak
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/keycloak-controlt.sh
source "$SCRIPT_DIR/lib/keycloak-controlt.sh"
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

user_created=false
cleanup() {
  set +e
  if [[ "$user_created" = true && "${invite_sent:-false}" != true ]]; then
    kc delete "users/$user_id" -r "$REALM" >/dev/null
    printf 'Rolled back the new user because the invitation was not sent.\n' >&2
  fi
  unset KEYCLOAK_ADMIN_CLIENT_SECRET CONTROLT_SESSION_SECRET
}
trap cleanup EXIT

controlt_authenticate

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
