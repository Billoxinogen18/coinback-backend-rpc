import { ethers } from 'ethers';

async function stakingRoutes(fastify, options) {
  const db = fastify.db;

  fastify.get('/summary', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { userId, walletAddress } = request.user;
    try {
      const cbkTokenAddress = process.env.CBK_TOKEN_ADDRESS;
      let stakingContractAddress = process.env.STAKING_CONTRACT_ADDRESS;
      if (!stakingContractAddress) {
        // Fallback to hard-coded address used in the frontend (kept in sync)
        stakingContractAddress = '0xa4F5D4AFD8697D35c5d5A4A9E51683f76Fb863f9';
      }
      const rpcUrl = process.env.ETHEREUM_RPC_URL;

      if (!cbkTokenAddress || !stakingContractAddress || !rpcUrl) {
        throw new Error("Backend missing CBK_TOKEN_ADDRESS, STAKING_CONTRACT_ADDRESS or ETHEREUM_RPC_URL env.");
      }

      // Fetch live on-chain balances first
      let onChainCbkRaw = "0";
      let onChainStakedRaw = "0";
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const erc20 = new ethers.Contract(
          cbkTokenAddress,
          ['function balanceOf(address) view returns (uint256)'],
          provider
        );

        const staking = new ethers.Contract(
          stakingContractAddress,
          ['function stakedBalances(address) view returns (uint256)'],
          provider
        );

        onChainCbkRaw = (await erc20.balanceOf(walletAddress)).toString();
        onChainStakedRaw = (await staking.stakedBalances(walletAddress)).toString();
      } catch (chainErr) {
        request.log.error({ msg: 'Error fetching on-chain balances', chainErr });
      }

      // Fall back to DB values if on-chain fetch failed (still useful for other analytics)
      const [dbStakedRes, dbBalRes] = await Promise.all([
        db.query(
          `SELECT COALESCE(SUM(staked_amount_raw), 0) as total_staked_raw
           FROM staking WHERE user_id = $1 AND staking_token_address = $2 AND unstake_date IS NULL`,
          [userId, cbkTokenAddress]
        ),
        db.query('SELECT cbk_balance_raw FROM users WHERE user_id = $1', [userId])
      ]);

      const dbStakedRaw = dbStakedRes.rows[0]?.total_staked_raw || "0";
      const dbBalanceRaw = dbBalRes.rows.length > 0 ? (dbBalRes.rows[0].cbk_balance_raw || "0") : "0";

      // Prefer on-chain values if non-zero, else use DB
      const finalStakedRaw = onChainStakedRaw !== "0" ? onChainStakedRaw : dbStakedRaw;
      const finalBalanceRaw = onChainCbkRaw !== "0" ? onChainCbkRaw : dbBalanceRaw;

      const getRewardTier = (stakedAmount) => {
        const staked = parseFloat(ethers.formatUnits(stakedAmount, 18));
        if (staked >= 100000) return 'Gold';
        if (staked >= 30000) return 'Silver';
        if (staked > 0) return 'Bronze';
        return null;
      };

      return {
        stakedAmount: ethers.formatUnits(finalStakedRaw, 18),
        stakedAmountRaw: finalStakedRaw,
        cbkBalance: ethers.formatUnits(finalBalanceRaw, 18),
        cbkBalanceRaw: finalBalanceRaw,
        tokenAddress: cbkTokenAddress,
        rewardTier: getRewardTier(finalStakedRaw),
      };
    } catch (err) {
      request.log.error({ msg: 'Error fetching staking summary', userId, err });
      reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
}

export default stakingRoutes;