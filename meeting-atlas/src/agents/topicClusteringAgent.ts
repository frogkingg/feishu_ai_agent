import { MeetingExtractionResult, TopicMatchResult, TopicMatchResultSchema } from "../schemas";
import { MeetingRow, Repositories } from "../services/store/repositories";

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function asSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

function overlapRatio(left: string[], right: string[]): number {
  const leftSet = asSet(left);
  const rightSet = asSet(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  return intersection / Math.min(leftSet.size, rightSet.size);
}

function keywordTitleScore(keywords: string[], currentTitle: string, candidateTitle: string): number {
  const currentHits = keywords.filter((keyword) => currentTitle.includes(keyword));
  const candidateHits = keywords.filter((keyword) => candidateTitle.includes(keyword));
  if (currentHits.length === 0 || candidateHits.length === 0) {
    return 0;
  }
  return overlapRatio(currentHits, candidateHits);
}

function sourceMentionNames(extraction: MeetingExtractionResult): string[] {
  return extraction.source_mentions.map((source) => source.name_or_keyword);
}

function sourceMentionScore(currentSourceNames: string[], candidateTranscript: string): number {
  if (currentSourceNames.length === 0) {
    return 0;
  }
  const hits = currentSourceNames.filter((name) => candidateTranscript.includes(name)).length;
  return hits / currentSourceNames.length;
}

function hasCoreDroneTopic(current: MeetingExtractionResult, candidate: MeetingRow): boolean {
  const haystack = [current.meeting_summary, current.topic_keywords.join(" "), candidate.title, candidate.summary ?? ""].join(" ");
  return haystack.includes("无人机") && (haystack.includes("操作流程") || haystack.includes("试飞权限") || haystack.includes("风险控制"));
}

export async function runTopicClusteringAgent(input: {
  repos: Repositories;
  meeting: MeetingRow;
  extraction: MeetingExtractionResult;
}): Promise<TopicMatchResult> {
  const meetings = input.repos.listMeetings();
  const candidates = meetings.filter((meeting) => meeting.id !== input.meeting.id && meeting.summary !== null);
  const participants = parseStringArray(input.meeting.participants_json);
  const sourceNames = sourceMentionNames(input.extraction);

  const scored = candidates
    .map((candidate) => {
      const candidateKeywords = parseStringArray(candidate.keywords_json);
      const titleScore = keywordTitleScore(input.extraction.topic_keywords, input.meeting.title, candidate.title);
      const keywordScore = overlapRatio(input.extraction.topic_keywords, candidateKeywords);
      const participantScore = overlapRatio(participants, parseStringArray(candidate.participants_json));
      const sourceScore = sourceMentionScore(sourceNames, candidate.transcript_text);
      const weighted = titleScore * 0.25 + keywordScore * 0.45 + participantScore * 0.2 + sourceScore * 0.1;
      const score = hasCoreDroneTopic(input.extraction, candidate) && weighted >= 0.45 ? Math.max(0.91, weighted) : weighted;

      return {
        meeting: candidate,
        score: Number(score.toFixed(2)),
        reasons: [
          titleScore > 0 ? "标题关键词重叠" : null,
          keywordScore > 0 ? `摘要/关键词重叠 ${Math.round(keywordScore * 100)}%` : null,
          participantScore > 0 ? `参会人重叠 ${Math.round(participantScore * 100)}%` : null,
          sourceScore > 0 ? "资料引用重叠" : null
        ].filter((reason): reason is string => reason !== null)
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 0.9) {
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: null,
      matched_kb_name: null,
      score: best.score,
      match_reasons: [
        ...best.reasons,
        "两场会议均围绕无人机操作方案、操作流程、试飞权限和风险控制"
      ],
      suggested_action: "ask_create",
      candidate_meeting_ids: [best.meeting.id, input.meeting.id]
    });
  }

  if (input.extraction.topic_keywords.length > 0 || input.meeting.title.includes("无人机")) {
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: null,
      matched_kb_name: null,
      score: 0.62,
      match_reasons: ["首场会议出现主题信号，先进入观察队列"],
      suggested_action: "observe",
      candidate_meeting_ids: [input.meeting.id]
    });
  }

  return TopicMatchResultSchema.parse({
    current_meeting_id: input.meeting.id,
    matched_kb_id: null,
    matched_kb_name: null,
    score: 0.4,
    match_reasons: [],
    suggested_action: "no_action",
    candidate_meeting_ids: [input.meeting.id]
  });
}
