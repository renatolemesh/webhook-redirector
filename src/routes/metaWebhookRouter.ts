import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getMetaAppByAppId, getActiveRoutesForApp } from '../models/metaModel';
import { saveReceivedWebhook } from '../models/webhookModel';
import { routeToTarget } from '../services/dispatcherService';
import { resolveMetaPayload } from '../services/metaResolver';

const router = Router();

/** Valor gravado em received_webhooks.slug, para filtrar no /api/received?slug=. */
export const auditSlugForApp = (appId: string) => `meta-app-${appId}`;

/**
 * X-Hub-Signature-256 e o HMAC-SHA256 do corpo CRU com o App Secret. Tem de ser
 * o buffer original: o JSON re-serializado pelo express.json nao bate byte a
 * byte (ordem de chaves, escapes unicode).
 */
export const isValidSignature = (
  rawBody: Buffer | undefined,
  header: unknown,
  secret: string
): boolean => {
  if (!rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(header.slice('sha256='.length), 'hex');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};

/** Handshake do painel da Meta ao cadastrar a URL de callback do app. */
router.get('/:appId', async (req: Request, res: Response) => {
  const app = await getMetaAppByAppId(req.params.appId);
  if (!app || !app.is_active) return res.sendStatus(404);

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === app.verify_token) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/:appId', async (req: Request, res: Response) => {
  const app = await getMetaAppByAppId(req.params.appId);
  if (!app || !app.is_active) return res.sendStatus(404);

  // Sem assinatura valida, quem descobrir a URL injeta mensagem falsa no
  // Chatwoot do cliente. O 401 faz a Meta reenviar o evento com frequencia
  // decrescente, entao um App Secret errado no cadastro atrasa as mensagens em
  // vez de perde-las de imediato - mas a janela de reenvio e finita.
  if (!isValidSignature((req as { rawBody?: Buffer } & Request).rawBody, req.headers['x-hub-signature-256'], app.app_secret)) {
    console.warn(`[meta-app:${app.app_id}] assinatura invalida, payload recusado`);
    return res.sendStatus(401);
  }

  res.status(200).send('EVENT_RECEIVED');

  const payload = req.body;

  // Auditoria uma vez por POST, com o payload original. Gravar a copia de cada
  // endpoint multiplicaria o received_webhooks, que ja passa de 600 MB.
  try {
    await saveReceivedWebhook(payload, auditSlugForApp(app.app_id));
  } catch (error) {
    console.error(`[meta-app:${app.app_id}] saveReceivedWebhook failed:`, error);
  }

  try {
    const routes = await getActiveRoutesForApp(app.id);
    const { routed, unrouted } = resolveMetaPayload(payload, routes);
    for (const miss of unrouted) {
      console.warn(`[meta-app:${app.app_id}] sem canal ou endpoint ativo para ${miss}`);
    }
    for (const { config, payload: part } of routed) {
      const result = await routeToTarget(config, part);
      if (!result.handled) {
        console.log(`[meta-app:${app.app_id} -> ${config.slug}] not handled: ${result.reason}`);
      }
    }
  } catch (error) {
    console.error(`[meta-app:${app.app_id}] dispatch error:`, error);
  }
});

export default router;
