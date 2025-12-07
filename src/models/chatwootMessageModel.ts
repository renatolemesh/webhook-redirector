import pool from '../config/database';

export interface ChatwootMessage {
  id: number;
  phone_number: string;
  contact_name: string | null;
  content: string;
  message_type: 'outgoing' | 'note';
  status: 'pending' | 'processing' | 'success' | 'failed';
  attempt_count: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  error_message: string | null;
  content_type: string | null;
  template_params: string | null;
  processed_params: string | null;
  created_at: Date;
}

/**
 * Create a new Chatwoot message job
 */
export const createChatwootMessage = async (
  phoneNumber: string,
  content: string,
  messageType: 'outgoing' | 'note',
  contactName?: string | null,
  contentType?: string | null,
  templateParams?: string | null,
  processedParams?: string | null
): Promise<ChatwootMessage> => {
  const res = await pool.query(
    `INSERT INTO chatwoot_messages 
     (phone_number, contact_name, content, message_type, content_type, template_params, processed_params) 
     VALUES ($1, $2, $3, $4, $5, $6, $7) 
     RETURNING *`,
    [phoneNumber, contactName || null, content, messageType, contentType || null, templateParams || null, processedParams || null]
  );
  return res.rows[0];
};

/**
 * Get pending Chatwoot messages that are due for processing
 */
export const getDueChatwootMessages = async (limit: number = 10): Promise<ChatwootMessage[]> => {
  const res = await pool.query(
    `SELECT * FROM chatwoot_messages 
     WHERE status IN ('pending', 'processing') 
     AND next_attempt_at <= NOW() 
     ORDER BY next_attempt_at ASC 
     LIMIT $1`,
    [limit]
  );
  return res.rows;
};

/**
 * Update Chatwoot message status after processing attempt
 */
export const updateChatwootMessageStatus = async (
  messageId: number,
  status: ChatwootMessage['status'],
  attemptCount: number,
  nextAttemptAt: Date | null,
  errorMessage: string | null
): Promise<ChatwootMessage | null> => {
  const res = await pool.query(
    `UPDATE chatwoot_messages 
     SET status = $1, 
         attempt_count = $2, 
         next_attempt_at = $3, 
         last_attempt_at = NOW(), 
         error_message = $4
     WHERE id = $5 
     RETURNING *`,
    [status, attemptCount, nextAttemptAt, errorMessage, messageId]
  );
  return res.rows[0] || null;
};

/**
 * Get message by ID
 */
export const getChatwootMessageById = async (messageId: number): Promise<ChatwootMessage | null> => {
  const res = await pool.query('SELECT * FROM chatwoot_messages WHERE id = $1', [messageId]);
  return res.rows[0] || null;
};

/**
 * Get recent messages with optional status filter
 */
export const getRecentChatwootMessages = async (
  limit: number = 20,
  status?: ChatwootMessage['status']
): Promise<ChatwootMessage[]> => {
  let query = 'SELECT * FROM chatwoot_messages';
  const params: any[] = [];

  if (status) {
    query += ' WHERE status = $1';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);

  const res = await pool.query(query, params);
  return res.rows;
};

/**
 * Get message counts by status
 */
export const getChatwootMessageCounts = async (): Promise<{ status: string; count: string }[]> => {
  const res = await pool.query(
    `SELECT status, COUNT(*) 
     FROM chatwoot_messages 
     GROUP BY status`
  );
  return res.rows;
};