import { z } from "zod";
import { MeetingExtractionResult } from "../schemas";
import { LlmClient } from "../services/llm/llmClient";
import { MeetingRow, Repositories } from "../services/store/repositories";
import { readPrompt } from "../utils/prompts";

export type ExtractionResult = MeetingExtractionResult;

const NullableTextSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().trim().min(1).nullable());

export const SourceDraftSchema = z.object({
  title: z.string().trim().min(1),
  url: NullableTextSchema,
  source_type: z.string().trim().min(1),
  kb_id: NullableTextSchema,
  reason: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
  confidence: z.number().min(0).max(1)
});

export const SourceRetrievalResultSchema = z.object({
  sources: z.array(SourceDraftSchema),
  should_prompt_archival: z.boolean()
});

export type SourceDraft = z.infer<typeof SourceDraftSchema>;
export type SourceRetrievalResult = z.infer<typeof SourceRetrievalResultSchema>;

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function sourceRetrievalContext(input: {
  repos: Repositories;
  meeting: MeetingRow;
  extraction: ExtractionResult;
}) {
  return {
    current_meeting: {
      id: input.meeting.id,
      title: input.meeting.title,
      started_at: input.meeting.started_at,
      organizer: input.meeting.organizer,
      summary: input.extraction.meeting_summary,
      topic_keywords: input.extraction.topic_keywords
    },
    extracted_action_items: input.extraction.action_items.map((item) => ({
      title: item.title,
      description: item.description,
      evidence: item.evidence,
      suggested_reason: item.suggested_reason
    })),
    extracted_decisions: input.extraction.key_decisions.map((decision) => ({
      decision: decision.decision,
      evidence: decision.evidence
    })),
    extracted_source_mentions: input.extraction.source_mentions,
    existing_knowledge_bases: input.repos.listKnowledgeBases().map((knowledgeBase) => ({
      id: knowledgeBase.id,
      name: knowledgeBase.name,
      goal: knowledgeBase.goal,
      description: knowledgeBase.description,
      related_keywords: parseStringArray(knowledgeBase.related_keywords_json)
    }))
  };
}

export async function runSourceRetrievalAgent(input: {
  repos: Repositories;
  meeting: MeetingRow;
  extraction: ExtractionResult;
  llm: LlmClient;
}): Promise<SourceRetrievalResult> {
  const raw = await input.llm.generateJson<unknown>({
    schemaName: "SourceRetrievalResult",
    systemPrompt: readPrompt("sourceRetrieval.md"),
    userPrompt: [
      "请根据下面的 source_retrieval_context 输出 SourceRetrievalResult JSON。",
      "代码不会用关键词数组或正则替你判断资料是否值得归档；你必须根据会议语义、资料具体性和知识库相关性判断。",
      "source_retrieval_context:",
      JSON.stringify(sourceRetrievalContext(input), null, 2)
    ].join("\n\n")
  });

  return SourceRetrievalResultSchema.parse(raw);
}
