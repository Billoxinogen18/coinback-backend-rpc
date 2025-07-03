import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
dotenv.config();
let pool;
export const connectDb = async () => {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:5432/${process.env.DB_NAME}`;
  pool = new Pool({
    connectionString: connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('PostgreSQL connected successfully.');
    return pool;
  } catch (err) {
    console.error('PostgreSQL connection error:', err.stack);
    throw err;
  }
};
export const getDb = () => {
  if (!pool) throw new Error('Database not connected.');
  return pool;
};
