import { ethers } from 'ethers';

async function rewardsRoutes(fastify, options) {
  const db = fastify.db;

  fastify.get('/claimable', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    request.log.info({ reqId: request.id, userId }, '🚀 REWARDS_CLAIMABLE: Request received.');

    try {
      // FINAL FIX: Changed 'e.is_active = TRUE' to 'e.status = \'active\'' to match the database schema.
      const query = `
        SELECT r.reward_pk, e.epoch_id, r.reward_type, r.reward_amount_raw, r.reward_token_address,
               r.reward_token_symbol, e.merkle_root, r.leaf_index, r.merkle_proof
        FROM cashbackrewards r
        JOIN rewardepochs e ON r.epoch_id = e.epoch_pk
        WHERE r.user_id = $1 AND r.status = 'pending_claim' AND e.status = 'active'`;
      
      request.log.info({ userId }, '📝 REWARDS_CLAIMABLE: Executing DB query...');
      const rewardsRes = await db.query(query, [userId]);
      request.log.info({ userId, count: rewardsRes.rowCount }, '✅ REWARDS_CLAIMABLE: DB query successful.');

      if (rewardsRes.rows.length === 0) {
        request.log.info({ userId }, 'ℹ️ REWARDS_CLAIMABLE: No claimable rewards found for user.');
        return { claimableAmountDisplay: '0.00000', claims: [] };
      }

      let totalClaimableEthEquivalent = ethers.toBigInt(0);
      const claims = rewardsRes.rows.map(row => {
        if (row.reward_token_symbol && (row.reward_token_symbol.toUpperCase() === 'ETH' || row.reward_token_symbol.toUpperCase() === 'WETH')) {
            totalClaimableEthEquivalent += ethers.toBigInt(row.reward_amount_raw || '0');
        }
        return {
          rewardId: row.reward_pk,
          epochId: row.epoch_id,
          type: row.reward_type,
          amountRaw: row.reward_amount_raw.toString(),
          amountFormatted: ethers.formatUnits(row.reward_amount_raw, 18),
          tokenAddress: row.reward_token_address,
          tokenSymbol: row.reward_token_symbol,
          merkleRoot: row.merkle_root,
          proof: row.merkle_proof,
          leafIndex: row.leaf_index
        };
      });

      const responsePayload = {
        claimableAmountDisplay: ethers.formatUnits(totalClaimableEthEquivalent, 18),
        claims: claims
      };

      request.log.info({ userId, claimsCount: claims.length }, '✅ REWARDS_CLAIMABLE: Successfully processed rewards. Sending response.');
      return reply.send(responsePayload);

    } catch (err) {
      request.log.error({ msg: '❌ REWARDS_CLAIMABLE_ERROR: Failed to fetch claimable rewards.', userId, error: { message: err.message, stack: err.stack, code: err.code } });
      reply.code(500).send({ error: 'Internal Server Error while fetching rewards.' });
    }
  });
}

export default rewardsRoutes;