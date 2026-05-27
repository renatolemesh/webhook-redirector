import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

interface Contact {
  id: number;
  name: string;
  phone_number: string;
  identifier: string;
}

interface MessagePayload {
  content: string;
  message_type: 'outgoing' | 'incoming';
  private?: boolean;
  content_type?: string;
  content_attributes?: any;
  template_params?: any;
  source_id?: string;
  // Original event time, forwarded so Chatwoot can render the message at
  // the moment WhatsApp produced it instead of the moment our worker
  // happened to deliver it (which can be much later after retries).
  external_created_at?: number; // unix epoch seconds (Chatwoot convention)
  created_at?: string;          // ISO8601, honored by our patched MessageBuilder
}

export interface ChatwootClientConfig {
  baseUrl: string;
  apiToken: string;
  accountId: number;
  inboxId: number;
}

const attachOriginalTimestamp = (
  payload: MessagePayload,
  originalCreatedAt?: Date | string | null
): void => {
  if (!originalCreatedAt) return;
  const date = originalCreatedAt instanceof Date ? originalCreatedAt : new Date(originalCreatedAt);
  if (Number.isNaN(date.getTime())) return;
  payload.external_created_at = Math.floor(date.getTime() / 1000);
  payload.created_at = date.toISOString();
};

export class ChatwootClient {
  private client: AxiosInstance;
  public readonly accountId: number;
  public readonly inboxId: number;
  public readonly baseUrl: string;

