import { PrimaryDomain } from "../llm/schemas";

export type TopicKind = Exclude<PrimaryDomain, "ignore" | "smalltalk"> | "smalltalk";
export type TopicStatus = "observing" | "proposed" | "confirming" | "committed" | "updating" | "closed";

export interface TopicSummary {
  id: string;
  chatId: string;
  kind: TopicKind;
  status: TopicStatus;
  title: string;
  updatedAt: number;
}

const topics = new Map<string, TopicSummary[]>();

export function listActiveTopics(chatId?: string) {
  if (!chatId) {
    return [];
  }
  const now = Date.now();
  const active = (topics.get(chatId) || []).filter(
    (topic) => topic.status !== "closed" && now - topic.updatedAt <= 24 * 60 * 60_000,
  );
  topics.set(chatId, active);
  return active;
}

export function upsertTopic(topic: TopicSummary) {
  const active = listActiveTopics(topic.chatId).filter((item) => item.id !== topic.id);
  active.push(topic);
  topics.set(topic.chatId, active.slice(-20));
  return topic;
}
