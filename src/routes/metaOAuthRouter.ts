import { Router, Request, Response } from 'express';
import { requireLogin, requireLoginOrToken } from '../middleware/auth';
import {
  getMetaAppById,
  findChannel,
  createMetaChannel,
  saveChannelConnection,
  getCallbackStatus,
  getMetaChannelById,
  recordCallbackCheck,
  MetaProduct,
} from '../models/metaModel';
import { createWebhookConfig } from '../models/webhookConfigModel';
import {
  exchangeCodeForToken,
  debugToken,
  getPhoneNumberInfo,
  subscribeWabaToApp,
  overrideWabaCallback,
  exchangeInstagramCode,
  getInstagramAccount,
} from '../services/metaGraph';
import {
  provisionWhatsappInbox,
  chatwootWhatsappWebhookUrl,
  chatwootInstagramWebhookUrl,
  ChatwootTarget,
} from '../services/chatwootProvisioning';
import { expectedCallbackUrl, checkOneChannel } from '../services/callbackWatchdog';
import { getWatchedWhatsappChannels } from '../models/metaModel';

const router = Router();

/**
 * Onboarding de canais da Meta. Cada rota devolve um relatorio passo a passo
 * (`steps`) em vez de so um ok: quando algo falha no meio - e vai falhar, porque
 * depende da Meta e do Connect - o console mostra exatamente onde parou.
 */

interface Step {
  step: string;
  ok: boolean;
  detail?: string;
}

const slugify = (text: string, fallback: string): string => {
  const base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || fallback;
};

const parseChatwootTarget = (raw: any): ChatwootTarget | null => {
  if (!raw || typeof raw !== 'object') return null;
  const accountId = Number(raw.account_id);
  if (!raw.base_url || !raw.api_token || !Number.isInteger(accountId) || accountId <= 0) return null;
  return { base_url: String(raw.base_url), api_token: String(raw.api_token), account_id: accountId };
};

/** Dados que o SDK do Facebook precisa no navegador. O secret nunca vai. */
router.get('/meta/apps/:id/signup-config', requireLogin, async (req: Request, res: Response) => {
  const app = await getMetaAppById(parseInt(req.params.id, 10));
  if (!app) return res.status(404).json({ error: 'Not found' });
  res.json({
    app_id: app.app_id,
    config_id: app.config_id,
    graph_api_version: app.graph_api_version,
    callback_url: expectedCallbackUrl(app.app_id),
    verify_token: app.verify_token,
    instagram_redirect_uri: `${(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/api/meta/apps/${app.id}/instagram/callback`,
    public_base_url_set: Boolean(process.env.PUBLIC_BASE_URL),
  });
});

/**
 * Embedded Signup do WhatsApp: o navegador manda o `code` que o SDK devolveu e
 * o servidor faz o resto. Ordem importa - o override do callback vem antes de
 * criar a inbox no Connect, para a entrada ja estar nossa quando o canal nascer.
 */
