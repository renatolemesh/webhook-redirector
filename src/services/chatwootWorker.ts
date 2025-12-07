import { getDueChatwootMessages, updateChatwootMessageStatus, ChatwootMessage } from '../models/chatwootMessageModel';
import { chatwootRequest } from './chatwootRequests';

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

    // Determine if this is a private note (true) or public message (false)
    const isPrivate = message.message_type === 'note';

    // Send message to Chatwoot
    await chatwootRequest.sendMessage(
      message.phone_number,
      message.content,
      isPrivate,
      message.contact_name || undefined,
      message.content_type || undefined,
      message.template_params || undefined
    );

    status = 'success';
    console.log(`✓ Chatwoot message ${message.id} sent successfully to ${message.phone_number} (${isPrivate ? 'private note' : 'public message'})`);

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
    const messages = await getDueChatwootMessages(10);

    if (messages.length > 0) {
      console.log(`Chatwoot worker found ${messages.length} messages to process`);
      
      // Process messages sequentially to avoid overwhelming Chatwoot API
      for (const message of messages) {
        await processChatwootMessage(message);
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