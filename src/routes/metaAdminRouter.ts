import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
  META_PRODUCTS,
  MetaApp,
  MetaAppInput,
  MetaChannelInput,
  getAllMetaApps,
  getMetaAppById,
  createMetaApp,
  updateMetaApp,
  deleteMetaApp,
  getMetaChannels,
  getMetaChannelById,
  createMetaChannel,
  updateMetaChannel,
  deleteMetaChannel,
} from '../models/metaModel';

const router = Router();

// IDs da Meta sao numericos e passam de 2^53, por isso string. A checagem pega
// o erro mais comum de cadastro: colar o telefone (+55...) no lugar do ID.
const DIGITS_RE = /^\d{1,64}$/;
const isDigits = (v: unknown): v is string => typeof v === 'string' && DIGITS_RE.test(v);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const handlePgError = (res: Response, error: any, what: string) => {
  if (error?.code === '23505') return res.status(409).json({ error: `${what} already exists` });
  if (error?.code === '23503') return res.status(400).json({ error: 'meta_app_id does not exist' });
  console.error(`Error saving ${what}:`, error);
  return res.status(500).json({ error: `Failed to save ${what}` });
};

// ---------- apps ----------

/** O App Secret nunca volta para o navegador. */
const publicApp = (app: MetaApp) => {
  const { app_secret, ...rest } = app;
  return { ...rest, has_app_secret: Boolean(app_secret), webhook_path: `/webhook/app/${app.app_id}` };
};

const validateApp = (a: MetaAppInput): string | null => {
  if (!isNonEmpty(a.name)) return 'name is required';
  if (!isDigits(a.app_id)) return 'app_id must be the numeric Meta App ID, as a string';
  if (!isNonEmpty(a.app_secret)) return 'app_secret is required';
  if (!isNonEmpty(a.verify_token) || a.verify_token.length < 16)
    return 'verify_token must have at least 16 characters';
  return null;
};

router.get('/meta/apps', async (_req: Request, res: Response) => {
  try {
    const apps = await getAllMetaApps();
    res.json(apps.map(publicApp));
  } catch (error) {
    console.error('Error fetching meta_apps:', error);
    res.status(500).json({ error: 'Failed to fetch meta apps' });
  }
});

router.post('/meta/apps', async (req: Request, res: Response) => {
  const body = req.body || {};
  const input: MetaAppInput = {
    name: body.name,
    app_id: body.app_id,
    app_secret: body.app_secret,
    verify_token: body.verify_token || crypto.randomBytes(24).toString('hex'),
    is_active: body.is_active !== undefined ? Boolean(body.is_active) : true,
  };
  const err = validateApp(input);
  if (err) return res.status(400).json({ error: err });

  try {
    const created = await createMetaApp(input);
    res.status(201).json(publicApp(created));
  } catch (error) {
    handlePgError(res, error, 'meta app');
  }
});

router.put('/meta/apps/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const existing = await getMetaAppById(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const input: MetaAppInput = {
      name: body.name ?? existing.name,
      app_id: body.app_id ?? existing.app_id,
      // Vazio mantem o atual: a listagem nao devolve o secret, entao o
      // formulario de edicao nao tem como reenvia-lo.
      app_secret: isNonEmpty(body.app_secret) ? body.app_secret : existing.app_secret,
      verify_token: body.verify_token ?? existing.verify_token,
      is_active: body.is_active !== undefined ? Boolean(body.is_active) : existing.is_active,
    };
    const err = validateApp(input);
    if (err) return res.status(400).json({ error: err });

    const updated = await updateMetaApp(id, input);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(publicApp(updated));
  } catch (error) {
    handlePgError(res, error, 'meta app');
  }
});

router.delete('/meta/apps/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const deleted = await deleteMetaApp(id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting meta_app:', error);
    res.status(500).json({ error: 'Failed to delete meta app' });
  }
});

// ---------- channels ----------

const validateChannel = (c: MetaChannelInput): string | null => {
  if (!Number.isInteger(c.meta_app_id) || c.meta_app_id <= 0) return 'meta_app_id is required';
  if (!isNonEmpty(c.name)) return 'name is required';
  if (!META_PRODUCTS.includes(c.product)) return `product must be one of ${META_PRODUCTS.join(', ')}`;
  if (!isDigits(c.external_id))
    return 'external_id must be the numeric WABA / Instagram account / Page ID, as a string';
  if (c.phone_number_id !== null) {
    if (c.product !== 'whatsapp') return 'phone_number_id only applies to whatsapp';
    if (!isDigits(c.phone_number_id))
      return 'phone_number_id must be the numeric Meta phone number ID (not the phone itself)';
  }
  return null;
};

const toPhoneNumberId = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : (v as string);

router.get('/meta/channels', async (req: Request, res: Response) => {
  const appFilter = req.query.meta_app_id ? parseInt(req.query.meta_app_id as string, 10) : undefined;
  if (appFilter !== undefined && isNaN(appFilter)) return res.status(400).json({ error: 'Invalid meta_app_id' });
  try {
    res.json(await getMetaChannels(appFilter));
  } catch (error) {
    console.error('Error fetching meta_channels:', error);
    res.status(500).json({ error: 'Failed to fetch meta channels' });
  }
});

router.post('/meta/channels', async (req: Request, res: Response) => {
  const body = req.body || {};
  const input: MetaChannelInput = {
    meta_app_id: Number(body.meta_app_id),
    name: body.name,
    product: body.product,
    external_id: body.external_id,
    phone_number_id: toPhoneNumberId(body.phone_number_id),
    is_active: body.is_active !== undefined ? Boolean(body.is_active) : true,
  };
  const err = validateChannel(input);
  if (err) return res.status(400).json({ error: err });

  try {
    res.status(201).json(await createMetaChannel(input));
  } catch (error) {
    handlePgError(res, error, 'meta channel');
  }
});

router.put('/meta/channels/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const existing = await getMetaChannelById(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const input: MetaChannelInput = {
      meta_app_id: body.meta_app_id !== undefined ? Number(body.meta_app_id) : existing.meta_app_id,
      name: body.name ?? existing.name,
      product: body.product ?? existing.product,
      external_id: body.external_id ?? existing.external_id,
      phone_number_id:
        body.phone_number_id !== undefined ? toPhoneNumberId(body.phone_number_id) : existing.phone_number_id,
      is_active: body.is_active !== undefined ? Boolean(body.is_active) : existing.is_active,
    };
    const err = validateChannel(input);
    if (err) return res.status(400).json({ error: err });

    const updated = await updateMetaChannel(id, input);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (error) {
    handlePgError(res, error, 'meta channel');
  }
});

router.delete('/meta/channels/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const deleted = await deleteMetaChannel(id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting meta_channel:', error);
    res.status(500).json({ error: 'Failed to delete meta channel' });
  }
});

export default router;
