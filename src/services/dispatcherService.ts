import { WebhookConfig, ChatwootApiTargetConfig, RawForwardTargetConfig } from '../models/webhookConfigModel';
import { saveReceivedWebhook } from '../models/webhookModel';
import { createJob } from '../models/jobQueueModel';
import { createIncomingChatwootMessage } from '../models/chatwootMessageModel';
import { translateUazapiWebhook } from './uazapiTranslator';

/**
 * Dispatches a payload received on POST /webhook/:slug to the appropriate
 * downstream handler based on the webhook_config's target_type.
 *
 * - raw_forward   → same path as legacy `/webhook`: creates a webhook_jobs row
 *                   that jobWorker will POST to the configured URL verbatim.
 * - chatwoot_api  → parses the payload based on source_type, and for supported
 *                   interactive types enqueues a chatwoot_messages row that
 *                   chatwootWorker will post to the target Chatwoot instance.
 *                   Unsupported types are silently ignored (UAZAPI's own
 *                   Chatwoot integration already forwards text/media).
 */
export const dispatchWebhook = async (
  config: WebhookConfig,
  payload: any
): Promise<{ handled: boolean; reason?: string }> => {
  // Audit every payload we accept, regardless of downstream action.
  try {
    await saveReceivedWebhook(payload, config.slug);
  } catch (error) {
    console.error(`[dispatch:${config.slug}] saveReceivedWebhook failed:`, error);
  }

  if (config.target_type === 'raw_forward') {
    return dispatchRawForward(config, payload);
  }

  if (config.target_type === 'chatwoot_api') {
    return dispatchChatwootApi(config, payload);
  }

  return { handled: false, reason: `unknown target_type=${config.target_type}` };
};

const dispatchRawForward = async (
  config: WebhookConfig,
  payload: any
): Promise<{ handled: boolean; reason?: string }> => {
  const target = config.target_config as RawForwardTargetConfig;
  if (!target?.url) {
    return { handled: false, reason: 'raw_forward target_config missing url' };
  }

  // jobWorker resolves the target URL via the configured_webhooks row it
  // finds by webhook_id. For webhook_configs-driven rows we synthesize a
  // minimal "virtual" job: we stash the resolved URL in the payload wrapper
  // so jobWorker can read it from the row if webhook_id is null.
  //
  // To keep jobWorker's contract unchanged, we create a webhook_jobs row
  // with webhook_config_id populated. jobWorker will be taught to resolve
  // the URL from webhook_configs when webhook_id is null.
  await createJob(null, payload, config.id);
  return { handled: true };
};

const dispatchChatwootApi = async (
  config: WebhookConfig,
  payload: any
): Promise<{ handled: boolean; reason?: string }> => {
  const target = config.target_config as ChatwootApiTargetConfig;
  if (!target?.base_url || !target?.api_token || !target?.account_id) {
    return { handled: false, reason: 'chatwoot_api target_config incomplete' };
  }

  let translated = null;
  if (config.source_type === 'uazapi') {
    translated = translateUazapiWebhook(payload);
  }

  if (!translated) {
    return { handled: false, reason: 'no translation for this event (ignored)' };
  }

  await createIncomingChatwootMessage({
    phone_number: translated.phoneNumber,
    content: translated.content,
    contact_name: translated.contactName || null,
    source_id: translated.sourceId,
    webhook_config_id: config.id,
    target_config: target as unknown as Record<string, unknown>,
    content_type: translated.contentType || null,
    content_attributes: translated.contentAttributes || null,
  });

  return { handled: true };
};
