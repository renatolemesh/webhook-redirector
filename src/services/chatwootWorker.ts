import { getDueChatwootMessages, updateChatwootMessageStatus, ChatwootMessage } from '../models/chatwootMessageModel';
import { chatwootRequest, ChatwootClient, ChatwootClientConfig } from './chatwootRequests';
import { getWebhookConfigById } from '../models/webhookConfigModel';

interface ChatwootApiTargetShape {
  base_url: string;
  api_token: string;
  account_id: number;
  inbox_id?: number;
}

const buildClientFromTarget = (target: ChatwootApiTargetShape): ChatwootClient => {
  const config: ChatwootClientConfig = {
    baseUrl: target.base_url,
    apiToken: target.api_token,
    accountId: Number(target.account_id),
    inboxId: Number(target.inbox_id ?? 0) || 0,
  };
  return new ChatwootClient(config);
};

const RETRY_SCHEDULE_MS = [
  0,                    // Attempt 1: immediate
  5 * 1000,            // Attempt 2: 5 seconds
  30 * 1000,           // Attempt 3: 30 seconds
  2 * 60 * 1000,       // Attempt 4: 2 minutes
  10 * 60 * 1000,      // Attempt 5: 10 minutes
  30 * 60 * 1000,      // Attempt 6: 30 minutes
  60 * 60 * 1000,      // Attempt 7: 1 hour
  6 * 60 * 60 * 1000   // Attempt 8: 6 hours
];

const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const WORKER_INTERVAL_MS = 5000; // Check every 5 seconds
const PROCESS_MESSAGE_HARD_CAP_MS = 30000;
const GET_DUE_MESSAGES_HARD_CAP_MS = 10000;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
};

const calculateNextAttemptTime = (attemptCount: number): Date => {
  if (attemptCount >= MAX_ATTEMPTS) {
    // Failed permanently - set far future date
    return new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  }
  const delayMs = RETRY_SCHEDULE_MS[attemptCount];
  return new Date(Date.now() + delayMs);
};

const processChatwootMessage = async (message: ChatwootMessage) => {
  const newAttemptCount = message.attempt_count + 1;
  let nextAttemptAt: Date | null = null;
  let status: ChatwootMessage['status'] = 'processing';
  let errorMessage: string | null = null;

  try {
    console.log(`Processing Chatwoot message ${message.id} (attempt ${newAttemptCount}/${MAX_ATTEMPTS})`);

    if (message.message_type === 'incoming' && message.target_config) {
      // Unified dispatch flow: prefer the live target_config from webhook_configs
      // so a token rotation in the dashboard takes effect on in-flight retries.
      // Fall back to the snapshot taken at enqueue time if the row was deleted.
      let target = message.target_config as unknown as ChatwootApiTargetShape;
      if (message.webhook_config_id) {
        const liveConfig = await getWebhookConfigById(message.webhook_config_id);
        if (liveConfig && liveConfig.target_type === 'chatwoot_api') {
          target = liveConfig.target_config as unknown as ChatwootApiTargetShape;
        }
      }
      const client = buildClientFromTarget(target);
      await client.sendIncomingMessage(
        message.phone_number,
        message.content,
        message.source_id || undefined,
        message.contact_name || undefined,
        message.content_type || undefined,
        message.content_attributes || undefined,
        message.created_at || null
      );
      status = 'success';
      console.log(`✓ Incoming Chatwoot message ${message.id} posted to ${message.phone_number} (source_id=${message.source_id || '-'})`);
    } else {
      // Legacy flow: outgoing / note via env-var singleton.
      const isPrivate = message.message_type === 'note';
      await chatwootRequest.sendMessage(
        message.phone_number,
        message.content,
        isPrivate,
        message.contact_name || undefined,
        message.content_type || undefined,
        message.template_params || undefined,
        message.processed_params || undefined,
        message.created_at || null
      );
      status = 'success';
      console.log(`✓ Chatwoot message ${message.id} sent successfully to ${message.phone_number} (${isPrivate ? 'private note' : 'public message'})`);
    }
  } catch (error: any) {
    errorMessage = error.message || 'Unknown error during Chatwoot request';
    console.error(`✗ Chatwoot message ${message.id} failed (attempt ${newAttemptCount}): ${errorMessage}`);

    if (newAttemptCount < MAX_ATTEMPTS) {
      status = 'pending';
      nextAttemptAt = calculateNextAttemptTime(newAttemptCount);
      console.log(`  → Retry scheduled for ${nextAttemptAt.toISOString()}`);
    } else {
      status = 'failed';
      console.log(`  → Message ${message.id} failed permanently after ${MAX_ATTEMPTS} attempts`);
    }
  }

  // Update message status in database
  try {
    await updateChatwootMessageStatus(
      message.id,
      status,
      newAttemptCount,
      nextAttemptAt,
      errorMessage
    );
  } catch (dbError) {
    console.error(`CRITICAL: Failed to update Chatwoot message status for message ${message.id}:`, dbError);
  }
};

const chatwootWorkerLoop = async () => {
  try {
    const messages = await withTimeout(
      getDueChatwootMessages(10),
      GET_DUE_MESSAGES_HARD_CAP_MS,
      'getDueChatwootMessages'
    );

    if (messages.length > 0) {
      console.log(`Chatwoot worker found ${messages.length} messages to process`);

      // Process messages sequentially to avoid overwhelming Chatwoot API
      for (const message of messages) {
        await withTimeout(
          processChatwootMessage(message),
          PROCESS_MESSAGE_HARD_CAP_MS,
          `processChatwootMessage ${message.id}`
        );
      }
    }
  } catch (error) {
    console.error('Error in Chatwoot worker loop:', error);
  } finally {
    setTimeout(chatwootWorkerLoop, WORKER_INTERVAL_MS);
  }
};

export const startChatwootWorker = async () => {
  console.log('Starting Chatwoot message worker...');
  chatwootWorkerLoop();
};