import pool from '../config/database';
import { WebhookConfig } from './webhookConfigModel';

export type MetaProduct = 'whatsapp' | 'instagram' | 'messenger';
export const META_PRODUCTS: MetaProduct[] = ['whatsapp', 'instagram', 'messenger'];

export interface MetaApp {
  id: number;
  name: string;
  app_id: string;
  app_secret: string;
  verify_token: string;
  /** config_id do Embedded Signup (Facebook Login for Business). */
  config_id: string | null;
  graph_api_version: string;
  is_active: boolean;
  created_at: Date;
}

export interface MetaAppInput {
  name: string;
  app_id: string;
  app_secret: string;
  verify_token: string;
  config_id: string | null;
  graph_api_version: string;
  is_active: boolean;
}

export interface MetaChannel {
  id: number;
  meta_app_id: number;
  name: string;
  product: MetaProduct;
  external_id: string;
  phone_number_id: string | null;
  access_token: string | null;
  token_expires_at: Date | null;
  display_name: string | null;
  callback_status: string | null;
  callback_observed: string | null;
  callback_checked_at: Date | null;
  callback_error: string | null;
  inbox_ref: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface MetaChannelInput {
  meta_app_id: number;
  name: string;
  product: MetaProduct;
  external_id: string;
  phone_number_id: string | null;
  is_active: boolean;
}

/** Endpoint ativo pendurado num canal ativo: o que o resolver precisa para despachar. */
export interface MetaRoute {
  product: MetaProduct;
  externalId: string;
  phoneNumberId: string | null;
  config: WebhookConfig;
}

// ---------- meta_apps ----------

export const getAllMetaApps = async (): Promise<MetaApp[]> => {
  const res = await pool.query('SELECT * FROM meta_apps ORDER BY id ASC');
  return res.rows;
};

export const getMetaAppById = async (id: number): Promise<MetaApp | null> => {
  const res = await pool.query('SELECT * FROM meta_apps WHERE id = $1', [id]);
  return res.rows[0] || null;
};

export const getMetaAppByAppId = async (appId: string): Promise<MetaApp | null> => {
  const res = await pool.query('SELECT * FROM meta_apps WHERE app_id = $1', [appId]);
  return res.rows[0] || null;
};

export const createMetaApp = async (input: MetaAppInput): Promise<MetaApp> => {
  const res = await pool.query(
    `INSERT INTO meta_apps (name, app_id, app_secret, verify_token, config_id, graph_api_version, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.name,
      input.app_id,
      input.app_secret,
      input.verify_token,
      input.config_id,
      input.graph_api_version,
      input.is_active,
    ]
  );
  return res.rows[0];
};

export const updateMetaApp = async (id: number, input: MetaAppInput): Promise<MetaApp | null> => {
  const res = await pool.query(
    `UPDATE meta_apps
       SET name = $1, app_id = $2, app_secret = $3, verify_token = $4,
           config_id = $5, graph_api_version = $6, is_active = $7
     WHERE id = $8
     RETURNING *`,
    [
      input.name,
      input.app_id,
      input.app_secret,
      input.verify_token,
      input.config_id,
      input.graph_api_version,
      input.is_active,
      id,
    ]
  );
  return res.rows[0] || null;
};

export const deleteMetaApp = async (id: number): Promise<boolean> => {
  const res = await pool.query('DELETE FROM meta_apps WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
};

// ---------- meta_channels ----------

/** Canais com os endpoints pendurados em cada um, para o painel. */
export const getMetaChannels = async (metaAppId?: number) => {
  const res = await pool.query(
    `SELECT c.*,
            COALESCE(
              json_agg(
                json_build_object('id', w.id, 'slug', w.slug, 'name', w.name, 'is_active', w.is_active)
                ORDER BY w.id
              ) FILTER (WHERE w.id IS NOT NULL),
              '[]'
            ) AS routes
       FROM meta_channels c
       LEFT JOIN webhook_configs w ON w.meta_channel_id = c.id
      WHERE ($1::int IS NULL OR c.meta_app_id = $1)
      GROUP BY c.id
      ORDER BY c.id ASC`,
    [metaAppId ?? null]
  );
  return res.rows;
};

export const getMetaChannelById = async (id: number): Promise<MetaChannel | null> => {
  const res = await pool.query('SELECT * FROM meta_channels WHERE id = $1', [id]);
  return res.rows[0] || null;
};

export const createMetaChannel = async (input: MetaChannelInput): Promise<MetaChannel> => {
  const res = await pool.query(
    `INSERT INTO meta_channels (meta_app_id, name, product, external_id, phone_number_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.meta_app_id, input.name, input.product, input.external_id, input.phone_number_id, input.is_active]
  );
  return res.rows[0];
};

export const updateMetaChannel = async (
  id: number,
  input: MetaChannelInput
): Promise<MetaChannel | null> => {
  const res = await pool.query(
    `UPDATE meta_channels
       SET meta_app_id = $1, name = $2, product = $3, external_id = $4,
           phone_number_id = $5, is_active = $6
     WHERE id = $7
     RETURNING *`,
    [input.meta_app_id, input.name, input.product, input.external_id, input.phone_number_id, input.is_active, id]
  );
  return res.rows[0] || null;
};

export const deleteMetaChannel = async (id: number): Promise<boolean> => {
  const res = await pool.query('DELETE FROM meta_channels WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
};

/**
 * Todas as rotas ativas de um app numa consulta so. O volume de canais por app
 * e pequeno, e buscar tudo a cada POST evita cache para invalidar quando um
 * endpoint e editado no painel.
 */
export const getActiveRoutesForApp = async (metaAppId: number): Promise<MetaRoute[]> => {
  const res = await pool.query(
    `SELECT w.*,
            c.product         AS channel_product,
            c.external_id     AS channel_external_id,
            c.phone_number_id AS channel_phone_number_id
       FROM meta_channels c
       JOIN webhook_configs w ON w.meta_channel_id = c.id
      WHERE c.meta_app_id = $1
        AND c.is_active
        AND w.is_active
      ORDER BY w.id ASC`,
    [metaAppId]
  );
  return res.rows.map((row) => {
    const { channel_product, channel_external_id, channel_phone_number_id, ...config } = row;
    return {
      product: channel_product,
      externalId: channel_external_id,
      phoneNumberId: channel_phone_number_id,
      config: config as WebhookConfig,
    };
  });
};

// ---------- onboarding e vigia ----------

/** Canal com os dados do app resolvidos: o vigia precisa dos dois juntos. */
export interface MetaWatchedChannel {
  channel_id: number;
  name: string;
  product: MetaProduct;
  external_id: string;
  access_token: string | null;
  token_expires_at: Date | null;
  app_id: string;
  verify_token: string;
  graph_api_version: string;
}

const WATCHED_SELECT = `
  SELECT c.id AS channel_id, c.name, c.product, c.external_id, c.access_token,
         c.token_expires_at, a.app_id, a.verify_token, a.graph_api_version
    FROM meta_channels c
    JOIN meta_apps a ON a.id = c.meta_app_id
`;

export const getWatchedWhatsappChannels = async (): Promise<MetaWatchedChannel[]> => {
  const res = await pool.query(
    `${WATCHED_SELECT}
      WHERE c.is_active AND a.is_active
        AND c.product = 'whatsapp'
        AND c.access_token IS NOT NULL
      ORDER BY c.id ASC`
  );
  return res.rows;
};

export const getInstagramChannelsNeedingRefresh = async (
  windowDays: number
): Promise<MetaWatchedChannel[]> => {
  const res = await pool.query(
    `${WATCHED_SELECT}
      WHERE c.is_active AND a.is_active
        AND c.product = 'instagram'
        AND c.access_token IS NOT NULL
        AND c.token_expires_at IS NOT NULL
        AND c.token_expires_at < now() + ($1 || ' days')::interval
      ORDER BY c.token_expires_at ASC`,
    [windowDays]
  );
  return res.rows;
};

export const recordCallbackCheck = async (
  channelId: number,
  status: string,
  observed: string | null,
  error: string | null
): Promise<void> => {
  await pool.query(
    `UPDATE meta_channels
        SET callback_status = $1, callback_observed = $2, callback_error = $3,
            callback_checked_at = now()
      WHERE id = $4`,
    [status, observed, error, channelId]
  );
};

export const updateChannelToken = async (
  channelId: number,
  accessToken: string,
  expiresAt: Date | null
): Promise<void> => {
  await pool.query(
    'UPDATE meta_channels SET access_token = $1, token_expires_at = $2 WHERE id = $3',
    [accessToken, expiresAt, channelId]
  );
};

/** Estado do callback de cada canal, para o painel e para o vigia-infra. */
export const getCallbackStatus = async () => {
  const res = await pool.query(
    `SELECT c.id, c.name, c.product, c.external_id, c.phone_number_id, c.is_active,
            c.callback_status, c.callback_observed, c.callback_checked_at, c.callback_error,
            c.token_expires_at, c.inbox_ref, a.app_id
       FROM meta_channels c
       JOIN meta_apps a ON a.id = c.meta_app_id
      ORDER BY c.id ASC`
  );
  return res.rows;
};

/** Usado pelo onboarding: acha canal existente para reconectar em vez de duplicar. */
export const findChannel = async (
  metaAppId: number,
  product: MetaProduct,
  externalId: string,
  phoneNumberId: string | null
): Promise<MetaChannel | null> => {
  const res = await pool.query(
    `SELECT * FROM meta_channels
      WHERE meta_app_id = $1 AND product = $2 AND external_id = $3
        AND COALESCE(phone_number_id, '') = COALESCE($4, '')`,
    [metaAppId, product, externalId, phoneNumberId]
  );
  return res.rows[0] || null;
};

export const saveChannelConnection = async (opts: {
  channelId: number;
  accessToken: string;
  tokenExpiresAt: Date | null;
  displayName: string | null;
  inboxRef?: string | null;
}): Promise<MetaChannel | null> => {
  const res = await pool.query(
    `UPDATE meta_channels
        SET access_token = $1, token_expires_at = $2, display_name = $3,
            inbox_ref = COALESCE($4, inbox_ref), is_active = TRUE
      WHERE id = $5
      RETURNING *`,
    [opts.accessToken, opts.tokenExpiresAt, opts.displayName, opts.inboxRef ?? null, opts.channelId]
  );
  return res.rows[0] || null;
};
