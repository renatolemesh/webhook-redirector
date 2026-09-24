import axios from 'axios';

/**
 * Cria a inbox do canal no Connect pela API - o passo que hoje e manual e que
 * foi o que tirou a Xpertion do redirector em agosto.
 *
 * O detalhe que faz a arquitetura funcionar: o Chatwoot tem
 *   should_auto_setup_webhooks? = provider == 'whatsapp_cloud' && provider_config['source'] != 'embedded_signup'
 * Mandando source='embedded_signup' o canal nasce SEM o Chatwoot reapontar o
 * callback do WABA para ele mesmo, e a entrada continua no redirector.
 */

const TIMEOUT_MS = 20000;

export interface ChatwootTarget {
  base_url: string;
  api_token: string;
  account_id: number;
}

export interface ProvisionedInbox {
  id: number;
  name: string;
  channelType: string | null;
}

const describeError = (error: any, what: string): Error => {
  const body = error?.response?.data;
  const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)?.slice(0, 300);
  return new Error(`${what} falhou${error?.response?.status ? ` (HTTP ${error.response.status})` : ''}: ${detail || error?.message}`);
};

export const provisionWhatsappInbox = async (
  target: ChatwootTarget,
  channel: {
    name: string;
    phoneNumber: string;
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
    verifyToken: string;
  }
): Promise<ProvisionedInbox> => {
  const base = target.base_url.replace(/\/+$/, '');
  const phone = channel.phoneNumber.startsWith('+') ? channel.phoneNumber : `+${channel.phoneNumber.replace(/\D/g, '')}`;

  try {
    const res = await axios.post(
      `${base}/api/v1/accounts/${target.account_id}/inboxes`,
      {
        name: channel.name,
        channel: {
          type: 'whatsapp',
          phone_number: phone,
          provider: 'whatsapp_cloud',
          provider_config: {
            api_key: channel.accessToken,
            phone_number_id: channel.phoneNumberId,
            business_account_id: channel.wabaId,
            webhook_verify_token: channel.verifyToken,
            source: 'embedded_signup',
          },
        },
      },
      {
        timeout: TIMEOUT_MS,
        headers: { api_access_token: target.api_token, 'Content-Type': 'application/json' },
      }
    );
    return { id: res.data?.id, name: res.data?.name, channelType: res.data?.channel_type ?? null };
  } catch (error) {
    throw describeError(error, 'criacao da inbox no Connect');
  }
};

/** URL que o redirector usa como destino do canal, ja no formato do Chatwoot. */
export const chatwootWhatsappWebhookUrl = (baseUrl: string, phoneNumber: string): string => {
  const base = baseUrl.replace(/\/+$/, '');
  const digits = phoneNumber.replace(/\D/g, '');
  return `${base}/webhooks/whatsapp/+${digits}`;
};

export const chatwootInstagramWebhookUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/webhooks/instagram`;
