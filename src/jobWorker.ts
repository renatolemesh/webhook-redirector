import axios from 'axios';
import { getDueJobs, updateJobStatus, WebhookJob } from './jobQueueModel';
import { getAllConfiguredWebhooks, ConfiguredWebhook } from './webhookModel';

const RETRY_SCHEDULE_MS = [0, 0, 0, 0, 10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const WORKER_INTERVAL_MS = 5000;

let webhookCache: Map<number, ConfiguredWebhook> = new Map();

const loadWebhookCache = async () => {
  const webhooks = await getAllConfiguredWebhooks();
  webhookCache = new Map(webhooks.map(w => [w.id, w]));
};

const calculateNextAttemptTime = (attemptCount: number): Date => {
  if (attemptCount >= MAX_ATTEMPTS) {
    return new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  }
  const delayMs = RETRY_SCHEDULE_MS[attemptCount];
  return new Date(Date.now() + delayMs);
};

const processJob = async (job: WebhookJob) => {
  const webhook = webhookCache.get(job.webhook_id);

  if (!webhook || !webhook.is_active) {
    await updateJobStatus(job.id, 'failed', job.attempt_count, null, 'Target webhook is inactive or deleted.');
    return;
  }

  const newAttemptCount = job.attempt_count + 1;
  let nextAttemptAt: Date | null = null;
  let status: WebhookJob['status'] = 'processing';
  let errorMessage: string | null = null;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Forwarded-By': 'Meta-Webhook-Forwarder-Worker',
      'X-Attempt-Count': newAttemptCount.toString(),
    };

    if (webhook.verification_token) {
      // header name you agree with Evolution/Chatwoot, e.g. same as Chatwoot expects
      headers['X-Webhook-Token'] = webhook.verification_token;
    }

    const response = await axios.post(webhook.url, job.payload, {
      headers,
      timeout: 10000,
    });

    if (response.status >= 200 && response.status < 300) {
      status = 'success';
      console.log(`Job ${job.id} forwarded successfully to ${webhook.name}.`);
    } else {
      throw new Error(`Non-success status code: ${response.status}`);
    }
  } catch (error: any) {
    errorMessage = error.message || 'Unknown error during forwarding.';
    console.error(`Job ${job.id} failed attempt ${newAttemptCount} to ${webhook.name}: ${errorMessage}`);

    if (newAttemptCount < MAX_ATTEMPTS) {
      status = 'pending';
      nextAttemptAt = calculateNextAttemptTime(newAttemptCount);
      console.log(`Job ${job.id} scheduled for retry at ${nextAttemptAt.toISOString()}`);
    } else {
      status = 'failed';
      console.log(`Job ${job.id} failed permanently after ${MAX_ATTEMPTS} attempts.`);
    }
  }

  try {
    await updateJobStatus(job.id, status, newAttemptCount, nextAttemptAt, errorMessage);
  } catch (dbError) {
    console.error(`CRITICAL: Failed to update job status for Job ${job.id}:`, dbError);
  }
};

const workerLoop = async () => {
  try {
    if (webhookCache.size === 0) {
      await loadWebhookCache();
    }

    const jobs = await getDueJobs(10);

    if (jobs.length > 0) {
      console.log(`Worker found ${jobs.length} jobs to process.`);
      for (const job of jobs) {
        await processJob(job);
      }
    }
  } catch (error) {
    console.error('Error in worker loop:', error);
  } finally {
    setTimeout(workerLoop, WORKER_INTERVAL_MS);
  }
};

export const startWorker = async () => {
  console.log('Starting webhook job worker...');
  await loadWebhookCache();
  setInterval(loadWebhookCache, 60000);
  workerLoop();
};