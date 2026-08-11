#!/bin/bash
set -euo pipefail

AWS_PROFILE=${AWS_PROFILE:-ai-coder}
AWS_REGION=${AWS_REGION:-us-east-1}
EXPECTED_ACCOUNT=919519434125
INSTANCE_ROLE_ARN=arn:aws:iam::919519434125:role/ngenious-go-portal-test-instance

account_id=$(aws sts get-caller-identity \
  --profile "$AWS_PROFILE" \
  --query Account \
  --output text)

if [[ "$account_id" != "$EXPECTED_ACCOUNT" ]]; then
  printf 'Refusing to continue in AWS account %s; expected %s.\n' \
    "$account_id" "$EXPECTED_ACCOUNT" >&2
  exit 1
fi

ensure_secret() {
  local secret_name=$1
  local email=$2
  local first_name=$3
  local last_name=$4
  local secret_arn
  local policy
  local password
  local secret_payload

  if secret_arn=$(aws secretsmanager describe-secret \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --secret-id "$secret_name" \
    --query ARN \
    --output text 2>/dev/null); then
    printf 'Secret already exists: %s\n' "$secret_name"
  else
    password=$(aws secretsmanager get-random-password \
      --profile "$AWS_PROFILE" \
      --region "$AWS_REGION" \
      --password-length 24 \
      --exclude-characters '"\/@' \
      --query RandomPassword \
      --output text)
    secret_payload=$(jq -cn \
      --arg email "$email" \
      --arg firstName "$first_name" \
      --arg lastName "$last_name" \
      --arg password "$password" \
      '{email: $email, firstName: $firstName, lastName: $lastName, password: $password}')
    secret_arn=$(printf '%s' "$secret_payload" | \
      aws secretsmanager create-secret \
        --profile "$AWS_PROFILE" \
        --region "$AWS_REGION" \
        --name "$secret_name" \
        --description 'Synthetic ngenious Go Portal customer administrator; shared-test only' \
        --secret-string file:///dev/stdin \
        --query ARN \
        --output text)
    unset password secret_payload
    printf 'Created secret: %s\n' "$secret_name"
  fi

  policy=$(jq -cn \
    --arg principal "$INSTANCE_ROLE_ARN" \
    --arg resource "$secret_arn" \
    '{Version: "2012-10-17", Statement: [{Sid: "AllowTestPortalInstanceRead", Effect: "Allow", Principal: {AWS: $principal}, Action: "secretsmanager:GetSecretValue", Resource: $resource}]}')

  aws secretsmanager put-resource-policy \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --secret-id "$secret_arn" \
    --resource-policy "$policy" \
    --block-public-policy >/dev/null
  printf 'Restricted instance access applied: %s\n' "$secret_name"
}

ensure_secret \
  ngenious-go-portal/test/synthetic-admin-alpha \
  prototype.alpha.admin@example.invalid \
  Prototype \
  'Alpha Admin'

ensure_secret \
  ngenious-go-portal/test/synthetic-admin-beta \
  prototype.beta.admin@example.invalid \
  Prototype \
  'Beta Admin'
