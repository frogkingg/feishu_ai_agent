import { z } from "zod";
import { LlmClient } from "../services/llm/llmClient";
import { MeetingRow, Repositories } from "../services/store/repositories";
import { readPrompt } from "../utils/prompts";

const QaResultSchema = z.object({
  answer: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  sources: z.array(z.string().trim().min(1))
});

export type QaResult = z.infer<typeof QaResultSchema>;

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

function uniqueMeetings(meetings: MeetingRow[]): MeetingRow[] {
  const seen = new Set<string>();
  return meetings.filter((meeting) => {
    if (seen.has(meeting.id)) {
      return false;
    }
    seen.add(meeting.id);
    return true;
  });
}

function listMeetingsByKbId(input: { repos: Repositories; kbId: string }): MeetingRow[] {
  const knowledgeBase = input.repos.getKnowledgeBase(input.kbId);
  const linkedMeetingIds =
    knowledgeBase === null ? [] : parseStringArray(knowledgeBase.created_from_meetings_json);
  const linkedMeetingIdSet = new Set(linkedMeetingIds);

  return uniqueMeetings(
    input.repos
      .listMeetings()
      .filter(
        (meeting) => meeting.matched_kb_id === input.kbId || linkedMeetingIdSet.has(meeting.id)
      )
  );
}

function qaContext(input: { repos: Repositories; kbId: string }) {
  const knowledgeBase = input.repos.getKnowledgeBase(input.kbId);
  const meetings = listMeetingsByKbId(input);
  const meetingIds = new Set(meetings.map((meeting) => meeting.id));
  const actionItems = input.repos
    .listActionItems()
    .filter((item) => item.kb_id === input.kbId || meetingIds.has(item.meeting_id));

  return {
    knowledge_base:
      knowledgeBase === null
        ? null
        : {
            id: knowledgeBase.id,
            name: knowledgeBase.name,
            goal: knowledgeBase.goal,
            description: knowledgeBase.description,
            related_keywords: parseStringArray(knowledgeBase.related_keywords_json)
          },
    meetings: meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      started_at: meeting.started_at,
      organizer: meeting.organizer,
      summary: meeting.summary,
      minutes_url: meeting.minutes_url,
      transcript_url: meeting.transcript_url,
      action_items: actionItems
        .filter((item) => item.meeting_id === meeting.id)
        .map((item) => ({
          title: item.title,
          description: item.description,
          owner: item.owner,
          collaborators: parseStringArray(item.collaborators_json),
          due_date: item.due_date,
          priority: item.priority,
          evidence: item.evidence,
          suggested_reason: item.suggested_reason,
          confirmation_status: item.confirmation_status
        })),
      persisted_decisions: []
    }))
  };
}

export async function runQaAgent(input: {
  repos: Repositories;
  kbId: string;
  question: string;
  llm: LlmClient;
}): Promise<QaResult> {
  const raw = await input.llm.generateJson<unknown>({
    schemaName: "QaResult",
    systemPrompt: readPrompt("qa.md"),
    userPrompt: [
      `kb_id: ${input.kbId}`,
      `question: ${input.question}`,
      "kb_qa_context:",
      JSON.stringify(qaContext(input), null, 2)
    ].join("\n\n")
  });

  return QaResultSchema.parse(raw);
}
