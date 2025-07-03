#!/bin/bash
# FINAL MIGRATION: Corrects the siwe_nonce column to a single VARCHAR.

set -e

# --- Configuration ---
DB_SECRET_ARN="arn:aws:secretsmanager:us-east-1:788741120594:secret:prod/coinback/database"
DB_INSTANCE_IDENTIFIER="coinback-db-instance"
AWS_REGION="us-east-1"
MIGRATION_SQL_FILE="final_migration.sql"

# --- Styles ---
GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'

echo -e "${CYAN}--- Starting Final Database Migration ---${NC}"

# --- Pre-flight Checks ---
if ! command -v jq &> /dev/null; then echo -e "${RED}Error: 'jq' not installed.${NC}"; exit 1; fi
if ! command -v psql &> /dev/null; then echo -e "${RED}Error: 'psql' is not installed.${NC}"; exit 1; fi
if ! command -v curl &> /dev/null; then echo -e "${RED}Error: 'curl' is not installed.${NC}"; exit 1; fi
if ! aws sts get-caller-identity > /dev/null; then echo -e "${RED}Error: AWS CLI login required.${NC}"; exit 1; fi

# --- Get required information ---
CURRENT_IP=$(curl -s http://checkip.amazonaws.com)
SG_ID=$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_IDENTIFIER" --region "$AWS_REGION" --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)

# --- Define a cleanup function and set a trap ---
cleanup() {
    echo -e "\n${CYAN}--- Running cleanup ---${NC}"
    aws ec2 revoke-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 5432 --cidr "${CURRENT_IP}/32" --region "$AWS_REGION" > /dev/null 2>&1 || true
    rm -f "$MIGRATION_SQL_FILE"
    echo -e "${GREEN}✓ Firewall rule and temporary files removed.${NC}"
}
trap cleanup EXIT

# --- Authorize this machine's IP address ---
echo "Adding temporary firewall rule..."
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 5432 --cidr "${CURRENT_IP}/32" --region "$AWS_REGION" > /dev/null || true

# --- Create the SQL migration file ---
cat > "$MIGRATION_SQL_FILE" << 'EOF'
BEGIN;

-- Drop the old array column if it exists from a previous faulty migration
ALTER TABLE users DROP COLUMN IF EXISTS siwe_nonces;

-- Drop the old single column if it exists to ensure a clean slate
ALTER TABLE users DROP COLUMN IF EXISTS siwe_nonce;

-- Add the correct single-use nonce column
ALTER TABLE users ADD COLUMN siwe_nonce VARCHAR(255);

COMMIT;
EOF

# --- Fetch credentials ---
FULL_SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --region "$AWS_REGION")
DB_HOST=$(echo "$FULL_SECRET_JSON" | jq -r '.SecretString | fromjson | .DB_HOST')
DB_USER=$(echo "$FULL_SECRET_JSON" | jq -r '.SecretString | fromjson | .DB_USER')
DB_PASSWORD=$(echo "$FULL_SECRET_JSON" | jq -r '.SecretString | fromjson | .DB_PASSWORD')
DB_NAME=$(echo "$FULL_SECRET_JSON" | jq -r '.SecretString | fromjson | .DB_NAME')
DB_PORT_FROM_SECRET=$(echo "$FULL_SECRET_JSON" | jq -r '.SecretString | fromjson | .port')
if [ "$DB_PORT_FROM_SECRET" = "null" ] || [ -z "$DB_PORT_FROM_SECRET" ]; then DB_PORT="5432"; else DB_PORT="$DB_PORT_FROM_SECRET"; fi

# --- Run the migration ---
export PGPASSWORD="$DB_PASSWORD"
echo "Applying migration to database '${DB_NAME}'..."
psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" --file="$MIGRATION_SQL_FILE" --quiet
unset PGPASSWORD
echo -e "${GREEN}✓ Migration successfully applied.${NC}"
