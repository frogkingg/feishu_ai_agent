import { runLarkCli } from "./cli";

export async function replyText(messageId: string, text: string) {
  return runLarkCli(["im", "+messages-reply", "--message-id", messageId, "--text", text]);
}

export async function sendText(chatId: string, text: string) {
  return runLarkCli(["im", "+messages-send", "--chat-id", chatId, "--text", text]);
}
