import { CONFIRMATION_STORE_PATH, CONFIRMATION_TTL_MS } from "../config/constants";
import { ConfirmationActionType, GroundingEvidence, PendingConfirmation } from "../llm/schemas";
import { readJsonFile, withFileLock, writeJsonFileAtomic } from "./json-file";
import { createId } from "./project-store";

const CONFIRMATION_STORE_LOCK_PATH = `${CONFIRMATION_STORE_PATH}.lock`;

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
  const parsed = readJsonFile<Partial<ConfirmationStoreFile>>(CONFIRMATION_STORE_PATH, emptyStore, "确认状态文件");
  return {
    version: 1,
    confirmations: Array.isArray(parsed.confirmations) ? (parsed.confirmations as PendingConfirmation[]) : [],
  };
}

export function saveConfirmationStore(store: ConfirmationStoreFile) {
  writeJsonFileAtomic(CONFIRMATION_STORE_PATH, { version: 1, confirmations: store.confirmations });
}

function expireOldConfirmationsUnlocked() {
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

export function expireOldConfirmations() {
  return withFileLock(CONFIRMATION_STORE_LOCK_PATH, expireOldConfirmationsUnlocked);
}

export function createPendingConfirmation(input: CreatePendingConfirmationInput): PendingConfirmation {
  return withFileLock(CONFIRMATION_STORE_LOCK_PATH, () => {
    const store = expireOldConfirmationsUnlocked();
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
  });
}

export function getLatestPendingConfirmation(chatId?: string, requesterId?: string): PendingConfirmation | undefined {
  if (!chatId || !requesterId) {
    return undefined;
  }

  const store = expireOldConfirmations();
  return store.confirmations
    .filter(
      (confirmation) =>
        confirmation.chatId === chatId &&
        confirmation.status === "pending" &&
        !isExpired(confirmation) &&
        confirmation.requesterId === requesterId,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function matchesConfirmText(text: string) {
  return /(^|\s|[，,。！!])(?:确认(?:记录|一下)?|可以(?:记录)?|记一下|记录|记下来吧?|好[，,、\s]*记下来|就这样|保存|没问题|OK|ok|好的)(?:\s|[，,。！!]|$)/.test(
    text.trim(),
  );
}

export function matchesCancelText(text: string) {
  return /(?:取消|先别|不用|算了|不记|先不记|暂时别记|不用记|别记录|不要记录)/.test(text.trim());
}

function updateLatestPending(
  chatId: string,
  text: string,
  status: PendingConfirmation["status"],
  requesterId?: string,
): PendingConfirmation | undefined {
  if (!requesterId) {
    return undefined;
  }

  const matcher = status === "confirmed" ? matchesConfirmText : matchesCancelText;
  if (!matcher(text)) {
    return undefined;
  }

  return withFileLock(CONFIRMATION_STORE_LOCK_PATH, () => {
    const store = expireOldConfirmationsUnlocked();
    const pending = store.confirmations
      .filter(
        (confirmation) =>
          confirmation.chatId === chatId &&
          confirmation.status === "pending" &&
          !isExpired(confirmation) &&
          confirmation.requesterId === requesterId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!pending) {
      return undefined;
    }

    pending.status = status;
    saveConfirmationStore(store);
    return pending;
  });
}

export function confirmPendingConfirmation(chatId: string, text: string, requesterId?: string) {
  return updateLatestPending(chatId, text, "confirmed", requesterId);
}

export function cancelPendingConfirmation(chatId: string, text: string, requesterId?: string) {
  return updateLatestPending(chatId, text, "cancelled", requesterId);
}
