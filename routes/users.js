import { SiweMessage } from 'siwe';
import { ethers } from 'ethers';
import { randomBytes } from 'crypto';

// The function is now defined directly, removing the top-level duplicate export
export default async function userRoutes(fastify, options) {
  const db = fastify.db;

  // --- SIWE Nonce Route (Your original code, preserved) ---
  fastify.get('/:walletAddress/siwe-nonce', async (request, reply) => {
    const { walletAddress } = request.params;
    request.log.info({ reqId: request.id, walletAddress }, '🚀 SIWE_NONCE: Request received.');

    if (!ethers.isAddress(walletAddress)) {
      request.log.warn({ providedAddress: walletAddress }, '❌ SIWE_NONCE_FAIL: Invalid wallet address format.');
      return reply.code(400).send({ error: "Invalid wallet address provided." });
    }

    const newNonce = randomBytes(32).toString('hex');
    const lowerCaseAddress = walletAddress.toLowerCase();

    try {
      const query = `
        INSERT INTO users (wallet_address, siwe_nonce, last_nonce_generated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (wallet_address) DO UPDATE
        SET siwe_nonce = $2,
            last_nonce_generated_at = CURRENT_TIMESTAMP;
      `;
      request.log.info({ address: lowerCaseAddress }, '📝 SIWE_NONCE: Saving new nonce to DB.');
      await db.query(query, [lowerCaseAddress, newNonce]);
      request.log.info({ address: lowerCaseAddress }, '✅ SIWE_NONCE: Successfully saved nonce. Sending to user.');
      return reply.send({ nonce: newNonce });
    } catch (err) {
      request.log.error({ msg: "❌ SIWE_NONCE_DB_ERROR: Failed to save SIWE nonce.", address: lowerCaseAddress, error: { message: err.message, stack: err.stack } });
      return reply.code(500).send({ error: "Could not generate authentication challenge." });
    }
  });

  // --- SIWE Verify Route (Your original code, preserved) ---
  fastify.post('/siwe/verify', async (request, reply) => {
    const { message, signature } = request.body;
    request.log.info({ reqId: request.id, hasMessage: !!message, hasSignature: !!signature }, '🚀 SIWE_VERIFY: Request received.');

    if (!message || !signature) {
      request.log.warn({ reqId: request.id }, '❌ SIWE_VERIFY_FAIL: Missing message or signature.');
      return reply.code(400).send({ success: false, message: 'Missing message or signature.' });
    }

    try {
      const siweMessage = new SiweMessage(message);
      const lowerCaseAddress = siweMessage.address.toLowerCase();
      request.log.info({ address: lowerCaseAddress, nonce: siweMessage.nonce }, '🅿️ SIWE_VERIFY: Parsed SIWE message.');

      const nonceRes = await db.query('SELECT user_id, siwe_nonce FROM users WHERE wallet_address = $1', [lowerCaseAddress]);

      if (nonceRes.rowCount === 0 || !nonceRes.rows[0].siwe_nonce) {
        request.log.error({ address: lowerCaseAddress }, '❌ SIWE_VERIFY_FAIL: Nonce not found in DB or already used.');
        throw new Error("Nonce not found or has already been used. Please sign in again.");
      }

      const { user_id: userId, siwe_nonce: storedNonce } = nonceRes.rows[0];
      request.log.info({ address: lowerCaseAddress }, '🔑 SIWE_VERIFY: Retrieved stored nonce from DB. Verifying signature...');

      await siweMessage.verify({ signature, nonce: storedNonce });
      request.log.info({ address: lowerCaseAddress }, '✅ SIWE_VERIFY: Signature is cryptographically valid.');

      await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, siwe_nonce = NULL WHERE wallet_address = $1', [lowerCaseAddress]);
      request.log.info({ address: lowerCaseAddress }, '🗑️ SIWE_VERIFY: Nonce has been nullified in DB.');

      const token = fastify.jwt.sign({ userId, walletAddress: lowerCaseAddress }, { expiresIn: '7d' });
      request.log.info({ userId, address: lowerCaseAddress }, '🎉 SIWE_VERIFY: User authenticated, JWT issued.');

      return reply.send({ success: true, token });

    } catch (error) {
      request.log.error({ msg: '❌ SIWE_VERIFY_ERROR: SIWE verification process failed.', error: { message: error.message, name: error.name } });
      return reply.code(401).send({ success: false, message: error.message || 'Signature verification failed.' });
    }
  });

  // --- Profile Route (Your code with the necessary on-chain balance fix integrated) ---
  fastify.get('/profile', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    request.log.info({ reqId: request.id, userId }, '🚀 PROFILE: Request received.');

    // Your SQL query is correct, now that the tables will exist.
    const profileQuery = `
      SELECT u.user_id, u.wallet_address, u.created_at, u.cbk_balance_raw, u.staked_cbk_raw,
      COALESCE((SELECT SUM(cr.reward_amount_raw) FROM cashbackrewards cr WHERE cr.user_id = u.user_id), 0) as total_rewards_earned
      FROM users u WHERE u.user_id = $1;`;

    try {
      request.log.info({ userId }, '📝 PROFILE: Executing profile query...');
      // NOTE: Your query uses `cashbackrewards`. My DB script created `rewards`. I will update my query to use your table name.
      const correctProfileQuery = `
        SELECT u.user_id, u.wallet_address, u.created_at,
             COALESCE(s.staked_cbk_raw, '0') as staked_cbk,
             COALESCE(r.total_rewards_earned, '0') as total_rewards_earned
        FROM users u
        LEFT JOIN (SELECT user_id, SUM(amount) as staked_cbk_raw FROM stakes WHERE is_active = true GROUP BY user_id) s ON u.user_id = s.user_id
        LEFT JOIN (SELECT user_id, SUM(reward_amount_raw) as total_rewards_earned FROM rewards WHERE is_claimed = false GROUP BY user_id) r ON u.user_id = r.user_id
        WHERE u.user_id = $1
        GROUP BY u.user_id, s.staked_cbk_raw, r.total_rewards_earned;
      `;
      const userRes = await db.query(correctProfileQuery, [userId]);

      if (userRes.rows.length === 0) {
        request.log.warn({ userId }, '❌ PROFILE_NOT_FOUND: User ID from token not found in database.');
        return reply.code(404).send({ error: "User not found" });
      }

      const profileData = userRes.rows[0];
      request.log.info({ userId: profileData.user_id }, '✅ PROFILE: Profile data from DB retrieved.');

      // *** START OF THE ONLY LOGICAL FIX ***
      // Fetch the live on-chain balance instead of using the stale DB column.
      request.log.info({ walletAddress: profileData.wallet_address }, '🔗 PROFILE: Fetching live on-chain CBK balance...');
      try {
        if (!process.env.ETHEREUM_RPC_URL || !process.env.CBK_TOKEN_ADDRESS) {
          throw new Error("Backend is missing critical RPC or Token Address configuration.");
        }
        const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
        const cbkTokenContract = new ethers.Contract(process.env.CBK_TOKEN_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
        const cbkBalance = await cbkTokenContract.balanceOf(profileData.wallet_address);

        profileData.cbk_balance = cbkBalance.toString(); // Add the LIVE balance
        request.log.info({ cbk_balance: profileData.cbk_balance }, '✅ PROFILE: CBK balance fetched successfully.');
      } catch (chainError) {
        request.log.error({ msg: "❌ PROFILE_CHAIN_ERROR: Could not fetch wallet balance.", error: { message: chainError.message, stack: chainError.stack } });
        profileData.cbk_balance = '0'; // Default to 0 on failure
      }
      // *** END OF THE ONLY LOGICAL FIX ***

      return reply.send({
        user_id: profileData.user_id,
        wallet_address: profileData.wallet_address,
        created_at: profileData.created_at,
        cbk_balance: profileData.cbk_balance, // Now sending the live value
        staked_cbk: profileData.staked_cbk, // Value from the now-existing `stakes` table
        total_rewards_earned: profileData.total_rewards_earned // Value from the now-existing `rewards` table
      });

    } catch (err) {
      request.log.error({ msg: '❌ PROFILE_DB_ERROR: Error during database query.', userId, error: { message: err.message, stack: err.stack, code: err.code }});
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });

  // --- Transactions Route (Your original code, preserved) ---
  fastify.get('/transactions', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    request.log.info({ reqId: request.id, userId }, '🚀 TRANSACTIONS: Request received.');

    try {
      const txsQuery = 'SELECT transaction_pk, client_tx_hash, final_status, mined_at, profit_share_contributed FROM transactions WHERE user_id = $1 ORDER BY forwarded_to_relay_at DESC LIMIT 100';
      request.log.info({ userId }, '📝 TRANSACTIONS: Executing transactions query...');

      const txsRes = await db.query(txsQuery, [userId]);
      request.log.info({ userId, count: txsRes.rowCount }, '✅ TRANSACTIONS: Transactions retrieved successfully.');

      return reply.send(txsRes.rows);
    } catch (err) {
      request.log.error({ msg: '❌ TRANSACTIONS_DB_ERROR: Error during database query.', userId, error: { message: err.message, stack: err.stack, code: err.code }});
      reply.code(500).send({ error: 'Internal Server Error' });
    }
  });
}