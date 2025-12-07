import pool from '../config/database';

export interface WebhookJob {
  id: number;
  webhook_id: number;
  payload: any;
  status: 'pending' | 'processing' | 'success' | 'failed';
  attempt_count: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  error_message: string | null;
}

/**
 * Adds a new job to the queue for a specific configured webhook.
 */
export const createJob = async (webhookId: number, payload: any): Promise<WebhookJob> => {
  const res = await pool.query(
    'INSERT INTO webhook_jobs (webhook_id, payload) VALUES ($1, $2) RETURNING *',
    [webhookId, payload]
  );
  return res.rows[0];
};

/**
 * Fetches the next batch of jobs that are due for processing.
 */
export const getDueJobs = async (limit: number = 10): Promise<WebhookJob[]> => {
  const res = await pool.query(
    `SELECT * FROM webhook_jobs 
     WHERE status IN ('pending', 'processing') 
     AND next_attempt_at <= NOW() 
     ORDER BY next_attempt_at ASC 
     LIMIT $1`,
    [limit]
  );
  return res.rows;
};

/**
 * Updates the status of a job after an attempt.
 */
export const updateJobStatus = async (
  jobId: number,
  status: WebhookJob['status'],
  attemptCount: number,
  nextAttemptAt: Date | null,
  errorMessage: string | null
): Promise<WebhookJob | null> => {
  const res = await pool.query(
    `UPDATE webhook_jobs 
     SET status = $1, 
         attempt_count = $2, 
         next_attempt_at = $3, 
         last_attempt_at = NOW(), 
         error_message = $4
     WHERE id = $5 
     RETURNING *`,
    [status, attemptCount, nextAttemptAt, errorMessage, jobId]
  );
  return res.rows[0] || null;
};

/**
 * Gets a job by its ID.
 */
export const getJobById = async (jobId: number): Promise<WebhookJob | null> => {
  const res = await pool.query('SELECT * FROM webhook_jobs WHERE id = $1', [jobId]);
  return res.rows[0] || null;
};

/**
 * Gets the total count of jobs by status.
 */
export const getJobCounts = async (): Promise<{ status: string; count: string }[]> => {
  const res = await pool.query(
    `SELECT status, COUNT(*) 
     FROM webhook_jobs 
     GROUP BY status`
  );
  return res.rows;
};
