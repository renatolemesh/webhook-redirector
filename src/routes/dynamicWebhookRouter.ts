import { Router, Request, Response } from 'express';
import { getWebhookConfigBySlug } from '../models/webhookConfigModel';
import { dispatchWebhook } from '../services/dispatcherService';

const router = Router();

/**
 * Shared Meta-style GET handshake: when Meta/other providers verify a webhook
 * URL with hub.mode=subscribe + hub.verify_token, we compare against the
 * webhook_config's inbound_token.
 */
router.get('/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const config = await getWebhookConfigBySlug(slug);
  if (!config || !config.is_active) return res.sendStatus(404);

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && config.inbound_token && token === config.inbound_token) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/**
 * Main ingress. Ack 200 fast, dispatch in the background.
 */
router.post('/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const config = await getWebhookConfigBySlug(slug);

  if (!config || !config.is_active) {
    return res.status(404).json({ error: 'Unknown or inactive webhook slug' });
  }

  // Optional inbound-token check. Accepts either a query param (?token=) or
  // an X-Webhook-Token header. When inbound_token is null on the config,
  // the endpoint is unauthenticated (same as today's /webhook).
  if (config.inbound_token) {
    const provided =
      (req.headers['x-webhook-token'] as string) ||
      (req.headers['x-api-token'] as string) ||
      (req.query.token as string);
    if (provided !== config.inbound_token) {
      return res.status(401).json({ error: 'Invalid webhook token' });
    }
  }

  res.status(200).send('EVENT_RECEIVED');

  try {
    const result = await dispatchWebhook(config, req.body);
    if (!result.handled) {
      console.log(`[webhook:${slug}] not handled: ${result.reason}`);
    }
  } catch (error) {
    console.error(`[webhook:${slug}] dispatch error:`, error);
  }
});

export default router;
