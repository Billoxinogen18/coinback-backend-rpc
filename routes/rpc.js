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
            console.error("Error getting user ID from wallet address:", dbError);
            return null;
        }
      };

      fastify.post('/', async (request, reply) => {
        const { method, params, id, jsonrpc = "2.0" } = request.body;
        console.log(`Forwarding RPC method: ${method}`);
        
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
            
            try {
              // Decode the transaction to get its details
              const decodedTx = ethers.Transaction.from(rawTx);
              const senderAddress = decodedTx.from;
              const txHash = decodedTx.hash;
              const userId = await getUserIdFromWalletAddress(senderAddress);
              
              console.log(`Processing transaction from ${senderAddress}, hash: ${txHash}, data: ${decodedTx.data ? decodedTx.data.substring(0, 20) + '...' : 'empty'}`);
              
              // Check if this transaction has already been recorded
              let existingTx = null;
              try {
                  existingTx = await db.query(
                      'SELECT transaction_pk, final_status FROM Transactions WHERE client_tx_hash = $1',
                      [txHash]
                  );
              } catch (dbError) {
                  console.error("Error checking for existing transaction:", dbError);
                  // Continue even if DB query fails
              }
              
              // If transaction exists and was already sent to relay, return the original tx hash
              if (existingTx && existingTx.rows.length > 0) {
                  console.log(`Transaction ${txHash} already exists in database with status: ${existingTx.rows[0].final_status}`);
                  return reply.send({ jsonrpc, id, result: txHash });
              }
              
              // CHANGED APPROACH: First try using the standard provider directly to avoid Flashbots issues
              try {
                  // Add more detailed logging
                  console.log(`Sending transaction ${txHash} via standard provider. Gas price: ${decodedTx.gasPrice?.toString() || 'auto'}, gas limit: ${decodedTx.gasLimit?.toString() || 'auto'}`);
                  
                  // Bypass Flashbots and send directly via provider to fix circuit breaker issues
                  const result = await publicProvider.send(method, params);
                  console.log(`Transaction ${txHash} sent via standard provider, result: ${result}`);
                  
                  // Record in database only if we have a user ID
                  if (userId) {
                      try {
                          // If the transaction doesn't exist, insert it
                          if (!existingTx || existingTx.rows.length === 0) {
                              await db.query(
                                  'INSERT INTO Transactions (user_id, client_tx_hash, raw_transaction, forwarded_to_relay_at, relay_name, final_status) VALUES ($1, $2, $3, NOW(), $4, $5)',
                                  [userId, txHash, rawTx, 'StandardProvider', 'submitted']
                              );
                              console.log(`Transaction recorded in database with hash: ${txHash}`);
                          } else {
                              // If it exists but failed previously, update its status
                              await db.query(
                                  'UPDATE Transactions SET forwarded_to_relay_at = NOW(), final_status = $1, relay_name = $2 WHERE client_tx_hash = $3',
                                  ['submitted', 'StandardProvider', txHash]
                              );
                              console.log(`Transaction ${txHash} status updated in database`);
                          }
                      } catch (dbError) {
                          // Check specifically for duplicate key error
                          if (dbError.code === '23505') {
                              console.log(`Duplicate transaction ${txHash} detected, continuing`);
                          } else {
                              console.error("Database error in transaction recording:", dbError);
                          }
                          // Continue even if DB insert fails - don't block the transaction submission
                      }
                  }
                  return reply.send({ jsonrpc, id, result });
              } catch (providerError) {
                  console.error("Error sending transaction via standard provider:", providerError);
                  
                  // Only try Flashbots as a fallback if the standard provider fails and if Flashbots is available
                  if (mevShareClient) {
                      try {
                          // Send transaction to Flashbots as fallback
                          console.log(`Trying Flashbots as fallback for transaction ${txHash}`);
                          const flashbotsResponse = await mevShareClient.sendTransaction(rawTx, { 
                              hints: {
                                  calldata: true,
                                  logs: true,
                                  contract_address: true,
                                  function_selector: true,
                                  hash: true
                              }
                          });
                          console.log(`Transaction ${txHash} sent to Flashbots, response: ${flashbotsResponse}`);
                          
                          // Update database with Flashbots info
                          if (userId) {
                              try {
                                  if (!existingTx || existingTx.rows.length === 0) {
                                      await db.query(
                                          'INSERT INTO Transactions (user_id, client_tx_hash, raw_transaction, forwarded_to_relay_at, relay_name, final_status) VALUES ($1, $2, $3, NOW(), $4, $5)',
                                          [userId, txHash, rawTx, 'FlashbotsMEVShare', 'submitted_to_relay']
                                      );
                                  } else {
                                      await db.query(
                                          'UPDATE Transactions SET forwarded_to_relay_at = NOW(), final_status = $1, relay_name = $2 WHERE client_tx_hash = $3',
                                          ['submitted_to_relay', 'FlashbotsMEVShare', txHash]
                                      );
                                  }
                              } catch (dbError) {
                                  console.error("Database error after Flashbots submission:", dbError);
                              }
                          }
                          return reply.send({ jsonrpc, id, result: txHash });
                      } catch (flashbotsError) {
                          console.error("Both standard provider and Flashbots failed:", flashbotsError);
                          return reply.send({ 
                              jsonrpc, 
                              id, 
                              error: { 
                                  code: -32000, 
                                  message: `Transaction failed with both providers: ${providerError.message}` 
                              } 
                          });
                      }
                  } else {
                      // If Flashbots is not available, return the standard provider error
                      return reply.send({ 
                          jsonrpc, 
                          id, 
                          error: { 
                              code: -32000, 
                              message: `Transaction failed: ${providerError.message}` 
                          } 
                      });
                  }
              }
            } catch (error) {
              console.error("Error in eth_sendRawTransaction:", error);
              return reply.send({ jsonrpc, id, error: { code: -32000, message: `Internal error: ${error.message}` } });
            }
            
          case 'eth_call':
            // Special handling for eth_call to properly handle contract revert errors
            try {
                if (!publicProvider) {
                    return reply.code(503).send({ jsonrpc, id, error: { code: -32002, message: 'Read-only service is currently unavailable.' } });
                }
                
                const result = await publicProvider.send(method, params);
                return reply.send({ jsonrpc, id, result });
            } catch (error) {
                console.error(`Error in ${method}:`, error);
                
                // For eth_call, pass through the original error with proper RPC error formatting
                // This is critical for contract interaction to work properly
                const errorResponse = {
                    jsonrpc,
                    id,
                    error: {
                        code: -32000,
                        message: error.message || "Unknown error",
                        data: error.info || error.data || null
                    }
                };
                
                // Instead of returning 500, return 200 with the error in the expected JSON-RPC format
                // This allows the client to properly handle contract reverts
                return reply.send(errorResponse);
            }
            
          default:
            try {
                if (!publicProvider) {
                    return reply.code(503).send({ jsonrpc, id, error: { code: -32002, message: 'Read-only service is currently unavailable.' } });
                }
                
                const result = await publicProvider.send(method, params);
                return reply.send({ jsonrpc, id, result });
            } catch (error) {
                console.error(`Error in ${method}:`, error);
                
                // For other methods, also use JSON-RPC error format but with less detail
                return reply.send({ 
                    jsonrpc, 
                    id, 
                    error: { 
                        code: -32000, 
                        message: `Error processing ${method}: ${error.message}` 
                    } 
                });
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