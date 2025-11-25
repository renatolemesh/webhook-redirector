import { getActiveConfiguredWebhooks, saveReceivedWebhook } from './webhookModel';
import { createJob } from './jobQueueModel';
import axios from 'axios';

/**
 * Saves the received webhook and creates a job for each active configured webhook.
 * @param payload The webhook payload received from Meta.
 */
export const forwardWebhook = async (payload: any) => {
  const activeWebhooks = await getActiveConfiguredWebhooks();

  // 1. Save the received webhook to the database (for logging the raw payload)
  try {
    await saveReceivedWebhook(payload);
  } catch (error) {
    console.error('Error saving received webhook to DB:', error);
    // Continue, as the main goal is to create jobs
  }

  // 2. Create a job for each active webhook
  const jobCreationPromises = activeWebhooks.map(async (webhook) => {
    try {
      await createJob(webhook.id, payload);
      console.log(`Job created for ${webhook.name} (${webhook.url})`);
    } catch (error) {
      console.error(`Error creating job for ${webhook.name}:`, error);
    }
  });

  await Promise.all(jobCreationPromises);

  console.log(`Webhook received and ${activeWebhooks.length} jobs created for forwarding.`);
};

/**
 * Handles GET requests - forwards to first active webhook and returns response
 */
export const forwardGetRequest = async (
  path: string,
  queryParams: any,
  headers: any
): Promise<{ status: number; data: any; headers: any }> => {
  const activeWebhooks = await getActiveConfiguredWebhooks();

  if (activeWebhooks.length === 0) {
    throw new Error('No active webhooks configured');
  }

  // Use the first active webhook for GET requests
  const targetWebhook = activeWebhooks[0];
  
  try {
    const response = await axios.get(targetWebhook.url + path, {
      params: queryParams,
      headers: {
        ...headers,
        'X-Forwarded-By': 'Meta-Webhook-Forwarder',
      },
      timeout: 30000, // 30 seconds for GET requests
    });

    return {
      status: response.status,
      data: response.data,
      headers: response.headers,
    };
  } catch (error: any) {
    console.error(`Error forwarding GET request to ${targetWebhook.name}:`, error.message);
    throw error;
  }
};