router.post('/meta/apps/:id/whatsapp/connect', requireLogin, async (req: Request, res: Response) => {
  const app = await getMetaAppById(parseInt(req.params.id, 10));
  if (!app) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const { code, waba_id: wabaId, phone_number_id: phoneNumberId } = body;
  if (!code || !wabaId || !phoneNumberId) {
    return res.status(400).json({ error: 'code, waba_id e phone_number_id sao obrigatorios' });
  }
  if (!process.env.PUBLIC_BASE_URL) {
    return res.status(500).json({ error: 'PUBLIC_BASE_URL nao configurado no servidor' });
  }

  const steps: Step[] = [];
  const version = app.graph_api_version;

  try {
    const { accessToken, expiresIn } = await exchangeCodeForToken({
      appId: app.app_id,
      appSecret: app.app_secret,
      code: String(code),
      version,
    });
    steps.push({ step: 'troca do code por token', ok: true });

    // Guarda contra code emitido por outro app: sem isto, um code de terceiro
    // gravaria um token que nunca vai receber webhook nosso.
    const info = await debugToken({ token: accessToken, appId: app.app_id, appSecret: app.app_secret, version });
    if (info.appId && info.appId !== app.app_id) {
      steps.push({ step: 'confere o app do token', ok: false, detail: `token pertence ao app ${info.appId}` });
      return res.status(400).json({ error: 'o code nao pertence a este app', steps });
    }
    steps.push({ step: 'confere o app do token', ok: true });

    const phone = await getPhoneNumberInfo({ phoneNumberId: String(phoneNumberId), token: accessToken, version });
    steps.push({
      step: 'consulta o numero',
      ok: true,
      detail: `${phone.displayPhoneNumber ?? '?'} (${phone.verifiedName ?? 'sem nome'})`,
    });

    await subscribeWabaToApp({ wabaId: String(wabaId), token: accessToken, version });
    steps.push({ step: 'inscreve o app no WABA', ok: true });

    const callbackUrl = expectedCallbackUrl(app.app_id);
    await overrideWabaCallback({
      wabaId: String(wabaId),
      token: accessToken,
      callbackUrl,
      verifyToken: app.verify_token,
      version,
    });
    steps.push({ step: 'aponta o callback para o redirector', ok: true, detail: callbackUrl });

    const name = body.name || `WhatsApp ${phone.displayPhoneNumber ?? phoneNumberId}`;
    let channel =
      (await findChannel(app.id, 'whatsapp', String(wabaId), String(phoneNumberId))) ||
      (await createMetaChannel({
        meta_app_id: app.id,
        name,
        product: 'whatsapp',
        external_id: String(wabaId),
        phone_number_id: String(phoneNumberId),
        is_active: true,
      }));
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // Provisiona a inbox ANTES de gravar o inbox_ref, para o ref refletir a realidade.
    let inboxRef: string | null = null;
    const target = parseChatwootTarget(body.chatwoot);
    if (target) {
      try {
        const inbox = await provisionWhatsappInbox(target, {
          name,
          phoneNumber: phone.displayPhoneNumber || String(phoneNumberId),
          phoneNumberId: String(phoneNumberId),
          wabaId: String(wabaId),
          accessToken,
          verifyToken: app.verify_token,
        });
        inboxRef = inbox?.id != null ? String(inbox.id) : null;
        steps.push({ step: 'cria a inbox no Connect', ok: true, detail: `inbox ${inboxRef}` });
      } catch (error: any) {
        steps.push({ step: 'cria a inbox no Connect', ok: false, detail: error?.message });
      }

      if (phone.displayPhoneNumber) {
        try {
          const slug = slugify(`${name}`, `wa-${phoneNumberId}`);
          await createWebhookConfig({
            name: `${name} → Connect`,
            slug,
            source_type: 'meta_cloud_api',
            target_type: 'raw_forward',
            target_config: { url: chatwootWhatsappWebhookUrl(target.base_url, phone.displayPhoneNumber) },
            meta_channel_id: channel.id,
            is_active: true,
          });
          steps.push({ step: 'cria a rota para o Connect', ok: true });
        } catch (error: any) {
          steps.push({ step: 'cria a rota para o Connect', ok: false, detail: error?.message });
        }
      }
    }

    const saved = await saveChannelConnection({
      channelId: channel.id,
      accessToken,
      tokenExpiresAt,
      displayName: phone.displayPhoneNumber,
      inboxRef,
    });
    steps.push({ step: 'guarda o canal', ok: true });

    res.status(201).json({ channel: { ...saved, access_token: undefined }, steps });
  } catch (error: any) {
    console.error('[meta-oauth] whatsapp connect falhou:', error?.message || error);
    steps.push({ step: 'erro', ok: false, detail: error?.message });
    res.status(502).json({ error: error?.message || 'falha no onboarding', steps });
  }
});

/** URL para o cliente autorizar o Instagram. O state amarra a sessao ao app. */
router.get('/meta/apps/:id/instagram/start', requireLogin, async (req: Request, res: Response) => {
  const app = await getMetaAppById(parseInt(req.params.id, 10));
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (!process.env.PUBLIC_BASE_URL) {
    return res.status(500).json({ error: 'PUBLIC_BASE_URL nao configurado no servidor' });
  }

  const redirectUri = `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/meta/apps/${app.id}/instagram/callback`;
  const scope =
    (req.query.scope as string) ||
    process.env.META_IG_SCOPE ||
    'instagram_business_basic,instagram_business_manage_messages';
  const url =
    `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${encodeURIComponent(app.app_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}`;

  res.json({ authorize_url: url, redirect_uri: redirectUri });
});

