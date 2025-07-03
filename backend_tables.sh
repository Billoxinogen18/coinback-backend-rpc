#!/bin/bash

# --- Configuration ---
REGION="us-east-1"
DB_SECRET_NAME="prod/coinback/database"
DB_INSTANCE_ID="coinback-db-instance"

# --- Styles ---
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}--- Definitive Database Schema FINALIZATION Script ---${NC}"

# --- Step 1: Fetch Credentials ---
echo "[1/4] Fetching database credentials..."
SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "${DB_SECRET_NAME}" --region "${REGION}" --query 'SecretString' --output text)
if [ -z "${SECRET_JSON}" ]; then echo -e "${RED}Error: Could not retrieve secret. Aborting.${NC}"; exit 1; fi
DB_HOST=$(echo "${SECRET_JSON}" | jq -r .DB_HOST)
DB_USER=$(echo "${SECRET_JSON}" | jq -r .DB_USER)
DB_NAME=$(echo "${SECRET_JSON}" | jq -r .DB_NAME)
DB_PASSWORD=$(echo "${SECRET_JSON}" | jq -r .DB_PASSWORD)
echo -e "${GREEN}✓ Credentials fetched.${NC}"

# --- Step 2: Confirm Firewall Access ---
echo "[2/4] Verifying database security group access..."
MY_IP=$(curl -s http://checkip.amazonaws.com)
RDS_SG_ID=$(aws rds describe-db-instances --db-instance-identifier ${DB_INSTANCE_ID} --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text --region ${REGION})

aws ec2 authorize-security-group-ingress --group-id "${RDS_SG_ID}" --protocol tcp --port 5432 --cidr "${MY_IP}/32" --region "${REGION}" > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Access rule for your IP (${MY_IP}) is active. Waiting 10 seconds...${NC}"
sleep 10

# --- Step 3 & 4: Execute SQL to Create Missing Tables ---
echo "[3/4] Creating the 'stakes' table if it does not exist..."
export PGPASSWORD="${DB_PASSWORD}"

psql --host="${DB_HOST}" --port="5432" --username="${DB_USER}" --dbname="${DB_NAME}" --quiet <<-'EOSQL'
    CREATE TABLE IF NOT EXISTS stakes (
        stake_id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(user_id),
        amount NUMERIC(78, 0) NOT NULL, -- For uint256
        transaction_hash VARCHAR(66) UNIQUE NOT NULL,
        staked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE INDEX IF NOT EXISTS idx_stakes_user_id_active ON stakes (user_id) WHERE is_active = true;
EOSQL

echo -e "${GREEN}✓ 'stakes' table check complete.${NC}"

echo "[4/4] Creating the 'rewards' table if it does not exist..."
psql --host="${DB_HOST}" --port="5432" --username="${DB_USER}" --dbname="${DB_NAME}" --quiet <<-'EOSQL'
    CREATE TABLE IF NOT EXISTS rewards (
        reward_id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(user_id),
        epoch_id VARCHAR(255) NOT NULL,
        merkle_root VARCHAR(66) NOT NULL,
        leaf_index INT NOT NULL,
        proof JSONB,
        reward_amount_raw NUMERIC(78, 0) NOT NULL,
        is_claimed BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at TIMESTAMPTZ,
        CONSTRAINT unique_user_epoch UNIQUE (user_id, epoch_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rewards_user_id_unclaimed ON rewards (user_id) WHERE is_claimed = false;
EOSQL

unset PGPASSWORD
echo -e "${GREEN}✓ 'rewards' table check complete.${NC}"
echo -e "\n${GREEN}✓✓✓ Database schema is now complete. Please redeploy your backend. ✓✓✓${NC}"