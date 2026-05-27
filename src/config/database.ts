import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  // Bound every wait so a half-dead TCP connection can't pin a worker forever.
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
  statement_timeout: 15000,
  query_timeout: 15000,
  // Larger than default (10) to absorb parallel job processing without queueing.
  max: 20,
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

      CREATE TABLE IF NOT EXISTS chatwoot_messages (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL,
        contact_name VARCHAR(255),
        content TEXT NOT NULL,
        message_type VARCHAR(20) NOT NULL DEFAULT 'outgoing',
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMP WITH TIME ZONE,
        error_message TEXT,
        content_type VARCHAR(100),
        template_params TEXT,
        processed_params TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_chatwoot_messages_status
        ON chatwoot_messages(status, next_attempt_at);

      -- Unified webhook endpoints. Replaces configured_webhooks going forward.
      -- The legacy configured_webhooks table is kept for rollback safety.
      CREATE TABLE IF NOT EXISTS webhook_configs (
        id             SERIAL PRIMARY KEY,
        name           VARCHAR(255) NOT NULL,
        slug           VARCHAR(64)  NOT NULL UNIQUE,
        source_type    VARCHAR(32)  NOT NULL,
        source_config  JSONB        NOT NULL DEFAULT '{}'::jsonb,
        inbound_token  VARCHAR(255),
        target_type    VARCHAR(32)  NOT NULL,
        target_config  JSONB        NOT NULL DEFAULT '{}'::jsonb,
        is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_configs_active
        ON webhook_configs(is_active);

      -- Add missing columns to configured_webhooks if they don't exist
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

      -- Add new columns to chatwoot_messages if they don't exist
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'content_type'
        ) THEN
          ALTER TABLE chatwoot_messages ADD COLUMN content_type VARCHAR(100);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'template_params'
        ) THEN
          ALTER TABLE chatwoot_messages ADD COLUMN template_params TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'processed_params'
        ) THEN
          ALTER TABLE chatwoot_messages ADD COLUMN processed_params TEXT;
        END IF;

        -- New columns for the unified dispatch flow (rows produced by /webhook/:slug)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'webhook_config_id'
        ) THEN
          ALTER TABLE chatwoot_messages
            ADD COLUMN webhook_config_id INTEGER REFERENCES webhook_configs(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'source_id'
        ) THEN
          ALTER TABLE chatwoot_messages ADD COLUMN source_id TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'target_config'
        ) THEN
          ALTER TABLE chatwoot_messages ADD COLUMN target_config JSONB;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chatwoot_messages'
            AND column_name = 'content_attributes'
        ) THEN
          ALTER TABLE chatwoot_messages ADD COLUMN content_attributes JSONB;
        END IF;

        -- Optional link from legacy webhook_jobs rows to a webhook_configs row
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'webhook_jobs'
            AND column_name = 'webhook_config_id'
        ) THEN
          ALTER TABLE webhook_jobs
            ADD COLUMN webhook_config_id INTEGER REFERENCES webhook_configs(id) ON DELETE SET NULL;
        END IF;

        -- Tag each received payload with the slug it arrived on (NULL for the
        -- legacy default /webhook). Lets /api/received?slug=... filter by endpoint.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'received_webhooks'
            AND column_name = 'slug'
        ) THEN
          ALTER TABLE received_webhooks ADD COLUMN slug TEXT;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_received_webhooks_slug
        ON received_webhooks(slug);

      -- One-shot seed: if webhook_configs is empty and configured_webhooks has rows,
      -- copy every row over as meta_cloud_api + raw_forward. Both tables coexist;
      -- rollback = revert code, configured_webhooks is still authoritative for the legacy flow.
      INSERT INTO webhook_configs (name, slug, source_type, source_config, inbound_token, target_type, target_config, is_active, created_at)
      SELECT
        cw.name,
        'legacy-' || cw.id AS slug,
        'meta_cloud_api' AS source_type,
        '{}'::jsonb AS source_config,
        cw.verification_token AS inbound_token,
        'raw_forward' AS target_type,
        jsonb_build_object('url', cw.url) AS target_config,
        cw.is_active,
        cw.created_at
      FROM configured_webhooks cw
      WHERE NOT EXISTS (SELECT 1 FROM webhook_configs)
        AND EXISTS (SELECT 1 FROM configured_webhooks);
    `);
    client.release();
    console.log('Database tables initialized successfully.');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

export default pool;