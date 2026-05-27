import { Router, Request, Response } from 'express';
import {
  getAllWebhookConfigs,
  createWebhookConfig,
  updateWebhookConfig,
  deleteWebhookConfig,
  SourceType,
  TargetType,
  WebhookConfigInput,
} from '../models/webhookConfigModel';

const router = Router();

const VALID_SOURCES: SourceType[] = ['meta_cloud_api', 'uazapi'];
const VALID_TARGETS: TargetType[] = ['raw_forward', 'chatwoot_api'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const validateInput = (body: any): string | null => {
  if (!body || typeof body !== 'object') return 'Invalid body';
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  if (!body.slug || typeof body.slug !== 'string' || !SLUG_RE.test(body.slug))
    return 'slug must match [a-z0-9][a-z0-9-]{0,63}';
  if (!VALID_SOURCES.includes(body.source_type)) return 'source_type invalid';
  if (!VALID_TARGETS.includes(body.target_type)) return 'target_type invalid';
  if (!body.target_config || typeof body.target_config !== 'object')
    return 'target_config is required';

  if (body.target_type === 'raw_forward') {
    if (!body.target_config.url || typeof body.target_config.url !== 'string')
      return 'raw_forward requires target_config.url';
  } else if (body.target_type === 'chatwoot_api') {
    const t = body.target_config;
    if (!t.base_url || !t.api_token || !t.account_id)
      return 'chatwoot_api requires target_config.{base_url,api_token,account_id}';
  }

  if (body.source_config !== undefined && typeof body.source_config !== 'object')
    return 'source_config must be an object';

  return null;
};

const toInput = (body: any): WebhookConfigInput => ({
  name: body.name,
  slug: body.slug,
  source_type: body.source_type,
  source_config: body.source_config || {},
  inbound_token: body.inbound_token ?? null,
  target_type: body.target_type,
  target_config: body.target_config,
  is_active: body.is_active !== undefined ? Boolean(body.is_active) : undefined,
});

router.get('/webhook-configs', async (_req: Request, res: Response) => {
  try {
    const rows = await getAllWebhookConfigs();
    res.json(rows);
  } catch (error) {
    console.error('Error fetching webhook_configs:', error);
    res.status(500).json({ error: 'Failed to fetch webhook configs' });
  }
});

router.post('/webhook-configs', async (req: Request, res: Response) => {
  const err = validateInput(req.body);
  if (err) return res.status(400).json({ error: err });

  try {
    const created = await createWebhookConfig(toInput(req.body));
    res.status(201).json(created);
  } catch (error: any) {
    console.error('Error creating webhook_config:', error);
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'slug already exists' });
    }
    res.status(500).json({ error: 'Failed to create webhook config' });
  }
});

router.put('/webhook-configs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  // Allow partial updates but still validate if full shape is supplied.
  if (req.body.source_type || req.body.target_type) {
    const err = validateInput({ ...req.body });
    if (err) return res.status(400).json({ error: err });
  }

  try {
    const updated = await updateWebhookConfig(id, toInput(req.body));
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating webhook_config:', error);
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'slug already exists' });
    }
    res.status(500).json({ error: 'Failed to update webhook config' });
  }
});

router.delete('/webhook-configs/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const deleted = await deleteWebhookConfig(id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting webhook_config:', error);
    res.status(500).json({ error: 'Failed to delete webhook config' });
  }
});

export default router;
