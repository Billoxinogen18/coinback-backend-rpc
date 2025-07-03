CREATE TABLE IF NOT EXISTS Users (
    user_id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(42) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE,
    mev_protection_active BOOLEAN DEFAULT true,
    cbk_balance NUMERIC(78, 0) DEFAULT 0,
    staked_cbk NUMERIC(78, 0) DEFAULT 0,
    siwe_nonce VARCHAR(255),
    last_nonce_generated_at TIMESTAMP WITH TIME ZONE,
    cbk_balance_raw NUMERIC(78, 0) DEFAULT 0,
    staked_cbk_raw NUMERIC(78, 0) DEFAULT 0
);
CREATE TABLE IF NOT EXISTS Staking (
    stake_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES Users(user_id) ON DELETE CASCADE,
    staking_token_address VARCHAR(42) NOT NULL,
    staked_amount_raw NUMERIC(78, 0) NOT NULL,
    stake_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    unstake_date TIMESTAMP WITH TIME ZONE
);
CREATE TABLE IF NOT EXISTS RewardEpochs (
    epoch_pk SERIAL PRIMARY KEY,
    epoch_id VARCHAR(100) UNIQUE NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE,
    total_rewards_in_root NUMERIC(78, 0) DEFAULT 0,
    reward_token_address VARCHAR(42),
    merkle_root VARCHAR(66),
    is_active BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS CashbackRewards (
    reward_pk SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES Users(user_id) ON DELETE CASCADE,
    epoch_id INTEGER NOT NULL REFERENCES RewardEpochs(epoch_pk) ON DELETE CASCADE,
    reward_type VARCHAR(50) NOT NULL,
    reward_amount_raw NUMERIC(78, 0) NOT NULL,
    reward_token_address VARCHAR(42) NOT NULL,
    reward_token_symbol VARCHAR(10) NOT NULL,
    leaf_index INTEGER,
    merkle_proof JSONB,
    status VARCHAR(20) DEFAULT 'pending_claim'
);
CREATE TABLE IF NOT EXISTS Transactions (
    transaction_pk SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES Users(user_id) ON DELETE CASCADE,
    client_tx_hash VARCHAR(66) UNIQUE,
    raw_transaction TEXT NOT NULL,
    forwarded_to_relay_at TIMESTAMP WITH TIME ZONE,
    relay_name VARCHAR(50),
    bundle_id VARCHAR(66),
    block_number BIGINT,
    final_status VARCHAR(50),
    mined_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    gas_used BIGINT,
    effective_gas_price NUMERIC(78, 0),
    eth_sent_to_fee_recipient NUMERIC(78, 0),
    profit NUMERIC(78, 0),
    profit_share_contributed NUMERIC(78, 0),
    reward_epoch_pk INTEGER REFERENCES RewardEpochs(epoch_pk) ON DELETE SET NULL
);
