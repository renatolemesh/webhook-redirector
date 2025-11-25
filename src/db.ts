import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432', 10),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export const initDb = async () => {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS configured_webhooks (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        verification_token VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS received_webhooks (
        id SERIAL PRIMARY KEY,
        received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        payload JSONB NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS webhook_jobs (
        id SERIAL PRIMARY KEY,
        webhook_id INTEGER REFERENCES configured_webhooks(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMP WITH TIME ZONE,
        error_message TEXT
      );

      -- In case column was missing on existing DB
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'configured_webhooks'
            AND column_name = 'verification_token'
        ) THEN
          ALTER TABLE configured_webhooks ADD COLUMN verification_token VARCHAR(255);
        END IF;
      END $$;
    `);
    client.release();
    console.log('Database tables initialized successfully.');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

export default pool;