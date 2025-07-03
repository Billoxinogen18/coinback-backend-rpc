import { ethers } from 'ethers';
import { createRequire } from 'module';

// Debug logging
console.log("Starting rpc.js initialization with timestamp:", new Date().toISOString());

const require = createRequire(import.meta.url);
console.log("createRequire initialized");

let rpcRoutes;

// Debug logging for mev-share-client loading
try {
  console.log("Loading @flashbots/mev-share-client");
  const mevShareClientPackage = require('@flashbots/mev-share-client');
  console.log("Package loaded:", Object.keys(mevShareClientPackage));
  const MevShareClient = mevShareClientPackage.default;
  console.log("MevShareClient extracted:", typeof MevShareClient);

  rpcRoutes = async function(fastify, options) {
    console.log("rpcRoutes function called");
    const db = fastify.db;
    
    try {
      // Get the RPC URL from the environment
      const rpcUrl = process.env.RPC_URL_INTERNAL || process.env.ETHEREUM_RPC_URL;
      console.log("Using RPC URL:", rpcUrl);
      if (!rpcUrl) {
        console.error("ERROR: No RPC URL found in environment variables");
        throw new Error("No RPC URL provided");
      }

      console.log("Creating provider and wallet");
      const publicProvider = new ethers.JsonRpcProvider(rpcUrl);
      console.log("Provider created");
      
      if (!process.env.FLASHBOTS_AUTH_KEY) {
        console.error("ERROR: No FLASHBOTS_AUTH_KEY found in environment");
        throw new Error("No Flashbots auth key provided");
      }

      const authWallet = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY, publicProvider);
      console.log("Auth wallet created");
      
      console.log("Setting up Sepolia network");
      // Create a custom Sepolia network configuration
      const sepoliaNetwork = {
        name: 'sepolia',
        chainId: 11155111,
        streamUrl: 'https://mev-share-sepolia.flashbots.net',
        apiUrl: 'https://relay-sepolia.flashbots.net',
      };
      
      console.log("Initializing MevShareClient");
      // Initialize MevShareClient with the custom network configuration
      const mevShareClient = new MevShareClient(authWallet, sepoliaNetwork);
      console.log("MevShareClient initialized successfully");
      
      fastify.options('/', async (request, reply) => {
        return reply.code(204).send();
      });

      const getUserIdFromWalletAddress = async (walletAddress) => {
        if (!walletAddress || !ethers.isAddress(walletAddress)) return null;
        try {
            const userRes = await db.query('SELECT user_id FROM Users WHERE wallet_address = $1', [walletAddress.toLowerCase()]);
            return userRes.rows.length > 0 ? userRes.rows[0].user_id : null;
        } catch (dbError) {
            return null;
        }
      };

      fastify.post('/', async (request, reply) => {
        const { method, params, id, jsonrpc = "2.0" } = request.body;
        switch (method) {
          case 'eth_sendTransaction':
            return reply.code(405).send({
              jsonrpc,
              id,
              error: {
                code: -32601,
                message: `The 'eth_sendTransaction' method is not supported. Please sign the transaction locally and use 'eth_sendRawTransaction'.`,
              },
            });
          case 'eth_sendRawTransaction':
            const rawTx = params && params[0];
            if (typeof rawTx !== 'string' || !rawTx.startsWith('0x')) {
              return reply.code(400).send({ jsonrpc, id, error: { code: -32602, message: 'Invalid raw transaction format' } });
            }
            if (!mevShareClient) {
              return reply.code(503).send({ jsonrpc, id, error: { code: -32001, message: 'MEV protection service is currently unavailable.' } });
            }
            try {
              const decodedTx = ethers.Transaction.from(rawTx);
              const senderAddress = decodedTx.from;
              const userId = await getUserIdFromWalletAddress(senderAddress);
              
              // Update sendTransaction method signature to match the library's expected format
              const flashbotsResponse = await mevShareClient.sendTransaction(rawTx, { 
                hints: {
                  calldata: true,
                  logs: true,
                  contract_address: true,
                  function_selector: true,
                  hash: true
                }
              });
              
              if (userId) {
                  await db.query(
                      'INSERT INTO Transactions (user_id, client_tx_hash, raw_transaction, forwarded_to_relay_at, relay_name, final_status) VALUES ($1, $2, $3, NOW(), $4, $5)',
                      [userId, flashbotsResponse, rawTx, 'FlashbotsMEVShare', 'submitted_to_relay']
                  );
              }
              return reply.send({ jsonrpc, id, result: flashbotsResponse });
            } catch (error) {
              console.error("Error in eth_sendRawTransaction:", error);
              return reply.code(500).send({ jsonrpc, id, error: { code: -32000, message: `Internal error: ${error.message}` } });
            }
          default:
            try {
                if (!publicProvider) {
                     return reply.code(503).send({ jsonrpc, id, error: { code: -32002, message: 'Read-only service is currently unavailable.' } });
                }
                console.log(`Forwarding RPC method: ${method}`);
                const result = await publicProvider.send(method, params);
                return reply.send({ jsonrpc, id, result });
            } catch (error) {
                console.error(`Error in ${method}:`, error);
                return reply.code(500).send({ jsonrpc, id, error: { code: -32000, message: `Error processing ${method}: ${error.message}` } });
            }
        }
      });
    } catch (error) {
      console.error("Error in rpcRoutes setup:", error);
      throw error;
    }
  };

} catch (error) {
  console.error("Critical error loading MevShareClient:", error);
  rpcRoutes = async function(fastify, options) {
    fastify.get('/', async (request, reply) => {
      return reply.code(503).send({ error: 'MEV-Share client initialization failed' });
    });
  };
}

export default rpcRoutes; 