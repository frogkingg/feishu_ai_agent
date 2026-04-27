import { matchesCancelText, matchesConfirmText } from "../memory/confirmation-store";
import { ChatContext, NormalizedMessageEvent, PendingConfirmation } from "../llm/schemas";
import { hasHighValueProjectSignal, isDirectMentionLike, isPrivateChatLike } from "./router";

export interface GateDecision {
  shouldProcess: boolean;
  reason: "mentioned" | "private_chat" | "pending_confirmation" | "high_value_signal" | "ignore";
  allowSilent: boolean;
}

export function decideMessageGate(
  event: NormalizedMessageEvent,
  _context: ChatContext,
  pending?: PendingConfirmation,
): GateDecision {
  const text = event.text.trim();
  if (!text) {
    return { shouldProcess: false, reason: "ignore", allowSilent: true };
  }

  if (isDirectMentionLike(event)) {
    return { shouldProcess: true, reason: "mentioned", allowSilent: false };
  }

  if (isPrivateChatLike(event)) {
    return { shouldProcess: true, reason: "private_chat", allowSilent: false };
  }

  if (pending && (matchesConfirmText(text) || matchesCancelText(text))) {
    return { shouldProcess: true, reason: "pending_confirmation", allowSilent: false };
  }

  if (hasHighValueProjectSignal(text)) {
    return { shouldProcess: true, reason: "high_value_signal", allowSilent: true };
  }

  return { shouldProcess: false, reason: "ignore", allowSilent: true };
}
