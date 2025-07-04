import { ethers } from 'ethers';
import { connectDb } from '../db.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * This worker checks for transactions in the 'submitted' state and updates
 * their status to 'mined' or 'failed' once they're confirmed on the blockchain.
 * It also retrieves receipt data like gas used and gas price for reward calculations.
 */
async function updateTransactionStatuses() {
    let dbPool;
    
    try {
        console.log("Starting transaction status update process...");
        dbPool = await connectDb();
        const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);

        // Get all transactions in 'submitted' state
        const pendingTxsQuery = `
            SELECT transaction_pk, client_tx_hash 
            FROM Transactions 
            WHERE final_status = 'submitted' AND forwarded_to_relay_at < NOW() - INTERVAL '5 minutes'
            ORDER BY forwarded_to_relay_at DESC
            LIMIT 100;`;

        console.log("Querying for pending transactions...");
        const { rows: pendingTxs } = await dbPool.query(pendingTxsQuery);
        
        if (pendingTxs.length === 0) {
            console.log("No pending transactions to update.");
            return;
        }
        
        console.log(`Found ${pendingTxs.length} pending transactions to check.`);
        
        // Check each transaction's status
        for (const tx of pendingTxs) {
            try {
                console.log(`Checking status of transaction ${tx.client_tx_hash}...`);
                const receipt = await provider.getTransactionReceipt(tx.client_tx_hash);
                
                if (receipt) {
                    // Transaction is confirmed
                    const status = receipt.status === 1 ? 'mined' : 'failed';
                    const blockNumber = receipt.blockNumber;
                    const gasUsed = receipt.gasUsed;
                    const effectiveGasPrice = receipt.effectiveGasPrice;
                    const miner = receipt.miner || receipt.to; // Depending on network, might be called 'miner' or 'to'
                    
                    console.log(`Transaction ${tx.client_tx_hash} is confirmed with status: ${status}`);
                    console.log(`Block: ${blockNumber}, Gas used: ${gasUsed}, Gas price: ${effectiveGasPrice}`);
                    
                    // Calculate the transaction fee
                    const txFee = gasUsed && effectiveGasPrice 
                        ? gasUsed * effectiveGasPrice 
                        : null;
                    
                    // Update the transaction in the database
                    await dbPool.query(`
                        UPDATE Transactions 
                        SET final_status = $1, 
                            mined_at = NOW(), 
                            block_number = $2, 
                            gas_used = $3, 
                            effective_gas_price = $4
                        WHERE transaction_pk = $5
                    `, [status, blockNumber, gasUsed?.toString(), effectiveGasPrice?.toString(), tx.transaction_pk]);
                    
                    console.log(`Updated transaction ${tx.client_tx_hash} in database.`);
                } else {
                    // Transaction is still pending or not found
                    console.log(`Transaction ${tx.client_tx_hash} is still pending or not found.`);
                    
                    // Check if transaction is very old and might be stuck or dropped
                    // This query gets the transaction's age
                    const { rows: txAge } = await dbPool.query(`
                        SELECT forwarded_to_relay_at 
                        FROM Transactions 
                        WHERE transaction_pk = $1
                    `, [tx.transaction_pk]);
                    
                    if (txAge.length > 0) {
                        const ageInHours = (Date.now() - new Date(txAge[0].forwarded_to_relay_at).getTime()) / (1000 * 60 * 60);
                        
                        // If transaction is more than 24 hours old, mark as probably dropped
                        if (ageInHours > 24) {
                            console.log(`Transaction ${tx.client_tx_hash} is more than 24 hours old and still pending. Marking as 'likely_dropped'.`);
                            
                            await dbPool.query(`
                                UPDATE Transactions 
                                SET final_status = 'likely_dropped'
                                WHERE transaction_pk = $1
                            `, [tx.transaction_pk]);
                        }
                    }
                }
            } catch (txError) {
                console.error(`Error processing transaction ${tx.client_tx_hash}:`, txError);
            }
        }
        
        console.log("Transaction status update process completed.");
        
    } catch (err) {
        console.error('Critical error in transaction status update process:', err);
    } finally {
        if (dbPool) {
            await dbPool.end();
        }
    }
}

// Run the function
updateTransactionStatuses()
    .then(() => console.log("Transaction status update process finished."))
    .catch(err => console.error("Fatal error in transaction status update process:", err))
    .finally(() => process.exit(0)); // Exit when done to allow for cron scheduling 