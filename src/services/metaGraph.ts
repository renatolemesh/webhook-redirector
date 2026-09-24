import axios from 'axios';

/**
 * Cliente fino da Graph API da Meta. Tudo o que fala com a Meta passa por aqui,
 * para o resto do codigo nao montar URL na mao e para os testes poderem apontar
 * META_GRAPH_BASE para um servidor local.
 */

const GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com';
const IG_GRAPH_BASE = process.env.META_IG_GRAPH_BASE || 'https://graph.instagram.com';
const IG_OAUTH_BASE = process.env.META_IG_OAUTH_BASE || 'https://api.instagram.com';
const TIMEOUT_MS = 15000;

export const DEFAULT_GRAPH_VERSION = 'v22.0';

/** Campos que o Chatwoot assina; mantemos os mesmos para nao perder evento. */
export const WHATSAPP_FIELDS = ['messages', 'smb_message_echoes'];

const describeError = (error: any, what: string): Error => {
  const metaMessage =
    error?.response?.data?.error?.message ||
    error?.response?.data?.error_description ||
    error?.response?.data?.error ||
    error?.message;
  const status = error?.response?.status;
  return new Error(`${what} falhou${status ? ` (HTTP ${status})` : ''}: ${JSON.stringify(metaMessage)}`);
};

const get = async (url: string, params: Record<string, unknown>, what: string) => {
  try {
    const res = await axios.get(url, { params, timeout: TIMEOUT_MS });
    return res.data;
  } catch (error) {
    throw describeError(error, what);
  }
};

const post = async (
  url: string,
  body: Record<string, unknown> | undefined,
  token: string,
  what: string
) => {
  try {
    const res = await axios.post(url, body ?? {}, {
      timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (error) {
    throw describeError(error, what);
  }
};

// ---------------------------------------------------------------- WhatsApp

/** Embedded Signup: troca o code que o SDK devolveu por um token do cliente. */
export const exchangeCodeForToken = async (opts: {
  appId: string;
  appSecret: string;
  code: string;
  version?: string;
  redirectUri?: string;
}): Promise<{ accessToken: string; expiresIn: number | null }> => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  const data = await get(
    `${GRAPH_BASE}/${version}/oauth/access_token`,
    {
      client_id: opts.appId,
      client_secret: opts.appSecret,
      code: opts.code,
      ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
    },
    'troca do code por token'
  );
  if (!data?.access_token) throw new Error('troca do code nao devolveu access_token');
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? null };
};

/** Confere a que app o token pertence - guarda contra code de outro app. */
export const debugToken = async (opts: {
  token: string;
  appId: string;
  appSecret: string;
  version?: string;
}): Promise<{ appId: string | null; isValid: boolean; expiresAt: number | null; scopes: string[] }> => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  const data = await get(
    `${GRAPH_BASE}/${version}/debug_token`,
    { input_token: opts.token, access_token: `${opts.appId}|${opts.appSecret}` },
    'debug_token'
  );
  const d = data?.data || {};
  return {
    appId: d.app_id ? String(d.app_id) : null,
    isValid: Boolean(d.is_valid),
    expiresAt: d.expires_at ?? null,
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
  };
};

export const getPhoneNumberInfo = async (opts: {
  phoneNumberId: string;
  token: string;
  version?: string;
}): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null }> => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  const data = await get(
    `${GRAPH_BASE}/${version}/${opts.phoneNumberId}`,
    { fields: 'display_phone_number,verified_name,code_verification_status', access_token: opts.token },
    'consulta do numero'
  );
  return {
    displayPhoneNumber: data?.display_phone_number ?? null,
    verifiedName: data?.verified_name ?? null,
  };
};

/**
 * Inscreve o app no WABA e aponta o callback DESTE WABA para o redirector.
 * A Meta exige o subscribe antes de aceitar override_callback_uri; e o mesmo
 * par de chamadas que o Chatwoot faz, por isso quem chamar por ultimo ganha.
 */
