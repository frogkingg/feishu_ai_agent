import { MeetingExtractionResult, TopicMatchResult, TopicMatchResultSchema } from "../schemas";
import { MeetingRow, Repositories } from "../services/store/repositories";

const CoreTopicSignals = [
  "无人机",
  "操作方案",
  "操作流程",
  "试飞权限",
  "权限确认",
  "权限审批",
  "风险控制",
  "风险清单",
  "操作员访谈",
  "统一操作 SOP",
  "SOP",
  "无人机安全规范",
  "试飞",
  "审批"
];

const ExplicitKnowledgeBaseIntentPhrases = [
  "整理成知识库",
  "建成知识库",
  "建一个知识库",
  "整理成资料库",
  "整理成调研档案",
  "归档到知识库",
  "把这几次会议整理起来",
  "把两次访谈整理成一个知识库"
];

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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function meetingTopicText(meeting: MeetingRow): string {
  return [meeting.title, meeting.summary ?? "", meeting.transcript_text, parseStringArray(meeting.keywords_json).join(" ")].join(" ");
}

function extractionText(extraction: MeetingExtractionResult): string {
  return [
    extraction.meeting_summary,
    extraction.topic_keywords.join(" "),
    extraction.key_decisions.map((decision) => `${decision.decision} ${decision.evidence}`).join(" "),
    extraction.action_items.map((item) => `${item.title} ${item.description ?? ""} ${item.evidence}`).join(" "),
    extraction.risks.map((risk) => `${risk.risk} ${risk.evidence}`).join(" "),
    extraction.source_mentions.map((source) => `${source.name_or_keyword} ${source.reason}`).join(" ")
  ].join(" ");
}

function topicSignals(text: string, keywords: string[] = []): string[] {
  const signals = new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean));
  for (const signal of CoreTopicSignals) {
    if (text.includes(signal)) {
      signals.add(signal);
    }
  }
  return [...signals];
}

function hasTopicContent(meeting: MeetingRow): boolean {
  const keywords = parseStringArray(meeting.keywords_json);
  return [meeting.transcript_text, meeting.summary ?? "", keywords.join(" ")].some((value) => value.trim().length > 0);
}

function hasExplicitKnowledgeBaseIntent(text: string): boolean {
  if (ExplicitKnowledgeBaseIntentPhrases.some((phrase) => text.includes(phrase))) {
    return true;
  }

  return (
    /整理成.*知识库/.test(text) ||
    /建.*知识库/.test(text) ||
    /归档.*知识库/.test(text) ||
    /把这几次会议.*整理/.test(text) ||
    /把这两次访谈.*整理.*知识库/.test(text) ||
    /把两次访谈.*整理.*知识库/.test(text)
  );
}

function hasCoreDroneTopic(currentText: string, candidateText: string): boolean {
  const combined = `${currentText} ${candidateText}`;
  const relatedSignals = [
    "操作方案",
    "操作流程",
    "试飞权限",
    "权限确认",
    "权限审批",
    "风险控制",
    "风险清单",
    "SOP",
    "操作员访谈"
  ];
  const overlap = relatedSignals.filter((signal) => currentText.includes(signal) && candidateText.includes(signal)).length;
  return combined.includes("无人机") && overlap >= 2;
}

function candidateMeetingIds(
  scored: { meeting: MeetingRow; score: number }[],
  currentMeetingId: string,
  minimumScore = 0.6
): string[] {
  return unique([
    ...scored.filter((item) => item.score >= minimumScore).map((item) => item.meeting.id),
    currentMeetingId
  ]);
}

export async function runTopicClusteringAgent(input: {
  repos: Repositories;
  meeting: MeetingRow;
  extraction: MeetingExtractionResult;
}): Promise<TopicMatchResult> {
  const meetings = input.repos.listMeetings();
  const currentText = [meetingTopicText(input.meeting), extractionText(input.extraction)].join(" ");
  const explicitKnowledgeBaseIntent = hasExplicitKnowledgeBaseIntent(currentText);
  const candidates = meetings.filter(
    (meeting) => meeting.id !== input.meeting.id && meeting.archive_status !== "rejected" && hasTopicContent(meeting)
  );
  const participants = parseStringArray(input.meeting.participants_json);
  const sourceNames = sourceMentionNames(input.extraction);
  const currentSignals = topicSignals(currentText, input.extraction.topic_keywords);

  const scored = candidates
    .map((candidate) => {
      const candidateText = meetingTopicText(candidate);
      const candidateKeywords = parseStringArray(candidate.keywords_json);
      const candidateSignals = topicSignals(candidateText, candidateKeywords);
      const titleScore = keywordTitleScore(currentSignals, input.meeting.title, candidate.title);
      const keywordScore = overlapRatio(input.extraction.topic_keywords, candidateKeywords);
      const signalScore = overlapRatio(currentSignals, candidateSignals);
      const participantScore = overlapRatio(participants, parseStringArray(candidate.participants_json));
      const sourceScore = sourceMentionScore(sourceNames, candidate.transcript_text);
      const weighted =
        titleScore * 0.2 +
        keywordScore * 0.35 +
        signalScore * 0.3 +
        participantScore * 0.1 +
        sourceScore * 0.05;
      const score = hasCoreDroneTopic(currentText, candidateText) ? Math.max(0.82, weighted) : weighted;

      return {
        meeting: candidate,
        score: Number(score.toFixed(2)),
        reasons: [
          titleScore > 0 ? "标题关键词重叠" : null,
          keywordScore > 0 ? `主题关键词重叠 ${Math.round(keywordScore * 100)}%` : null,
          signalScore >= 0.5 ? "会议摘要/转写围绕相同主题信号" : null,
          participantScore > 0 ? `参会人重叠 ${Math.round(participantScore * 100)}%` : null,
          sourceScore > 0 ? "资料引用重叠" : null,
          hasCoreDroneTopic(currentText, candidateText)
            ? "两场会议均围绕无人机操作方案、操作流程、试飞权限和风险控制"
            : null
        ].filter((reason): reason is string => reason !== null)
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const relatedCandidateIds = candidateMeetingIds(scored, input.meeting.id);
  const strongCandidateIds = candidateMeetingIds(scored, input.meeting.id, 0.78);

  if (explicitKnowledgeBaseIntent) {
    const hasRelatedHistoricalCandidate = relatedCandidateIds.length >= 2;
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: null,
      matched_kb_name: null,
      score: Math.max(0.9, best?.score ?? 0.9),
      match_reasons: [
        "当前会议显式提出整理成知识库",
        hasRelatedHistoricalCandidate ? "历史中存在至少一场相关会议" : "用户显式提出创建知识库",
        ...(best?.reasons ?? [])
      ],
      suggested_action: "ask_create",
      candidate_meeting_ids: hasRelatedHistoricalCandidate ? relatedCandidateIds : [input.meeting.id]
    });
  }

  if (best && best.score >= 0.78 && strongCandidateIds.length >= 2) {
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: null,
      matched_kb_name: null,
      score: best.score,
      match_reasons: best.reasons,
      suggested_action: "ask_create",
      candidate_meeting_ids: strongCandidateIds
    });
  }

  if (best && best.score >= 0.6) {
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: null,
      matched_kb_name: null,
      score: best.score,
      match_reasons: best.reasons.length > 0 ? best.reasons : ["发现历史会议弱相关，继续观察"],
      suggested_action: "observe",
      candidate_meeting_ids: relatedCandidateIds
    });
  }

  if (input.extraction.topic_keywords.length > 0 || currentText.includes("无人机")) {
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
