import {
  getWatchedWhatsappChannels,
  getInstagramChannelsNeedingRefresh,
  recordCallbackCheck,
  updateChannelToken,
  MetaWatchedChannel,
} from '../models/metaModel';
import {
  getWabaSubscriptions,
  subscribeWabaToApp,
  overrideWabaCallback,
  refreshInstagramToken,
} from './metaGraph';

/**
 * O risco silencioso desta arquitetura: o cliente clica em "reautorizar" no
 * Connect, o Chatwoot reaplica o override do WABA para a URL dele, e as
 * mensagens param de chegar ao n8n e aos sistemas do cliente - sem erro
 * nenhum, porque o Connect continua funcionando.
 *
 * Este vigia le a inscricao na Meta, compara com o que deveria estar lá,
 * reaplica (se autofix ligado) e registra. Tambem renova o token do Instagram,
 * que vence em 60 dias.
 */

const CHECK_INTERVAL_MS = Number(process.env.META_CALLBACK_CHECK_INTERVAL_MS) || 15 * 60 * 1000;
const AUTOFIX = process.env.META_CALLBACK_AUTOFIX !== '0';
const REFRESH_WINDOW_DAYS = Number(process.env.META_IG_REFRESH_WINDOW_DAYS) || 10;

export const expectedCallbackUrl = (appId: string): string => {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/webhook/app/${appId}`;
};

export const checkOneChannel = async (
  channel: MetaWatchedChannel
): Promise<{ status: string; observed: string | null; fixed: boolean; error?: string }> => {
  const expected = expectedCallbackUrl(channel.app_id);
  if (!process.env.PUBLIC_BASE_URL) {
    return { status: 'sem_public_base_url', observed: null, fixed: false };
  }
  if (!channel.access_token) {
    return { status: 'sem_token', observed: null, fixed: false };
  }

  try {
    const subs = await getWabaSubscriptions({
      wabaId: channel.external_id,
      token: channel.access_token,
      version: channel.graph_api_version,
    });

    if (subs.overrideCallbackUri === expected) {
      return { status: 'ok', observed: subs.overrideCallbackUri, fixed: false };
    }

    console.warn(
      `[callback-watchdog] canal ${channel.channel_id} (${channel.name}): callback esperado ${expected}, encontrado ${subs.overrideCallbackUri ?? 'nenhum'}`
    );

    if (!AUTOFIX) {
      return { status: 'divergente', observed: subs.overrideCallbackUri, fixed: false };
    }

    await subscribeWabaToApp({
      wabaId: channel.external_id,
      token: channel.access_token,
      version: channel.graph_api_version,
    });
    await overrideWabaCallback({
      wabaId: channel.external_id,
      token: channel.access_token,
      callbackUrl: expected,
      verifyToken: channel.verify_token,
      version: channel.graph_api_version,
    });
    console.warn(`[callback-watchdog] canal ${channel.channel_id}: callback reaplicado para ${expected}`);
    return { status: 'reaplicado', observed: subs.overrideCallbackUri, fixed: true };
  } catch (error: any) {
    console.error(`[callback-watchdog] canal ${channel.channel_id} falhou:`, error?.message || error);
    return { status: 'erro', observed: null, fixed: false, error: error?.message || String(error) };
  }
};

const runOnce = async () => {
  const channels = await getWatchedWhatsappChannels();
  for (const channel of channels) {
    const result = await checkOneChannel(channel);
    await recordCallbackCheck(channel.channel_id, result.status, result.observed, result.error ?? null);
  }

  const stale = await getInstagramChannelsNeedingRefresh(REFRESH_WINDOW_DAYS);
  for (const channel of stale) {
    if (!channel.access_token) continue;
    try {
      const refreshed = await refreshInstagramToken({ token: channel.access_token });
      const expiresAt = refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000) : null;
      await updateChannelToken(channel.channel_id, refreshed.accessToken, expiresAt);
      console.log(`[callback-watchdog] token do Instagram renovado para o canal ${channel.channel_id}`);
    } catch (error: any) {
      console.error(
        `[callback-watchdog] renovacao do token do canal ${channel.channel_id} falhou:`,
        error?.message || error
      );
    }
  }
};

const loop = async () => {
  try {
    await runOnce();
  } catch (error: any) {
    console.error('[callback-watchdog] ciclo falhou:', error?.message || error);
  } finally {
    setTimeout(loop, CHECK_INTERVAL_MS);
  }
};

export const startCallbackWatchdog = async () => {
  if (process.env.META_CALLBACK_WATCHDOG === '0') {
    console.log('Callback watchdog desligado por META_CALLBACK_WATCHDOG=0');
    return;
  }
  console.log(
    `Starting Meta callback watchdog (intervalo ${Math.round(CHECK_INTERVAL_MS / 60000)} min, autofix ${AUTOFIX ? 'on' : 'off'})...`
  );
  // Primeira rodada com atraso: no boot o banco pode ainda estar subindo.
  setTimeout(loop, 30000);
};
