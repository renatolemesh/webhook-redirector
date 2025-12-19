import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

import logger from '../utils/logger';

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const INBOX_ID = process.env.CHATWOOT_INBOX_ID || 2;
const API_ACCESS_TOKEN = process.env.CHATWOOT_API_TOKEN;

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
  template_params?: any;
}

class ChatwootRequest {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: CHATWOOT_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': API_ACCESS_TOKEN,
      },
    });
  }

  /**
   * Search for a contact by phone number
   */
  private async searchContact(phoneNumber: string): Promise<Contact | null> {
    try {
      const response = await this.client.get(
        `/api/v1/accounts/${ACCOUNT_ID}/contacts/search`,
        {
          params: {
            q: phoneNumber,
          },
        }
      );

      const contacts = response.data.payload;
      
      if (contacts && contacts.length > 0) {
        // Find exact match by phone number
        const exactMatch = contacts.find(
          (contact: Contact) => 
            contact.phone_number === phoneNumber || 
            contact.identifier === phoneNumber
        );
        
        return exactMatch || contacts[0];
      }

      return null;
    } catch (error: any) {
      console.error('Error searching contact:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Create a new contact
   */
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

      // Only add name if it is NOT null, undefined, or empty
      if (name) {
        body.name = name;
      }

      const response = await this.client.post(
        `/api/v1/accounts/${ACCOUNT_ID}/contacts`,
        body
      );

      return response.data.payload.contact;
    } catch (error: any) {
      console.error('Error creating contact:', error.response?.data || error.message);
      throw new Error('Failed to create contact');
    }
  }

  /**
   * Get or create a contact by phone number
   */
  private async getOrCreateContact(
    phoneNumber: string,
    name?: string
  ): Promise<Contact> {
    // Remove the "+" if present
    let cleanNumber = phoneNumber.replace(/^\+/, '');
    if (cleanNumber.length < 12 ) {
      cleanNumber = '55' + cleanNumber;
    }
    
    // First, try to find existing contact with the cleaned number
    let contact = await this.searchContact(cleanNumber);
    
    if (contact) {
      console.log(`Contact found with ID: ${contact.id}`);
      return contact;
    }
    
    // Check if number has the initial 9 (after country code 55 and area code)
    // Pattern: 55 (country) + 2 digits (area code) + 9 + 8 digits
    const hasInitialNine = /^55\d{2}9\d{8}$/.test(cleanNumber);
    
    if (hasInitialNine) {
      // Try without the 9 (remove the 9 after area code)
      const withoutNine = cleanNumber.slice(0, 4) + cleanNumber.slice(5);
      contact = await this.searchContact(withoutNine);
      
      if (contact) {
        console.log(`Contact found without initial 9 with ID: ${contact.id}`);
        return contact;
      }
    } else {
      // Try with the 9 (add 9 after area code)
      const withNine = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4);
      contact = await this.searchContact(withNine);
      
      if (contact) {
        console.log(`Contact found with initial 9 with ID: ${contact.id}`);
        return contact;
      }
    }

    // If not found, create new contact with the original cleaned number
    console.log('Contact not found, creating new one...');
    contact = await this.createContact(cleanNumber, name);
    console.log(`Contact created with ID: ${contact.id}`);
    
    return contact;
  }

  /**
   * Get existing conversations for a contact
   */
  private async getContactConversations(contactId: number): Promise<any[]> {
    try {
      const response = await this.client.get(
        `/api/v1/accounts/${ACCOUNT_ID}/contacts/${contactId}/conversations`
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

  /**
   * Create a new conversation for the contact
   */
  private async createConversation(contactId: number): Promise<{ id: number }> {
    try {
      const response = await this.client.post(
        `/api/v1/accounts/${ACCOUNT_ID}/conversations`,
        {
          source_id: null,
          inbox_id: INBOX_ID,
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

  /**
   * Get or create a conversation for the contact
   * First checks for existing open conversations, if none exist, creates a new one
   */
  private async getOrCreateConversation(
    contactId: number
  ): Promise<{ id: number }> {
    try {
      const conversations = await this.getContactConversations(contactId);

      const activeConversation = conversations.find(
        (conv: any) => conv.status === 'open' || conv.status === 'pending'
      );

      if (activeConversation) {
        console.log(
          `Using existing conversation with ID: ${activeConversation.id}`
        );
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
   * Send a message to a conversation
   */
  async sendMessage(
    phoneNumber: string,
    content: string,
    isPrivate: boolean = false,
    contactName?: string,
    contentType?: string,
    templateParams?: string
  ): Promise<string> {
    try {
      // Step 1: Get or create contact
      const contact = await this.getOrCreateContact(phoneNumber, contactName);

      // Step 2: Get or create conversation
      const conversation = await this.getOrCreateConversation(contact.id);

      // Step 3: Prepare message payload
      const messagePayload: MessagePayload = {
        content,
        message_type: 'outgoing',
        private: isPrivate,
      };

      // Add optional fields if provided
      if (contentType) {
        messagePayload.content_type = contentType;
      }

      // if (templateParams) {
      //   try {
      //     messagePayload.template_params = JSON.parse(templateParams);
      //   } catch (e) {
      //     console.error('Failed to parse template_params:', e);
      //   }
      // }

      // Step 4: Send message
      await this.client.post(
        `/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversation.id}/messages`,
        messagePayload
      );

      const messageUrl = `${CHATWOOT_BASE_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversation.id}/messages`;
      
      console.log(`Message sent successfully to conversation ${conversation.id} (private: ${isPrivate})`);
      console.log(`Message endpoint: ${messageUrl}`);

      return messageUrl;
    } catch (error: any) {
      console.error('Error in sendMessage:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get the conversation message endpoint URL for a phone number
   */
  async getConversationMessageUrl(phoneNumber: string, contactName?: string): Promise<string> {
    try {
      const contact = await this.getOrCreateContact(phoneNumber, contactName);
      const conversation = await this.getOrCreateConversation(contact.id);
      
      return `${CHATWOOT_BASE_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversation.id}/messages`;
    } catch (error: any) {
      console.error('Error getting conversation URL:', error.response?.data || error.message);
      throw error;
    }
  }
}

// Export singleton instance
export const chatwootRequest = new ChatwootRequest();

// Export class for custom instances if needed
export default ChatwootRequest;