export const subscribeWabaToApp = async (opts: {
  wabaId: string;
  token: string;
  version?: string;
}) => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  return post(`${GRAPH_BASE}/${version}/${opts.wabaId}/subscribed_apps`, undefined, opts.token, 'subscribe do WABA');
};

export const overrideWabaCallback = async (opts: {
  wabaId: string;
  token: string;
  callbackUrl: string;
  verifyToken: string;
  version?: string;
  fields?: string[];
}) => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  return post(
    `${GRAPH_BASE}/${version}/${opts.wabaId}/subscribed_apps`,
    {
      override_callback_uri: opts.callbackUrl,
      verify_token: opts.verifyToken,
      subscribed_fields: opts.fields || WHATSAPP_FIELDS,
    },
    opts.token,
    'override do callback'
  );
};

/** Le a inscricao atual: e com isto que o vigia descobre que perdeu o callback. */
export const getWabaSubscriptions = async (opts: {
  wabaId: string;
  token: string;
  version?: string;
}): Promise<{ overrideCallbackUri: string | null; appId: string | null; raw: any }> => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  const data = await get(
    `${GRAPH_BASE}/${version}/${opts.wabaId}/subscribed_apps`,
    { access_token: opts.token },
    'leitura da inscricao do WABA'
  );
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  const appData = first?.whatsapp_business_api_data || {};
  return {
    overrideCallbackUri: first?.override_callback_uri ?? appData?.override_callback_uri ?? null,
    appId: appData?.id ? String(appData.id) : null,
    raw: data,
  };
};

// --------------------------------------------------------------- Instagram

/**
 * Instagram Login tem fluxo proprio: o code sai em api.instagram.com e o token
 * curto precisa ser trocado por um de 60 dias em graph.instagram.com.
 */
export const exchangeInstagramCode = async (opts: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; expiresIn: number | null; userId: string | null }> => {
  let shortLived: any;
  try {
    const res = await axios.post(
      `${IG_OAUTH_BASE}/oauth/access_token`,
      new URLSearchParams({
        client_id: opts.appId,
        client_secret: opts.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: opts.redirectUri,
        code: opts.code,
      }).toString(),
      { timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    shortLived = res.data;
  } catch (error) {
    throw describeError(error, 'troca do code do Instagram');
  }
  if (!shortLived?.access_token) throw new Error('troca do code do Instagram nao devolveu access_token');

  const longLived = await get(
    `${IG_GRAPH_BASE}/access_token`,
    {
      grant_type: 'ig_exchange_token',
      client_secret: opts.appSecret,
      access_token: shortLived.access_token,
    },
    'troca por token de longa duracao'
  );

  return {
    accessToken: longLived?.access_token || shortLived.access_token,
    expiresIn: longLived?.expires_in ?? null,
    userId: shortLived?.user_id ? String(shortLived.user_id) : null,
  };
};

export const refreshInstagramToken = async (opts: {
  token: string;
}): Promise<{ accessToken: string; expiresIn: number | null }> => {
  const data = await get(
    `${IG_GRAPH_BASE}/refresh_access_token`,
    { grant_type: 'ig_refresh_token', access_token: opts.token },
    'renovacao do token do Instagram'
  );
  if (!data?.access_token) throw new Error('renovacao nao devolveu access_token');
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? null };
};

export const getInstagramAccount = async (opts: {
  token: string;
  version?: string;
}): Promise<{ id: string | null; username: string | null }> => {
  const version = opts.version || DEFAULT_GRAPH_VERSION;
  const data = await get(
    `${IG_GRAPH_BASE}/${version}/me`,
    { fields: 'id,username,user_id,account_type', access_token: opts.token },
    'consulta da conta do Instagram'
  );
  // O webhook do Instagram chega com entry[].id = user_id (o id numerico do IG).
  return { id: data?.user_id ? String(data.user_id) : data?.id ? String(data.id) : null, username: data?.username ?? null };
};
