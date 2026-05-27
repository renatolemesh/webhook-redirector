import pool from '../config/database';

export type SourceType = 'meta_cloud_api' | 'uazapi';
export type TargetType = 'raw_forward' | 'chatwoot_api';

export interface RawForwardTargetConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface ChatwootApiTargetConfig {
  base_url: string;
  api_token: string;
  account_id: number;
  inbox_id?: number;
}

export type TargetConfig = RawForwardTargetConfig | ChatwootApiTargetConfig | Record<string, unknown>;

export interface WebhookConfig {
  id: number;
  name: string;
  slug: string;
  source_type: SourceType;
  source_config: Record<string, unknown>;
  inbound_token: string | null;
  target_type: TargetType;
  target_config: TargetConfig;
  is_active: boolean;
  created_at: Date;
}

export const getAllWebhookConfigs = async (): Promise<WebhookConfig[]> => {
  const res = await pool.query('SELECT * FROM webhook_configs ORDER BY id ASC');
  return res.rows;
};

export const getActiveWebhookConfigs = async (): Promise<WebhookConfig[]> => {
  const res = await pool.query(
    'SELECT * FROM webhook_configs WHERE is_active = TRUE ORDER BY id ASC'
  );
  return res.rows;
};

export const getWebhookConfigBySlug = async (
  slug: string
): Promise<WebhookConfig | null> => {
  const res = await pool.query('SELECT * FROM webhook_configs WHERE slug = $1', [slug]);
  return res.rows[0] || null;
};

export const getWebhookConfigById = async (
  id: number
): Promise<WebhookConfig | null> => {
  const res = await pool.query('SELECT * FROM webhook_configs WHERE id = $1', [id]);
  return res.rows[0] || null;
};

export interface WebhookConfigInput {
  name: string;
  slug: string;
  source_type: SourceType;
  source_config?: Record<string, unknown>;
  inbound_token?: string | null;
  target_type: TargetType;
  target_config: TargetConfig;
  is_active?: boolean;
}

export const createWebhookConfig = async (
  input: WebhookConfigInput
): Promise<WebhookConfig> => {
  const res = await pool.query(
    `INSERT INTO webhook_configs
       (name, slug, source_type, source_config, inbound_token, target_type, target_config, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, TRUE))
     RETURNING *`,
    [
      input.name,
      input.slug,
      input.source_type,
      input.source_config || {},
      input.inbound_token || null,
      input.target_type,
      input.target_config,
      input.is_active,
    ]
  );
  return res.rows[0];
};

export const updateWebhookConfig = async (
  id: number,
  input: Partial<WebhookConfigInput>
): Promise<WebhookConfig | null> => {
  const existing = await getWebhookConfigById(id);
  if (!existing) return null;

  const merged = {
    name: input.name ?? existing.name,
    slug: input.slug ?? existing.slug,
    source_type: input.source_type ?? existing.source_type,
    source_config: input.source_config ?? existing.source_config,
    inbound_token:
      input.inbound_token === undefined ? existing.inbound_token : input.inbound_token,
    target_type: input.target_type ?? existing.target_type,
    target_config: input.target_config ?? existing.target_config,
    is_active: input.is_active ?? existing.is_active,
  };

  const res = await pool.query(
    `UPDATE webhook_configs
       SET name = $1, slug = $2, source_type = $3, source_config = $4,
           inbound_token = $5, target_type = $6, target_config = $7, is_active = $8
     WHERE id = $9
     RETURNING *`,
    [
      merged.name,
      merged.slug,
      merged.source_type,
      merged.source_config,
      merged.inbound_token,
      merged.target_type,
      merged.target_config,
      merged.is_active,
      id,
    ]
  );
  return res.rows[0] || null;
};

export const deleteWebhookConfig = async (id: number): Promise<boolean> => {
  const res = await pool.query('DELETE FROM webhook_configs WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
};