  constructor(config: ChatwootClientConfig) {
    this.accountId = config.accountId;
    this.inboxId = config.inboxId;
    this.baseUrl = config.baseUrl;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: config.apiToken,
      },
    });
  }

  /**
   * Search for a contact by phone number.
   * Returns a contact only when it is an exact match (after stripping `+`),
   * never a fuzzy `q`-search neighbour, to avoid picking a different DDD
   * that happens to share the suffix.
   */
  private async searchContact(phoneNumber: string): Promise<Contact | null> {
    const normalize = (v: string | null | undefined) =>
      (v || '').replace(/^\+/, '');
    const target = normalize(phoneNumber);

    try {
      const response = await this.client.get(
        `/api/v1/accounts/${this.accountId}/contacts/search`,
        { params: { q: phoneNumber } }
      );

      const contacts = response.data.payload;

      if (contacts && contacts.length > 0) {
        const exactMatch = contacts.find(
          (contact: Contact) =>
            normalize(contact.phone_number) === target ||
            normalize(contact.identifier) === target
        );
        return exactMatch || null;
      }

      return null;
    } catch (error: any) {
      console.error('Error searching contact:', error.response?.data || error.message);
      return null;
    }
  }

  private async createContact(
    phoneNumber: string,
    name?: string | null
  ): Promise<Contact> {
    try {
      const body: any = {
        identifier: '+' + phoneNumber,
        phone_number: '+' + phoneNumber,
        custom_attributes: {
          source: 'external-whatsapp-system',
        },
      };

      if (name) {
        body.name = name;
      }

      const response = await this.client.post(
        `/api/v1/accounts/${this.accountId}/contacts`,
        body
      );

      return response.data.payload.contact;
    } catch (error: any) {
      console.error('Error creating contact:', error.response?.data || error.message);
      throw new Error('Failed to create contact');
    }
  }

  private async getOrCreateContact(
    phoneNumber: string,
    name?: string
  ): Promise<Contact> {
    let cleanNumber = phoneNumber.replace(/^\+/, '');
    if (cleanNumber.length < 12) {
      cleanNumber = '55' + cleanNumber;
    }

    let contact = await this.searchContact(cleanNumber);
    if (contact) {
      console.log(`Contact found with ID: ${contact.id}`);
      return contact;
    }

    const hasInitialNine = /^55\d{2}9\d{8}$/.test(cleanNumber);

    if (hasInitialNine) {
      const withoutNine = cleanNumber.slice(0, 4) + cleanNumber.slice(5);
      contact = await this.searchContact(withoutNine);
      if (contact) {
        console.log(`Contact found without initial 9 with ID: ${contact.id}`);
        return contact;
      }
    } else {
      const withNine = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4);
      contact = await this.searchContact(withNine);
      if (contact) {
        console.log(`Contact found with initial 9 with ID: ${contact.id}`);
        return contact;
      }
    }

    console.log('Contact not found, creating new one...');
    contact = await this.createContact(cleanNumber, name);
    console.log(`Contact created with ID: ${contact.id}`);

    return contact;
  }

  private async getContactConversations(contactId: number): Promise<any[]> {
    try {
      const response = await this.client.get(
        `/api/v1/accounts/${this.accountId}/contacts/${contactId}/conversations`
      );
      return response.data.payload || [];
    } catch (error: any) {
      console.error(
        'Error fetching contact conversations:',
        error.response?.data || error.message
      );
      return [];
    }
  }

  private async createConversation(contactId: number): Promise<{ id: number }> {
    try {
      const response = await this.client.post(
        `/api/v1/accounts/${this.accountId}/conversations`,
        {
          source_id: null,
          inbox_id: this.inboxId,
          contact_id: contactId,
          additional_attributes: {
            created_by: 'expertion',
          },
        }
      );

      const conversation = response.data;
      console.log(`New conversation created with ID: ${conversation.id}`);

      return { id: conversation.id };
    } catch (error: any) {
      console.error('Error creating conversation:', error.response?.data || error.message);
      throw new Error('Failed to create conversation');
    }
  }

  private async getOrCreateConversation(contactId: number): Promise<{ id: number }> {
    try {
      const conversations = await this.getContactConversations(contactId);

      const activeConversation = conversations.find(
        (conv: any) => conv.status === 'open' || conv.status === 'pending'
      );

      if (activeConversation) {
        console.log(`Using existing conversation with ID: ${activeConversation.id}`);
        return { id: activeConversation.id };
      }

      console.log('No active conversation found, creating new one...');
      return await this.createConversation(contactId);
    } catch (error: any) {
      console.error(
        'Error in getOrCreateConversation:',
        error.response?.data || error.message
      );
      throw error;
    }
  }

  /**
   * Send an OUTGOING message to a conversation (legacy API: /api/chatwoot/send flow).
   */
  async sendMessage(
    phoneNumber: string,
    content: string,
    isPrivate: boolean = false,
    contactName?: string,
    contentType?: string,
    templateParams?: string,
    contentAttributes?: string,
    originalCreatedAt?: Date | string | null
  ): Promise<string> {
    try {
      const contact = await this.getOrCreateContact(phoneNumber, contactName);
      const conversation = await this.getOrCreateConversation(contact.id);

      const messagePayload: MessagePayload = {
        content,
        message_type: 'outgoing',
        private: isPrivate,
      };

      if (contentType) {
        messagePayload.content_type = contentType;
      }

      if (!isPrivate && templateParams) {
        try {
          messagePayload.template_params = JSON.parse(templateParams);
        } catch (e) {
          console.error('Failed to parse template_params:', e);
        }
      }

      if (contentAttributes) {
        try {
          messagePayload.content_attributes = JSON.parse(contentAttributes);
        } catch (e) {
          console.error('Failed to parse content_attributes:', e);
        }
      }

      attachOriginalTimestamp(messagePayload, originalCreatedAt);

      try {
        fs.writeFileSync(
          '/app/debug/messagePayload.json',
          JSON.stringify(messagePayload, null, 2)
        );
      } catch {
        // debug dir may not exist in all envs; ignore
      }
      console.log('Message payload:', messagePayload);

      await this.client.post(
        `/api/v1/accounts/${this.accountId}/conversations/${conversation.id}/messages`,
        messagePayload
      );

      const messageUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversation.id}/messages`;
      console.log(
        `Message sent successfully to conversation ${conversation.id} (private: ${isPrivate})`
      );
      console.log(`Message endpoint: ${messageUrl}`);

      return messageUrl;
    } catch (error: any) {
      console.error('Error in sendMessage:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Send an INCOMING message to a conversation (used by the dispatcher flow,
   * for translated UAZAPI interactive messages).
   */
  async sendIncomingMessage(
    phoneNumber: string,
    content: string,
    sourceId?: string,
    contactName?: string,
    contentType?: string | null,
    contentAttributes?: Record<string, unknown> | null,
    originalCreatedAt?: Date | string | null
  ): Promise<string> {
    try {
      const contact = await this.getOrCreateContact(phoneNumber, contactName);
      const conversation = await this.getOrCreateConversation(contact.id);

      const messagePayload: MessagePayload = {
        content,
        message_type: 'incoming',
      };
      if (sourceId) messagePayload.source_id = sourceId;
      if (contentType) messagePayload.content_type = contentType;
      if (contentAttributes) messagePayload.content_attributes = contentAttributes;
      attachOriginalTimestamp(messagePayload, originalCreatedAt);

      await this.client.post(
        `/api/v1/accounts/${this.accountId}/conversations/${conversation.id}/messages`,
        messagePayload
      );

      const messageUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversation.id}/messages`;
      console.log(`Incoming message posted to conversation ${conversation.id} (source_id=${sourceId || '-'})`);
      return messageUrl;
    } catch (error: any) {
      console.error('Error in sendIncomingMessage:', error.response?.data || error.message);
      throw error;
    }
  }

  async getConversationMessageUrl(
    phoneNumber: string,
    contactName?: string
  ): Promise<string> {
    try {
      const contact = await this.getOrCreateContact(phoneNumber, contactName);
      const conversation = await this.getOrCreateConversation(contact.id);
      return `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversation.id}/messages`;
    } catch (error: any) {
      console.error('Error getting conversation URL:', error.response?.data || error.message);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton, wired from env vars. Preserves existing behavior of the
// /api/chatwoot/send route and chatwootWorker.
// ---------------------------------------------------------------------------

const envConfig: ChatwootClientConfig = {
  baseUrl: process.env.CHATWOOT_BASE_URL || '',
  apiToken: process.env.CHATWOOT_API_TOKEN || '',
  accountId: Number(process.env.CHATWOOT_ACCOUNT_ID || 1),
  inboxId: Number(process.env.CHATWOOT_INBOX_ID || 2),
};

export const chatwootRequest = new ChatwootClient(envConfig);

// Backwards-compatible alias for any code that imported the old class name.
export { ChatwootClient as ChatwootRequest };
export default ChatwootClient;
