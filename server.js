import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwtPlugin from '@fastify/jwt';
import dotenv from 'dotenv';
import { connectDb, getDb } from './db.js';
import rpcRoutes from './routes/rpc.js';
import userRoutes from './routes/users.js';
import rewardsRoutes from './routes/rewards.js';
import stakingRoutes from './routes/staking.js';
import { spawn } from 'child_process';
import cron from 'node-cron';

dotenv.config();

const fastify = Fastify({
  logger: {
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  }
});

const start = async () => {
  try {
    await fastify.register(cors, {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    });

    await fastify.register(jwtPlugin, {
      secret: process.env.JWT_SECRET,
    });

    // DEFINITIVE FIX: Add detailed logging to the authentication hook
    // to see exactly why the JWT verification is failing.
    fastify.decorate("authenticate", async function(request, reply) {
      request.log.info({ headers: request.headers }, '🛡️ AUTH_HOOK: Running authentication check...');
      try {
        await request.jwtVerify();
        request.log.info({ user: request.user }, '✅ AUTH_HOOK_SUCCESS: JWT verified successfully.');
      } catch (err) {
        request.log.error({
            msg: '❌ AUTH_HOOK_FAIL: JWT verification failed.',
            error: {
                message: err.message,
                name: err.name,
                stack: err.stack
            },
            headers: request.headers
        }, 'JWT verification error details');
        reply.code(401).send({ error: "Unauthorized", message: `Authentication error: ${err.message}` });
      }
    });

    await connectDb();
    fastify.decorate('db', getDb());
    fastify.log.info('Database connected successfully.');

    fastify.register(userRoutes, { prefix: '/api/users' });
    fastify.register(rewardsRoutes, { prefix: '/api/rewards' });
    fastify.register(stakingRoutes, { prefix: '/api/staking' });
    fastify.register(rpcRoutes, { prefix: '/rpc' });
    fastify.log.info('Application routes registered.');

    fastify.get('/health', { logLevel: 'silent' }, (request, reply) => {
      reply.code(200).send({
        status: 'ok',
        timestamp: new Date().toISOString()
      });
    });

    const port = process.env.PORT || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });

  } catch (err) {
    fastify.log.fatal(err, '!!! SERVER FAILED TO START !!!');
    process.exit(1);
  }
};

start();

// Schedule the transaction updater to run every 10 seconds instead of 5 minutes
cron.schedule('*/10 * * * * *', () => {
  console.log('Running transaction status update job...');
  const worker = spawn('node', ['workers/transactionUpdater.js'], {
    stdio: 'inherit',
    detached: true
  });
  
  worker.on('error', (err) => {
    console.error('Failed to start transaction updater worker:', err);
  });
  
  worker.on('exit', (code, signal) => {
    if (code !== 0) {
      console.log(`Transaction updater worker exited with code ${code} and signal ${signal}`);
    }
  });
});
