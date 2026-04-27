import { ChatContext, ChatContextMessage, NormalizedMessageEvent } from "../llm/schemas";

export const DEFAULT_CONTEXT_WINDOW_MS = Number(process.env.PROJECTPILOT_CONTEXT_WINDOW_MS || 15 * 60_000);
export const DEFAULT_CONTEXT_MAX_MESSAGES = Number(process.env.PROJECTPILOT_CONTEXT_MAX_MESSAGES || 20);

const chatContexts = new Map<string, ChatContext>();

export function getChatContext(chatId: string) {
  let context = chatContexts.get(chatId);
  if (!context) {
    context = { chatId, messages: [] };
    chatContexts.set(chatId, context);
  }
  return context;
}

export function pruneChatContext(
  context: ChatContext,
  now = Date.now(),
  windowMs = DEFAULT_CONTEXT_WINDOW_MS,
  maxMessages = DEFAULT_CONTEXT_MAX_MESSAGES,
) {
  const earliest = now - windowMs;
  context.messages = context.messages
    .filter((message) => message.createTime >= earliest)
    .slice(-maxMessages);
}

export function appendAndGetChatContext(event: NormalizedMessageEvent): ChatContext {
  if (!event.chatId) {
    return { chatId: "", messages: [] };
  }

  const context = getChatContext(event.chatId);
  if (event.text.trim()) {
    const message: ChatContextMessage = {
      messageId: event.messageId,
      senderId: event.senderId,
      senderName: event.senderName,
      text: event.text.trim(),
      mentions: event.mentions || [],
      createTime: event.createTime || Date.now(),
    };
    context.messages.push(message);
  }
  pruneChatContext(context);
  return context;
}
