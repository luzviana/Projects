#!/bin/bash
set -euo pipefail

AWS_REGION=${AWS_REGION:-us-east-1}
EXPECTED_ACCOUNT=919519434125
DASHBOARD_INSTANCE_ID=i-0b15fb8a59fccd618
DASHBOARD_ROLE=media-monitoring-test-instance
DASHBOARD_PROFILE=media-monitoring-test-instance
IDENTITY_ROLE_ARN=arn:aws:iam::919519434125:role/ngenious-go-portal-test-instance
SECRET_NAME=ngenious/media-monitoring/test/oidc

account_id=$(aws sts get-caller-identity --query Account --output text)
if [[ "$account_id" != "$EXPECTED_ACCOUNT" ]]; then
  printf 'Refusing to continue in AWS account %s; expected %s.\n' \
    "$account_id" "$EXPECTED_ACCOUNT" >&2
  exit 1
fi

trust_policy=$(jq -cn '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"ec2.amazonaws.com"},Action:"sts:AssumeRole"}]}')
if ! aws iam get-role --role-name "$DASHBOARD_ROLE" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$DASHBOARD_ROLE" \
    --assume-role-policy-document "$trust_policy" >/dev/null
  printf 'Created dashboard instance role.\n'
fi

secret_arn=$(aws secretsmanager describe-secret \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_NAME" \
  --query ARN --output text 2>/dev/null || true)
if [[ -z "$secret_arn" ]]; then
  secret_arn=$(aws secretsmanager create-secret \
    --region "$AWS_REGION" \
    --name "$SECRET_NAME" \
    --description 'Media Monitoring shared-test OIDC client and cookie secret' \
    --secret-string '{"client_id":"media-monitoring","client_secret":"pending","cookie_secret":"pending"}' \
    --query ARN --output text)
  printf 'Created private OIDC secret.\n'
fi

read_policy=$(jq -cn --arg resource "$secret_arn" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"secretsmanager:GetSecretValue",Resource:$resource}]}')
aws iam put-role-policy \
  --role-name "$DASHBOARD_ROLE" \
  --policy-name read-media-monitoring-oidc-secret \
  --policy-document "$read_policy"
aws iam attach-role-policy \
  --role-name "$DASHBOARD_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

resource_policy=$(jq -cn \
  --arg identity "$IDENTITY_ROLE_ARN" \
  --arg dashboard "arn:aws:iam::${EXPECTED_ACCOUNT}:role/${DASHBOARD_ROLE}" \
  --arg resource "$secret_arn" \
  '{Version:"2012-10-17",Statement:[
    {Sid:"IdentityHostWritesClientSecret",Effect:"Allow",Principal:{AWS:$identity},Action:["secretsmanager:GetSecretValue","secretsmanager:PutSecretValue"],Resource:$resource},
    {Sid:"DashboardReadsClientSecret",Effect:"Allow",Principal:{AWS:$dashboard},Action:"secretsmanager:GetSecretValue",Resource:$resource}
  ]}')
aws secretsmanager put-resource-policy \
  --region "$AWS_REGION" \
  --secret-id "$secret_arn" \
  --resource-policy "$resource_policy" \
  --block-public-policy >/dev/null

if ! aws iam get-instance-profile --instance-profile-name "$DASHBOARD_PROFILE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$DASHBOARD_PROFILE" >/dev/null
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$DASHBOARD_PROFILE" \
    --role-name "$DASHBOARD_ROLE"
  # IAM needs a short period to make a new instance profile attachable.
  sleep 10
fi

association_id=$(aws ec2 describe-iam-instance-profile-associations \
  --region "$AWS_REGION" \
  --filters "Name=instance-id,Values=${DASHBOARD_INSTANCE_ID}" \
  --query 'IamInstanceProfileAssociations[0].AssociationId' \
  --output text)
if [[ "$association_id" == None ]]; then
  aws ec2 associate-iam-instance-profile \
    --region "$AWS_REGION" \
    --instance-id "$DASHBOARD_INSTANCE_ID" \
    --iam-instance-profile "Name=${DASHBOARD_PROFILE}" >/dev/null
  printf 'Attached the restricted dashboard instance profile.\n'
fi

printf 'Media Monitoring OIDC secret and least-privilege instance access are ready.\n'
