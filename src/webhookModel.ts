import pool from './db';

export interface ConfiguredWebhook {
  id: number;
  name: string;
  url: string;
  is_active: boolean;
  verification_token?: string;
  created_at: Date;
}

export interface ReceivedWebhook {
  id: number;
  received_at: Date;
  payload: any;
}

export const getAllConfiguredWebhooks = async (): Promise<ConfiguredWebhook[]> => {
  const res = await pool.query('SELECT * FROM configured_webhooks ORDER BY id ASC');
  return res.rows;
};

export const getActiveConfiguredWebhooks = async (): Promise<ConfiguredWebhook[]> => {
  const res = await pool.query('SELECT * FROM configured_webhooks WHERE is_active = TRUE ORDER BY id ASC');
  return res.rows;
};

export const createConfiguredWebhook = async (
  name: string,
  url: string,
  verification_token?: string
): Promise<ConfiguredWebhook> => {
  const res = await pool.query(
    'INSERT INTO configured_webhooks (name, url, verification_token) VALUES ($1, $2, $3) RETURNING *',
    [name, url, verification_token || null]
  );
  return res.rows[0];
};

export const updateConfiguredWebhook = async (
  id: number,
  name: string,
  url: string,
  is_active: boolean,
  verification_token?: string
): Promise<ConfiguredWebhook | null> => {
  const res = await pool.query(
    'UPDATE configured_webhooks SET name = $1, url = $2, is_active = $3, verification_token = $4 WHERE id = $5 RETURNING *',
    [name, url, is_active, verification_token || null, id]
  );
  return res.rows[0] || null;
};

export const deleteConfiguredWebhook = async (id: number): Promise<boolean> => {
  const res = await pool.query('DELETE FROM configured_webhooks WHERE id = $1', [id]);
  return ((res.rowCount ?? 0) > 0);
};

export const saveReceivedWebhook = async (payload: any): Promise<ReceivedWebhook> => {
  const res = await pool.query(
    'INSERT INTO received_webhooks (payload) VALUES ($1) RETURNING *',
    [payload]
  );
  return res.rows[0];
};

export const getRecentReceivedWebhooks = async (limit: number = 10): Promise<ReceivedWebhook[]> => {
  const res = await pool.query(
    'SELECT * FROM received_webhooks ORDER BY received_at DESC LIMIT $1',
    [limit]
  );
  return res.rows;
};