#!/bin/bash

# Shared authentication for operator scripts that use the restricted ControlT
# service account. The caller must run as root because the credential never
# leaves the host's root-only secrets directory.

CONTROLT_ENV=${CONTROLT_ENV:-/opt/go-portal/secrets/controlt.env}
KEYCLOAK_CONTAINER=${KEYCLOAK_CONTAINER:-keycloak}

controlt_authenticate() {
  local permissions owner

  [[ -f "$CONTROLT_ENV" ]] || {
    printf 'Missing ControlT credential file: %s\n' "$CONTROLT_ENV" >&2
    return 1
  }

  owner=$(stat -c '%U:%G' "$CONTROLT_ENV")
  permissions=$(stat -c '%a' "$CONTROLT_ENV")
  if [[ "$owner" != root:root || "$permissions" != 600 ]]; then
    printf 'Unsafe ControlT credential permissions: expected root:root:600.\n' >&2
    return 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$CONTROLT_ENV"
  set +a

  : "${KEYCLOAK_REALM:?Missing KEYCLOAK_REALM in $CONTROLT_ENV}"
  : "${KEYCLOAK_ADMIN_CLIENT_ID:?Missing KEYCLOAK_ADMIN_CLIENT_ID in $CONTROLT_ENV}"
  : "${KEYCLOAK_ADMIN_CLIENT_SECRET:?Missing KEYCLOAK_ADMIN_CLIENT_SECRET in $CONTROLT_ENV}"

  REALM=$KEYCLOAK_REALM
  docker exec \
    -e KC_REALM="$KEYCLOAK_REALM" \
    -e KC_CLIENT_ID="$KEYCLOAK_ADMIN_CLIENT_ID" \
    -e KC_CLIENT_SECRET="$KEYCLOAK_ADMIN_CLIENT_SECRET" \
    "$KEYCLOAK_CONTAINER" \
    sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
      --server http://localhost:8080 \
      --realm "$KC_REALM" \
      --client "$KC_CLIENT_ID" \
      --secret "$KC_CLIENT_SECRET" >/dev/null'

  unset KEYCLOAK_ADMIN_CLIENT_SECRET CONTROLT_SESSION_SECRET KC_CLIENT_SECRET
}

kc() {
  docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}
