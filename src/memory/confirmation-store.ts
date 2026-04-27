import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { CONFIRMATION_STORE_PATH, CONFIRMATION_TTL_MS, RUNTIME_DIR } from "../config/constants";
import { ConfirmationActionType, GroundingEvidence, PendingConfirmation } from "../llm/schemas";
import { createId } from "./project-store";

interface ConfirmationStoreFile {
  version: 1;
  confirmations: PendingConfirmation[];
}

export interface CreatePendingConfirmationInput {
  chatId: string;
  requesterId: string;
  actionType: ConfirmationActionType;
  projectId?: string;
  payload: unknown;
  evidence: GroundingEvidence;
  expiresAt?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(confirmation: PendingConfirmation, now = Date.now()) {
  return new Date(confirmation.expiresAt).getTime() <= now;
}

function emptyStore(): ConfirmationStoreFile {
  return { version: 1, confirmations: [] };
}

export function loadConfirmationStore(): ConfirmationStoreFile {
  if (!existsSync(CONFIRMATION_STORE_PATH)) {
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(readFileSync(CONFIRMATION_STORE_PATH, "utf8")) as Partial<ConfirmationStoreFile>;
    return {
      version: 1,
      confirmations: Array.isArray(parsed.confirmations) ? (parsed.confirmations as PendingConfirmation[]) : [],
    };
  } catch {
    return emptyStore();
  }
}

export function saveConfirmationStore(store: ConfirmationStoreFile) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(CONFIRMATION_STORE_PATH, JSON.stringify({ version: 1, confirmations: store.confirmations }, null, 2), "utf8");
}

export function expireOldConfirmations() {
  const store = loadConfirmationStore();
  let changed = false;
  const now = Date.now();
  for (const confirmation of store.confirmations) {
    if (confirmation.status === "pending" && isExpired(confirmation, now)) {
      confirmation.status = "expired";
      changed = true;
    }
  }
  if (changed) {
    saveConfirmationStore(store);
  }
  return store;
}

export function createPendingConfirmation(input: CreatePendingConfirmationInput): PendingConfirmation {
  const store = expireOldConfirmations();
  const createdAt = nowIso();
  const confirmation: PendingConfirmation = {
    id: createId("confirm"),
    chatId: input.chatId,
    requesterId: input.requesterId,
    actionType: input.actionType,
    projectId: input.projectId,
    payload: input.payload,
    evidence: input.evidence,
    status: "pending",
    createdAt,
    expiresAt: input.expiresAt || new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
  };

  store.confirmations.push(confirmation);
  saveConfirmationStore(store);
  return confirmation;
}

export function getLatestPendingConfirmation(chatId?: string, requesterId?: string): PendingConfirmation | undefined {
  if (!chatId) {
    return undefined;
  }

  const store = expireOldConfirmations();
  return store.confirmations
    .filter(
      (confirmation) =>
        confirmation.chatId === chatId &&
        confirmation.status === "pending" &&
        !isExpired(confirmation) &&
        (!requesterId || confirmation.requesterId === requesterId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function matchesConfirmText(text: string) {
  return /(^|\s|[，,。！!])(?:确认|可以|记一下|记录|就这样|保存|没问题|OK|ok|好的)(?:\s|[，,。！!]|$)/.test(
    text.trim(),
  );
}

export function matchesCancelText(text: string) {
  return /(?:取消|先别|不用|算了|不记|不要记录)/.test(text.trim());
}

function updateLatestPending(
  chatId: string,
  text: string,
  status: PendingConfirmation["status"],
  requesterId?: string,
): PendingConfirmation | undefined {
  const matcher = status === "confirmed" ? matchesConfirmText : matchesCancelText;
  if (!matcher(text)) {
    return undefined;
  }

  const store = expireOldConfirmations();
  const pending = store.confirmations
    .filter(
      (confirmation) =>
        confirmation.chatId === chatId &&
        confirmation.status === "pending" &&
        !isExpired(confirmation) &&
        (!requesterId || confirmation.requesterId === requesterId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!pending) {
    return undefined;
  }

  pending.status = status;
  saveConfirmationStore(store);
  return pending;
}

export function confirmPendingConfirmation(chatId: string, text: string, requesterId?: string) {
  return updateLatestPending(chatId, text, "confirmed", requesterId);
}

export function cancelPendingConfirmation(chatId: string, text: string, requesterId?: string) {
  return updateLatestPending(chatId, text, "cancelled", requesterId);
}
