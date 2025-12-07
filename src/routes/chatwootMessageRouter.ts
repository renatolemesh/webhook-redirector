import { Router, Request, Response } from 'express';
import { createChatwootMessage, getRecentChatwootMessages, getChatwootMessageCounts } from '../models/chatwootMessageModel';
import { requireApiToken, requireLoginOrToken } from '../middleware/auth';

const router = Router();

/**
 * POST /api/chatwoot/send
 * Send a message to Chatwoot (will be queued)
 * Requires API token authentication
 */
router.post('/send', requireApiToken, async (req: Request, res: Response) => {
  try {
    const { phone_number, content, message_type, contact_name } = req.body;

    if (!phone_number || !content) {
      return res.status(400).json({ 
        error: 'phone_number and content are required' 
      });
    }

    if (!phone_number.match(/^\+?[1-9]\d{1,14}$/)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Use E.164 format (e.g., +5511999998888)' 
      });
    }

    const validMessageType = message_type === 'note' ? 'note' : 'outgoing';

    const message = await createChatwootMessage(
      phone_number,
      content,
      validMessageType,
      contact_name || null
    );

    res.status(201).json({
      success: true,
      message: 'Message queued successfully',
      data: {
        id: message.id,
        phone_number: message.phone_number,
        contact_name: message.contact_name,
        content: message.content,
        message_type: message.message_type,
        status: message.status,
        created_at: message.created_at,
      }
    });
  } catch (error: any) {
    console.error('Error creating Chatwoot message:', error);
    res.status(500).json({ 
      error: 'Failed to queue message',
      details: error.message 
    });
  }
});

/**
 * POST /api/chatwoot/send-with-note
 * Send both an outgoing message and a private note
 * Requires API token authentication
 */
router.post('/send-note', requireApiToken, async (req: Request, res: Response) => {
  try {
    const { to, content, content_type, template_params, processed_params, contact_name } = req.body;

    if (!to || !content) {
      return res.status(400).json({ 
        error: 'to and content are required' 
      });
    }

    if (isNaN(parseInt(to, 10))) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Only numbers are allowed' 
      });
    }

    // Serialize template_params and processed_params if they're objects
    let serializedTemplateParams = null;
    let serializedProcessedParams = null;

    if (template_params) {
      serializedTemplateParams = typeof template_params === 'string' 
        ? template_params 
        : JSON.stringify(template_params);
    }

    if (processed_params) {
      serializedProcessedParams = typeof processed_params === 'string' 
        ? processed_params 
        : JSON.stringify(processed_params);
    }

    const noteMessage = await createChatwootMessage(
      to,
      content,
      'note',  // ← Changed from 'outgoing' to 'note'
      contact_name || null,
      content_type || null,
      serializedTemplateParams,
      serializedProcessedParams
    );

    res.status(201).json({
      success: true,
      message: 'Note queued successfully',
      data: {
        id: noteMessage.id,
        phone_number: noteMessage.phone_number,
        contact_name: noteMessage.contact_name,
        content: noteMessage.content,
        message_type: noteMessage.message_type,
        status: noteMessage.status,
        created_at: noteMessage.created_at,
      }
    });
  } catch (error: any) {
    console.error('Error creating Chatwoot note:', error);
    res.status(500).json({ 
      error: 'Failed to queue note',
      details: error.message 
    });
  }
});

/**
 * GET /api/chatwoot/messages
 * Get recent Chatwoot messages
 * Allows both session and token authentication
 */
router.get('/messages', requireLoginOrToken, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as any;

    const messages = await getRecentChatwootMessages(limit, status);
    res.json(messages);
  } catch (error: any) {
    console.error('Error fetching Chatwoot messages:', error);
    res.status(500).json({ 
      error: 'Failed to fetch messages',
      details: error.message 
    });
  }
});

/**
 * GET /api/chatwoot/status
 * Get message counts by status
 * Allows both session and token authentication
 */
router.get('/status', requireLoginOrToken, async (req: Request, res: Response) => {
  try {
    const counts = await getChatwootMessageCounts();
    res.json(counts);
  } catch (error: any) {
    console.error('Error fetching message counts:', error);
    res.status(500).json({ 
      error: 'Failed to fetch message counts',
      details: error.message 
    });
  }
});

export default router;