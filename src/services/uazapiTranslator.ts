/**
 * Translates UAZAPI (Baileys-style) webhook payloads into a Chatwoot-flat
 * message representation for the interactive message types UAZAPI flattens
 * into placeholder strings ("[Botoes enviados]", "[Lista enviada]").
 *
 * Returns null for anything we don't want to re-post — regular text / media
 * messages are already being posted to Chatwoot by UAZAPI's own integration,
 * and we do not want duplicates there.
 */

export interface TranslatedMessageItem {
  title: string;
  value: string;
}

export interface TranslatedMessage {
  phoneNumber: string;
  content: string;
  sourceId: string;
  contactName?: string;
  contentType?: 'input_select';
  contentAttributes?: {
    items: TranslatedMessageItem[];
  };
}

interface UazapiButton {
  buttonID?: string;
  buttonText?: { displayText?: string };
}

interface UazapiListRow {
  rowId?: string;
  title?: string;
  description?: string;
}

interface UazapiListSection {
  title?: string;
  rows?: UazapiListRow[];
}

const extractPhone = (chatid: string | undefined): string | null => {
  if (!chatid) return null;
  // "5511950697887@s.whatsapp.net" -> "5511950697887"
  // Groups ("@g.us") and LIDs ("@lid") are ignored — Chatwoot contact lookup
  // expects a real phone number.
  const suffix = chatid.split('@')[1];
  if (suffix !== 's.whatsapp.net') return null;
  const digits = chatid.split('@')[0].replace(/\D/g, '');
  return digits || null;
};

const buildSourceId = (owner: string | undefined, messageId: string | undefined): string => {
  return `${owner || ''}:${messageId || ''}`;
};

interface InteractivePayload {
  body: string;
  items: TranslatedMessageItem[];
}

const extractButtonsMessage = (buttonsMessage: any): InteractivePayload => {
  const body: string = buttonsMessage?.contentText || '';
  const buttons: UazapiButton[] = Array.isArray(buttonsMessage?.buttons)
    ? buttonsMessage.buttons
    : [];

  const items: TranslatedMessageItem[] = [];
  for (const b of buttons) {
    const title = b?.buttonText?.displayText;
    if (!title) continue;
    items.push({ title, value: b.buttonID || title });
  }

  return { body, items };
};

const extractListMessage = (listMessage: any): InteractivePayload => {
  const body: string = listMessage?.description || listMessage?.title || '';
  const sections: UazapiListSection[] = Array.isArray(listMessage?.sections)
    ? listMessage.sections
    : [];

  const items: TranslatedMessageItem[] = [];
  for (const section of sections) {
    for (const row of section?.rows || []) {
      if (!row?.title) continue;
      const title = row.description ? `${row.title} — ${row.description}` : row.title;
      items.push({ title, value: row.rowId || row.title });
    }
  }

  return { body, items };
};

/**
 * WhatsApp Business template messages (Meta-approved marketing/utility templates)
 * arrive from UAZAPI as messageType=TemplateMessage. The rendered content lives
 * under content.hydratedTemplate — header title, body text, footer text, and
 * a hydratedButtons[] array that can contain QuickReplyButton / UrlButton /
 * CallButton variants.
 */
const extractTemplateMessage = (templateMessage: any): InteractivePayload => {
  const hyd = templateMessage?.hydratedTemplate || {};
  const title: string = hyd?.Title?.HydratedTitleText || hyd?.hydratedTitleText || '';
  const body: string = hyd?.hydratedContentText || '';
  const footer: string = hyd?.hydratedFooterText || '';
  const buttons: any[] = Array.isArray(hyd?.hydratedButtons) ? hyd.hydratedButtons : [];

  const items: TranslatedMessageItem[] = [];
  for (const entry of buttons) {
    const b = entry?.HydratedButton || entry;
    const quickReply = b?.QuickReplyButton;
    if (quickReply?.displayText) {
      items.push({
        title: quickReply.displayText,
        value: quickReply.id || quickReply.displayText,
      });
      continue;
    }
    // UrlButton / CallButton are non-reply buttons; fall back to displayText
    // as both title and value so the agent can at least see them.
    const displayText = b?.UrlButton?.displayText || b?.CallButton?.displayText || b?.displayText;
    if (displayText) {
      items.push({ title: displayText, value: displayText });
    }
  }

  const parts: string[] = [];
  if (title) parts.push(`*${title}*`);
  if (body) parts.push(body);
  if (footer) parts.push(`_${footer}_`);
  return { body: parts.join('\n\n').trim(), items };
};

export const translateUazapiWebhook = (payload: any): TranslatedMessage | null => {
  const message = payload?.message || payload;
  if (!message || typeof message !== 'object') return null;
  if (message.fromMe === true) return null;

  const messageType: string | undefined = message.messageType;
  const content = message.content || {};

  let payloadData: InteractivePayload | null = null;

  // Some UAZAPI events wrap the interactive payload under a typed key
  // (e.g. content.buttonsMessage), others flatten the fields directly onto
  // content (e.g. TemplateMessage with hydratedTemplate at the top level).
  if (messageType === 'ButtonsMessage') {
    payloadData = extractButtonsMessage(content.buttonsMessage || content);
  } else if (messageType === 'ListMessage') {
    payloadData = extractListMessage(content.listMessage || content);
  } else if (messageType === 'TemplateMessage') {
    payloadData = extractTemplateMessage(content.templateMessage || content);
  } else {
    return null;
  }

  const phoneNumber = extractPhone(message.chatid || message.sender_pn);
  if (!phoneNumber || !payloadData) return null;
  if (!payloadData.body && payloadData.items.length === 0) return null;

  const base: TranslatedMessage = {
    phoneNumber,
    content: payloadData.body,
    sourceId: buildSourceId(message.owner, message.messageid || message.id),
    contactName: message.senderName || undefined,
  };

  if (payloadData.items.length > 0) {
    base.contentType = 'input_select';
    base.contentAttributes = { items: payloadData.items };
  }

  return base;
};
