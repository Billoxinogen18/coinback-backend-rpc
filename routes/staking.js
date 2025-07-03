import { ethers } from 'ethers';

async function stakingRoutes(fastify, options) {
  const db = fastify.db;

  fastify.get('/summary', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    try {
      const cbkTokenAddress = process.env.CBK_TOKEN_ADDRESS;
      if (!cbkTokenAddress) throw new Error("CBK Token address is not configured.");
      
      // FIXED: Corrected table name to all lowercase
      const stakeRes = await db.query(
        `SELECT COALESCE(SUM(staked_amount_raw), 0) as total_staked_raw
         FROM staking WHERE user_id = $1 AND staking_token_address = $2 AND unstake_date IS NULL`,
        [userId, cbkTokenAddress]
      );
      const totalStakedRaw = stakeRes.rows[0].total_staked_raw || "0";

      // FIXED: Corrected table name to all lowercase
      const userProfileRes = await db.query('SELECT cbk_balance_raw FROM users WHERE user_id = $1', [userId]);
      const cbkBalanceRaw = userProfileRes.rows.length > 0 ? (userProfileRes.rows[0].cbk_balance_raw || "0") : "0";

      const getRewardTier = (stakedAmount) => {
          const staked = parseFloat(ethers.formatUnits(stakedAmount, 18));
          if (staked >= 100000) return 'Gold';
          if (staked >= 30000) return 'Silver';
          if (staked > 0) return 'Bronze';
          return null;
      };
      return {
        stakedAmount: ethers.formatUnits(totalStakedRaw, 18), stakedAmountRaw: totalStakedRaw.toString(),
        cbkBalance: ethers.formatUnits(cbkBalanceRaw, 18), cbkBalanceRaw: cbkBalanceRaw.toString(),
        tokenAddress: cbkTokenAddress, rewardTier: getRewardTier(totalStakedRaw),
      };
    } catch (err) {
      request.log.error({ msg: 'Error fetching staking summary', userId, err });
      reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
}

export default stakingRoutes;