/**
 * Onde o navegador cai depois de autorizar o Instagram. Diferente do WhatsApp,
 * aqui nao ha override por conta: o callback do APP e que aponta para o
 * redirector, uma vez so, no painel da Meta.
 */
router.get('/meta/apps/:id/instagram/callback', requireLogin, async (req: Request, res: Response) => {
  const app = await getMetaAppById(parseInt(req.params.id, 10));
  if (!app) return res.status(404).send('app desconhecido');

  const code = req.query.code as string;
  if (!code) return res.status(400).send(`Instagram nao devolveu code: ${String(req.query.error_description || '')}`);

  const redirectUri = `${(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/api/meta/apps/${app.id}/instagram/callback`;

  try {
    const { accessToken, expiresIn } = await exchangeInstagramCode({
      appId: app.app_id,
      appSecret: app.app_secret,
      code,
      redirectUri,
    });
    const account = await getInstagramAccount({ token: accessToken, version: app.graph_api_version });
    if (!account.id) throw new Error('nao foi possivel descobrir o id da conta do Instagram');

    const name = account.username ? `Instagram @${account.username}` : `Instagram ${account.id}`;
    const channel =
      (await findChannel(app.id, 'instagram', account.id, null)) ||
      (await createMetaChannel({
        meta_app_id: app.id,
        name,
        product: 'instagram',
        external_id: account.id,
        phone_number_id: null,
        is_active: true,
      }));

    await saveChannelConnection({
      channelId: channel.id,
      accessToken,
      tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      displayName: account.username,
    });

    res.redirect(`/?meta=instagram-conectado&canal=${channel.id}#meta`);
  } catch (error: any) {
    console.error('[meta-oauth] instagram connect falhou:', error?.message || error);
    res.status(502).send(`Falha ao conectar o Instagram: ${error?.message || 'erro desconhecido'}`);
  }
});

/** Cria a rota de um canal para o /webhooks/instagram de um Connect. */
router.post('/meta/channels/:id/route-instagram', requireLogin, async (req: Request, res: Response) => {
  const channel = await getMetaChannelById(parseInt(req.params.id, 10));
  if (!channel) return res.status(404).json({ error: 'Not found' });
  const baseUrl = req.body?.base_url;
  if (!baseUrl) return res.status(400).json({ error: 'base_url e obrigatorio' });

  try {
    const created = await createWebhookConfig({
      name: `${channel.name} → Connect`,
      slug: slugify(channel.name, `ig-${channel.id}`),
      source_type: 'meta_cloud_api',
      target_type: 'raw_forward',
      target_config: { url: chatwootInstagramWebhookUrl(String(baseUrl)) },
      meta_channel_id: channel.id,
      is_active: true,
    });
    res.status(201).json(created);
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'slug already exists' });
    console.error('[meta-oauth] criacao de rota falhou:', error?.message || error);
    res.status(500).json({ error: 'nao foi possivel criar a rota' });
  }
});

/** Estado do callback de cada canal. Token tambem serve, para o vigia-infra. */
router.get('/meta/callback-status', requireLoginOrToken, async (_req: Request, res: Response) => {
  try {
    res.json(await getCallbackStatus());
  } catch (error) {
    console.error('Error fetching callback status:', error);
    res.status(500).json({ error: 'Failed to fetch callback status' });
  }
});

/** Reconferir agora, sem esperar o ciclo do vigia. */
router.post('/meta/channels/:id/check-callback', requireLogin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const channels = await getWatchedWhatsappChannels();
  const channel = channels.find((c) => c.channel_id === id);
  if (!channel) return res.status(404).json({ error: 'canal sem token ou nao vigiado' });
  const result = await checkOneChannel(channel);
  // Grava tambem na conferencia manual, senao o painel segue mostrando o
  // status da ultima rodada do vigia.
  await recordCallbackCheck(id, result.status, result.observed, result.error ?? null);
  res.json(result);
});

export default router;
