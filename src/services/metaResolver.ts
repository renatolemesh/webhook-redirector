import { WebhookConfig } from '../models/webhookConfigModel';
import { MetaProduct, MetaRoute } from '../models/metaModel';

/**
 * Decide para quais endpoints vai cada pedaco de um webhook da Meta.
 *
 * A Meta manda todos os clientes de um App para a mesma URL de callback, entao
 * o dono do evento sai do payload, nao da URL:
 *   - entry[].id e o WABA (WhatsApp), o IG user id (Instagram) ou o Page id (Messenger);
 *   - no WhatsApp, changes[].value.metadata.phone_number_id separa os numeros
 *     de um mesmo WABA, que costumam ir para inboxes diferentes do Chatwoot.
 *
 * Cada endpoint recebe um payload no formato original da Meta contendo so as
 * entradas (e, no WhatsApp, so os changes) que sao dele. Quando nada precisa
 * ser separado, o payload sai estruturalmente igual ao que chegou.
 */

// Map e nao objeto literal: object="constructor" num objeto devolveria Object.
const PRODUCT_BY_OBJECT = new Map<string, MetaProduct>([
  ['whatsapp_business_account', 'whatsapp'],
  ['instagram', 'instagram'],
  ['page', 'messenger'],
]);

export interface RoutedPayload {
  config: WebhookConfig;
  payload: any;
}

export interface ResolveResult {
  routed: RoutedPayload[];
  /** O que chegou sem canal ou sem endpoint ativo, para log. */
  unrouted: string[];
}

const uniqueConfigs = (routes: MetaRoute[]): WebhookConfig[] => {
  const seen = new Map<number, WebhookConfig>();
  for (const r of routes) {
    if (!seen.has(r.config.id)) seen.set(r.config.id, r.config);
  }
  return [...seen.values()];
};

/**
 * O canal do numero tem precedencia; o canal do WABA inteiro (phone_number_id
 * nulo) e o fallback para numeros sem canal proprio. Eventos sem numero
 * (status de template, account_update) vao para todos os canais do WABA.
 */
const pickWhatsappRoutes = (sameAccount: MetaRoute[], phoneNumberId: string | null): MetaRoute[] => {
  if (!phoneNumberId) return sameAccount;
  const exact = sameAccount.filter((r) => r.phoneNumberId === phoneNumberId);
  if (exact.length) return exact;
  return sameAccount.filter((r) => r.phoneNumberId === null);
};

export const resolveMetaPayload = (payload: any, routes: MetaRoute[]): ResolveResult => {
  const product =
    typeof payload?.object === 'string' ? PRODUCT_BY_OBJECT.get(payload.object) : undefined;
  if (!product) {
    return { routed: [], unrouted: [`object=${String(payload?.object)}`] };
  }

  const unrouted: string[] = [];
  const byConfig = new Map<number, { config: WebhookConfig; entries: any[] }>();
  const deliver = (config: WebhookConfig, entry: any) => {
    const slot = byConfig.get(config.id);
    if (slot) slot.entries.push(entry);
    else byConfig.set(config.id, { config, entries: [entry] });
  };

  const entries: any[] = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const externalId = entry?.id == null ? '' : String(entry.id);
    const sameAccount = routes.filter((r) => r.product === product && r.externalId === externalId);

    if (product !== 'whatsapp' || !Array.isArray(entry?.changes)) {
      const configs = uniqueConfigs(sameAccount);
      if (!configs.length) unrouted.push(`${product}:${externalId}`);
      for (const config of configs) deliver(config, entry);
      continue;
    }

    const changesByConfig = new Map<number, { config: WebhookConfig; changes: any[] }>();
    for (const change of entry.changes) {
      const pnid = change?.value?.metadata?.phone_number_id;
      const phoneNumberId = pnid == null ? null : String(pnid);
      const configs = uniqueConfigs(pickWhatsappRoutes(sameAccount, phoneNumberId));
      if (!configs.length) {
        unrouted.push(`whatsapp:${externalId}/${phoneNumberId ?? '-'}`);
        continue;
      }
      for (const config of configs) {
        const slot = changesByConfig.get(config.id);
        if (slot) slot.changes.push(change);
        else changesByConfig.set(config.id, { config, changes: [change] });
      }
    }
    for (const { config, changes } of changesByConfig.values()) {
      deliver(config, { ...entry, changes });
    }
  }

  return {
    routed: [...byConfig.values()].map(({ config, entries: own }) => ({
      config,
      payload: { ...payload, entry: own },
    })),
    unrouted,
  };
};
