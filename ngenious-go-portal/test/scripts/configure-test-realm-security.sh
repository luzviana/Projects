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

docker exec "$KEYCLOAK_CONTAINER" \
  /opt/keycloak/bin/kcadm.sh update "realms/$REALM" \
    -s 'passwordPolicy=length(8) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1)' \
    -s bruteForceProtected=true \
    -s permanentLockout=false \
    -s maxFailureWaitSeconds=900 \
    -s minimumQuickLoginWaitSeconds=60 \
    -s waitIncrementSeconds=60 \
    -s quickLoginCheckMilliSeconds=1000 \
    -s maxDeltaTimeSeconds=43200 \
    -s failureFactor=5

docker exec "$KEYCLOAK_CONTAINER" \
  /opt/keycloak/bin/kcadm.sh get "realms/$REALM" \
    --fields realm,passwordPolicy,bruteForceProtected,permanentLockout,maxFailureWaitSeconds,minimumQuickLoginWaitSeconds,waitIncrementSeconds,failureFactor
