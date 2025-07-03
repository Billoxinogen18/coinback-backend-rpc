import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import { ethers } from 'ethers';
import { connectDb } from '../db.js';
import dotenv from 'dotenv';
dotenv.config();
async function runRewardEpoch() {
    let dbPool;
    try {
        dbPool = await connectDb();
        const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
        const rewardTokenAddress = process.env.REWARD_TOKEN_ADDRESS;
        const cbkTokenAddress = process.env.CBK_TOKEN_ADDRESS;
        if (!rewardTokenAddress || !cbkTokenAddress) throw new Error("Missing reward or CBK token address.");
        const unprocessedTxsQuery = `
            SELECT t.transaction_pk, t.client_tx_hash, t.user_id, u.wallet_address, COALESCE(s.total_staked, 0) as total_staked_raw
            FROM Transactions t JOIN Users u ON t.user_id = u.user_id
            LEFT JOIN (
                SELECT user_id, SUM(staked_amount_raw) as total_staked FROM Staking
                WHERE unstake_date IS NULL AND staking_token_address = $1 GROUP BY user_id
            ) s ON t.user_id = s.user_id
            WHERE t.final_status = 'mined' AND t.reward_epoch_pk IS NULL;`;
        const { rows: transactions } = await dbPool.query(unprocessedTxsQuery, [cbkTokenAddress]);
        if (transactions.length === 0) { console.log("No new transactions to process."); return; }
        const userRewards = new Map();
        for (const tx of transactions) {
            const receipt = await provider.getTransactionReceipt(tx.client_tx_hash);
            if (!receipt) continue;
            const txFee = receipt.gasUsed * receipt.effectiveGasPrice;
            const rewardAmount = (txFee * 25n) / 100n; // Simplified 25% cashback
            if (userRewards.has(tx.user_id)) {
                userRewards.get(tx.user_id).amount += rewardAmount;
            } else {
                userRewards.set(tx.user_id, { userId: tx.user_id, account: tx.wallet_address, amount: rewardAmount });
            }
        }
        const rewardsData = Array.from(userRewards.values()).map((r, index) => ({ ...r, index }));
        if (rewardsData.length === 0) { console.log("No valid rewards calculated."); return; }
        const leaves = rewardsData.map(r => Buffer.from(ethers.solidityPackedKeccak256(['uint256', 'address', 'uint256'], [r.index, r.account, r.amount]).slice(2), 'hex'));
        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
        const client = await dbPool.connect();
        try {
            await client.query('BEGIN');
            const epochId = `epoch-${Date.now()}`;
            const { rows: [{ epoch_pk: epochPk }] } = await client.query('INSERT INTO RewardEpochs (epoch_id, merkle_root, reward_token_address, is_active) VALUES ($1, $2, $3, TRUE) RETURNING epoch_pk;', [epochId, tree.getHexRoot(), rewardTokenAddress]);
            for (const reward of rewardsData) {
                await client.query('INSERT INTO CashbackRewards (user_id, epoch_id, reward_amount_raw, reward_token_address, leaf_index, merkle_proof) VALUES ($1, $2, $3, $4, $5, $6);', [reward.userId, epochPk, reward.amount.toString(), rewardTokenAddress, reward.index, JSON.stringify(tree.getHexProof(leaves[reward.index]))]);
            }
            const txPks = transactions.map(tx => tx.transaction_pk);
            await client.query('UPDATE Transactions SET reward_epoch_pk = $1 WHERE transaction_pk = ANY($2::bigint[]);', [epochPk, txPks]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK'); throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Critical error in reward epoch:', err);
    } finally {
        if (dbPool) await dbPool.end();
    }
}
runRewardEpoch();
