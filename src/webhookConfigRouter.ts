import { Router, Request, Response } from 'express';
import {
  getAllConfiguredWebhooks,
  createConfiguredWebhook,
  updateConfiguredWebhook,
  deleteConfiguredWebhook,
  getRecentReceivedWebhooks,
} from './webhookModel';
import { getJobCounts } from './jobQueueModel';
import { forwardGetRequest } from './forwarderService';

const router = Router();

// All routes here already protected in index.ts with basicAuthMiddleware

// GET /api/webhooks
router.get('/webhooks', async (req: Request, res: Response) => {
  try {
    const webhooks = await getAllConfiguredWebhooks();
    res.json(webhooks);
  } catch (error) {
    console.error('Error fetching webhooks:', error);
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

// POST /api/webhooks
router.post('/webhooks', async (req: Request, res: Response) => {
  const { name, url, verification_token } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }

  try {
    const newWebhook = await createConfiguredWebhook(name, url, verification_token);
    res.status(201).json(newWebhook);
  } catch (error) {
    console.error('Error creating webhook:', error);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// PUT /api/webhooks/:id
router.put('/webhooks/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { name, url, is_active, verification_token } = req.body;

  if (isNaN(id) || !name || !url || typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid ID, name, URL, or is_active status' });
  }

  try {
    const updatedWebhook = await updateConfiguredWebhook(id, name, url, is_active, verification_token);
    if (updatedWebhook) {
      res.json(updatedWebhook);
    } else {
      res.status(404).json({ error: 'Webhook not found' });
    }
  } catch (error) {
    console.error('Error updating webhook:', error);
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

// DELETE /api/webhooks/:id
router.delete('/webhooks/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  try {
    const deleted = await deleteConfiguredWebhook(id);
    if (deleted) {
      res.status(204).send();
    } else {
      res.status(404).json({ error: 'Webhook not found' });
    }
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// GET /api/received
router.get('/received', async (req: Request, res: Response) => {
  try {
    const received = await getRecentReceivedWebhooks(20);
    res.json(received);
  } catch (error) {
    console.error('Error fetching received webhooks:', error);
    res.status(500).json({ error: 'Failed to fetch received webhooks' });
  }
});

// GET /api/jobs/status
router.get('/jobs/status', async (req: Request, res: Response) => {
  try {
    const counts = await getJobCounts();
    res.json(counts);
  } catch (error) {
    console.error('Error fetching job counts:', error);
    res.status(500).json({ error: 'Failed to fetch job counts' });
  }
});

// Optional: forwarding GETs
router.get('/webhook/', async (req: Request, res: Response) => {
  try {
    const path = req.path.replace('/webhook', '');
    const result = await forwardGetRequest(path, req.query, req.headers);

    res.status(result.status).set(result.headers).json(result.data);
  } catch (error: any) {
    console.error('Error forwarding GET request:', error);

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: 'Failed to forward request' });
    }
  }
});

export default router;