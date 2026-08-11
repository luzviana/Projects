#!/bin/bash
set -euo pipefail

REALM=go-portal-test
ADMIN_SECRET=ngenious-go-portal/test/bootstrap-admin
KEYCLOAK_CONTAINER=keycloak

ADMIN_JSON=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$ADMIN_SECRET" \
  --query SecretString \
  --output text)
ADMIN_USER=$(printf '%s' "$ADMIN_JSON" | jq -r .username)
ADMIN_PASSWORD=$(printf '%s' "$ADMIN_JSON" | jq -r .password)

docker exec \
  -e ADMIN_USER="$ADMIN_USER" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  "$KEYCLOAK_CONTAINER" \
  sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user "$ADMIN_USER" \
    --password "$ADMIN_PASSWORD" >/dev/null'

unset ADMIN_JSON ADMIN_USER ADMIN_PASSWORD

ensure_organization() {
  local name=$1
  local alias=$2

  if docker exec "$KEYCLOAK_CONTAINER" \
    /opt/keycloak/bin/kcadm.sh get organizations \
      -r "$REALM" \
      --fields alias | jq -e --arg alias "$alias" \
        'any(.[]; .alias == $alias)' >/dev/null; then
    printf 'Organization already exists: %s\n' "$alias"
    return
  fi

  docker exec "$KEYCLOAK_CONTAINER" \
    /opt/keycloak/bin/kcadm.sh create organizations \
      -r "$REALM" \
      -s name="$name" \
      -s alias="$alias" \
      -s enabled=true
}

ensure_organization 'Prototype Customer Alpha' prototype-alpha
ensure_organization 'Prototype Customer Beta' prototype-beta

docker exec "$KEYCLOAK_CONTAINER" \
  /opt/keycloak/bin/kcadm.sh get organizations \
    -r "$REALM" \
    --fields id,name,alias,enabled

