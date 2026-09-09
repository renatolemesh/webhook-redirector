import axios from 'axios';
import { getDueJobs, updateJobStatus, WebhookJob } from '../models/jobQueueModel';
import { getAllConfiguredWebhooks, ConfiguredWebhook } from '../models/webhookModel';
import { getWebhookConfigById, WebhookConfig, RawForwardTargetConfig } from '../models/webhookConfigModel';

const RETRY_SCHEDULE_MS = [0, 0, 0, 0, 10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const WORKER_IDLE_INTERVAL_MS = 5000;
const HTTP_TIMEOUT_MS = 10000;
const HTTP_HARD_CAP_MS = 15000;
const PROCESS_JOB_HARD_CAP_MS = 30000;
const GET_DUE_JOBS_HARD_CAP_MS = 10000;
const BATCH_SIZE = 20;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
};

interface ResolvedTarget {
  name: string;
  url: string;
  token: string | null;
  isActive: boolean;
}

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

/**
 * Resolve a job's outbound target:
 *  - Legacy: job.webhook_id references configured_webhooks.
 *  - Unified: job.webhook_config_id references webhook_configs with target_type=raw_forward.
 */
const resolveTarget = async (job: WebhookJob): Promise<ResolvedTarget | null> => {
  if (job.webhook_id) {
    const wh = webhookCache.get(job.webhook_id);
    if (!wh) return null;
    return { name: wh.name, url: wh.url, token: wh.verification_token || null, isActive: wh.is_active };
  }
  if (job.webhook_config_id) {
    const cfg: WebhookConfig | null = await getWebhookConfigById(job.webhook_config_id);
    if (!cfg) return null;
    if (cfg.target_type !== 'raw_forward') return null;
    const target = cfg.target_config as RawForwardTargetConfig;
    if (!target?.url) return null;
    return { name: cfg.name, url: target.url, token: cfg.inbound_token, isActive: cfg.is_active };
  }
  return null;
};

const processJob = async (job: WebhookJob) => {
  const target = await resolveTarget(job);

  if (!target || !target.isActive) {
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

    if (target.token) {
      headers['X-Webhook-Token'] = target.token;
    }

    const response = await axios.post(target.url, job.payload, {
      headers,
      timeout: HTTP_TIMEOUT_MS,
      signal: AbortSignal.timeout(HTTP_HARD_CAP_MS),
    });

    if (response.status >= 200 && response.status < 300) {
      status = 'success';
      console.log(`Job ${job.id} forwarded successfully to ${target.name}.`);
    } else {
      throw new Error(`Non-success status code: ${response.status}`);
    }
  } catch (error: any) {
    errorMessage = error.message || 'Unknown error during forwarding.';
    console.error(`Job ${job.id} failed attempt ${newAttemptCount} to ${target.name}: ${errorMessage}`);

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
  let foundJobs = false;
  try {
    if (webhookCache.size === 0) {
      await loadWebhookCache();
    }

    const jobs = await withTimeout(getDueJobs(BATCH_SIZE), GET_DUE_JOBS_HARD_CAP_MS, 'getDueJobs');
    foundJobs = jobs.length > 0;

    if (foundJobs) {
      console.log(`Worker found ${jobs.length} jobs to process.`);
      // Process the batch in parallel. Each job is independently bounded by
      // PROCESS_JOB_HARD_CAP_MS, and Promise.allSettled isolates failures so
      // one bad target doesn't stall the rest of the batch.
      await Promise.allSettled(
        jobs.map((job) =>
          withTimeout(processJob(job), PROCESS_JOB_HARD_CAP_MS, `processJob ${job.id}`).catch((err) => {
            console.error(`Job ${job.id} aborted:`, err?.message || err);
          })
        )
      );
    }
  } catch (error) {
    console.error('Error in worker loop:', error);
  } finally {
    // Drain mode: when we just processed a full(ish) batch, loop again immediately.
    // Idle mode: 5s sleep so we don't pound the DB on an empty queue.
    setTimeout(workerLoop, foundJobs ? 0 : WORKER_IDLE_INTERVAL_MS);
  }
};

const safeLoadWebhookCache = async () => {
  try {
    await loadWebhookCache();
  } catch (error: any) {
    console.error('Failed to load webhook cache:', error?.message || error);
  }
};

export const startWorker = async () => {
  console.log('Starting webhook job worker...');
  // O loop TEM que arrancar mesmo que o banco ainda nao esteja de pe. Ate
  // 2026-09-09 este await era desprotegido: no reboot de 07/09 a pg-central
  // subiu no mesmo segundo que a API, o loadWebhookCache rejeitou com
  // ECONNREFUSED e o workerLoop() abaixo nunca chegou a ser chamado. Como o
  // server.ts tem um handler de unhandledRejection que so loga, o processo
  // seguiu vivo servindo HTTP com o worker morto por 43h e 4209 jobs
  // empilharam sem uma unica tentativa.
  // O proprio workerLoop recarrega o cache quando ele esta vazio e se
  // reagenda no finally, entao ele se recupera sozinho quando o banco volta.
  await safeLoadWebhookCache();
  setInterval(safeLoadWebhookCache, 60000);
  workerLoop();
};
