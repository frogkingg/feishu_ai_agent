import { MeetingExtractionResult, TopicMatchResult, TopicMatchResultSchema } from "../schemas";
import { KnowledgeBaseRow, MeetingRow, Repositories } from "../services/store/repositories";

const ExplicitKnowledgeBaseIntentPhrases = [
  "整理成知识库",
  "做成知识库",
  "建知识库",
  "建立知识库",
  "创建知识库",
  "新建知识库",
  "建成知识库",
  "建一个知识库",
  "搭建知识库",
  "建设知识库",
  "归档到知识库",
  "归档知识库",
  "沉淀到知识库",
  "把这几次会议整理成知识库",
  "把两次访谈整理成一个知识库",
  "把这两次访谈整理成一个知识库"
];

const GenericTopicSignals = new Set([
  "会议",
  "评审",
  "评审会",
  "同步",
  "同步会",
  "沟通",
  "沟通会",
  "访谈",
  "复盘",
  "冲刺",
  "入口",
  "知识库",
  "待办",
  "确认",
  "事项",
  "问题",
  "记录",
  "任务",
  "后续",
  "本次",
  "当前",
  "今天",
  "下次"
]);

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

function keywordTitleScore(
  keywords: string[],
  currentTitle: string,
  candidateTitle: string
): number {
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
  return [
    meeting.title,
    meeting.summary ?? "",
    meeting.transcript_text,
    parseStringArray(meeting.keywords_json).join(" ")
  ].join(" ");
}

function sourceMeetingIntentText(meeting: MeetingRow): string {
  return [meeting.title, meeting.transcript_text].join(" ");
}

function extractionTopicText(extraction: MeetingExtractionResult): string {
  return [
    extraction.meeting_summary,
    extraction.topic_keywords.join(" "),
    extraction.key_decisions
      .map((decision) => `${decision.decision} ${decision.evidence}`)
      .join(" "),
    extraction.risks.map((risk) => `${risk.risk} ${risk.evidence}`).join(" ")
  ].join(" ");
}

function titleSignals(title: string): string[] {
  const compact = title.replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, "");
  const signals: string[] = [];
  for (let size = 3; size <= 6; size += 1) {
    for (let index = 0; index + size <= compact.length; index += 1) {
      signals.push(compact.slice(index, index + size));
    }
  }
  return signals.filter((signal) => !isGenericTopicSignal(signal));
}

function isGenericTopicSignal(signal: string): boolean {
  const normalized = signal.trim();
  return (
    normalized.length < 2 ||
    GenericTopicSignals.has(normalized) ||
    [...GenericTopicSignals].some((generic) => normalized === `${generic}会`)
  );
}

function topicSignals(text: string, keywords: string[] = [], title = ""): string[] {
  const signals = new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean));
  for (const signal of titleSignals(title)) {
    signals.add(signal);
  }
  return [...signals].filter((signal) => text.includes(signal) || title.includes(signal));
}

function hasTopicContent(meeting: MeetingRow): boolean {
  const keywords = parseStringArray(meeting.keywords_json);
  return [meeting.transcript_text, meeting.summary ?? "", keywords.join(" ")].some(
    (value) => value.trim().length > 0
  );
}

function hasExplicitKnowledgeBaseIntent(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (ExplicitKnowledgeBaseIntentPhrases.some((phrase) => compact.includes(phrase))) {
    return true;
  }

  const patterns = [
    /(?:整理|创建|新建|建立|搭建|建设|归档|沉淀|做成).{0,20}知识库/,
    /知识库.{0,12}(?:创建|新建|建立|搭建|建设|归档|沉淀)/,
    /把.{0,20}(?:会议|访谈|材料|内容).{0,20}(?:整理|归档|沉淀).{0,20}知识库/
  ];
  return patterns.some((pattern) => pattern.test(compact));
}

function distinctiveSignals(signals: string[]): string[] {
  return unique(signals.filter((signal) => !isGenericTopicSignal(signal)));
}

function sharedDistinctiveSignals(left: string[], right: string[]): string[] {
  const rightSet = asSet(distinctiveSignals(right));
  return distinctiveSignals(left).filter((signal) => rightSet.has(signal));
}

function hasStrongSharedTopicSignature(left: string[], right: string[]): boolean {
  return sharedDistinctiveSignals(left, right).length >= 2;
}

function hasNonGenericTopicSignal(extraction: MeetingExtractionResult): boolean {
  return distinctiveSignals(extraction.topic_keywords).length > 0;
}

function parseKnowledgeBaseMeetingIds(knowledgeBase: KnowledgeBaseRow): string[] {
  return parseStringArray(knowledgeBase.created_from_meetings_json);
}

function knowledgeBaseTopicText(input: {
  knowledgeBase: KnowledgeBaseRow;
  meetingsById: Map<string, MeetingRow>;
}): string {
  const createdFromMeetings = parseKnowledgeBaseMeetingIds(input.knowledgeBase)
    .map((meetingId) => input.meetingsById.get(meetingId))
    .filter((meeting): meeting is MeetingRow => meeting !== undefined);

  return [
    input.knowledgeBase.name,
    input.knowledgeBase.goal ?? "",
    input.knowledgeBase.description ?? "",
    parseStringArray(input.knowledgeBase.related_keywords_json).join(" "),
    ...createdFromMeetings.map(meetingTopicText)
  ].join(" ");
}

function knowledgeBaseMatchCandidates(input: {
  knowledgeBases: KnowledgeBaseRow[];
  meetingsById: Map<string, MeetingRow>;
  currentSignals: string[];
  extractionKeywords: string[];
  currentTitle: string;
}): Array<{ knowledgeBase: KnowledgeBaseRow; score: number; reasons: string[] }> {
  return input.knowledgeBases
    .filter((knowledgeBase) => ["active", "candidate"].includes(knowledgeBase.status))
    .map((knowledgeBase) => {
      const kbKeywords = parseStringArray(knowledgeBase.related_keywords_json);
      const kbText = knowledgeBaseTopicText({
        knowledgeBase,
        meetingsById: input.meetingsById
      });
      const kbSignals = topicSignals(kbText, kbKeywords, knowledgeBase.name);
      const titleScore = keywordTitleScore(
        input.currentSignals,
        input.currentTitle,
        knowledgeBase.name
      );
      const keywordScore = overlapRatio(input.extractionKeywords, kbKeywords);
      const signalScore = overlapRatio(input.currentSignals, kbSignals);
      const sourceMeetingIds = parseKnowledgeBaseMeetingIds(knowledgeBase);
      const sourceMeetings = sourceMeetingIds
        .map((meetingId) => input.meetingsById.get(meetingId))
        .filter((meeting): meeting is MeetingRow => meeting !== undefined);
      const sourceMeetingScore =
        sourceMeetings.length === 0
          ? 0
          : Math.max(
              ...sourceMeetings.map((meeting) => {
                const meetingSignals = topicSignals(
                  meetingTopicText(meeting),
                  parseStringArray(meeting.keywords_json),
                  meeting.title
                );
                return overlapRatio(input.currentSignals, meetingSignals);
              })
            );
      const weighted =
        titleScore * 0.25 + keywordScore * 0.35 + signalScore * 0.3 + sourceMeetingScore * 0.1;
      const strongSharedTopic = hasStrongSharedTopicSignature(input.currentSignals, kbSignals);
      const score = strongSharedTopic ? Math.max(0.84, weighted) : weighted;

      return {
        knowledgeBase,
        score: Number(score.toFixed(2)),
        reasons: [
          knowledgeBase.status === "active"
            ? "命中已有 active 知识库"
            : "命中已有 candidate 知识库",
          titleScore > 0 ? "知识库名称与当前会议主题重叠" : null,
          keywordScore > 0 ? `知识库关键词重叠 ${Math.round(keywordScore * 100)}%` : null,
          signalScore >= 0.5 ? "知识库历史会议与当前会议围绕相同主题信号" : null,
          sourceMeetingScore >= 0.5 ? "已归档会议与当前会议强相关" : null,
          strongSharedTopic
            ? `存在多个非通用主题信号重叠：${sharedDistinctiveSignals(
                input.currentSignals,
                kbSignals
              )
                .slice(0, 5)
                .join("、")}`
            : null
        ].filter((reason): reason is string => reason !== null)
      };
    })
    .sort((a, b) => b.score - a.score);
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
  const meetingsById = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  const currentText = [meetingTopicText(input.meeting), extractionTopicText(input.extraction)].join(
    " "
  );
  const explicitKnowledgeBaseIntent = hasExplicitKnowledgeBaseIntent(
    sourceMeetingIntentText(input.meeting)
  );
  const candidates = meetings.filter(
    (meeting) =>
      meeting.id !== input.meeting.id &&
      meeting.archive_status !== "rejected" &&
      hasTopicContent(meeting)
  );
  const participants = parseStringArray(input.meeting.participants_json);
  const sourceNames = sourceMentionNames(input.extraction);
  const currentSignals = topicSignals(
    currentText,
    input.extraction.topic_keywords,
    input.meeting.title
  );
  const matchedKnowledgeBase = knowledgeBaseMatchCandidates({
    knowledgeBases: input.repos.listKnowledgeBases(),
    meetingsById,
    currentSignals,
    extractionKeywords: input.extraction.topic_keywords,
    currentTitle: input.meeting.title
  })[0];

  if (matchedKnowledgeBase && matchedKnowledgeBase.score >= 0.78) {
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: matchedKnowledgeBase.knowledgeBase.id,
      matched_kb_name: matchedKnowledgeBase.knowledgeBase.name,
      score: matchedKnowledgeBase.score,
      match_reasons: ["发现当前会议可能属于已有知识库", ...matchedKnowledgeBase.reasons],
      suggested_action: "ask_append",
      candidate_meeting_ids: unique([
        ...parseKnowledgeBaseMeetingIds(matchedKnowledgeBase.knowledgeBase),
        input.meeting.id
      ])
    });
  }

  const scored = candidates
    .map((candidate) => {
      const candidateText = meetingTopicText(candidate);
      const candidateKeywords = parseStringArray(candidate.keywords_json);
      const candidateSignals = topicSignals(candidateText, candidateKeywords, candidate.title);
      const titleScore = keywordTitleScore(currentSignals, input.meeting.title, candidate.title);
      const keywordScore = overlapRatio(input.extraction.topic_keywords, candidateKeywords);
      const signalScore = overlapRatio(currentSignals, candidateSignals);
      const participantScore = overlapRatio(
        participants,
        parseStringArray(candidate.participants_json)
      );
      const sourceScore = sourceMentionScore(sourceNames, candidate.transcript_text);
      const weighted =
        titleScore * 0.2 +
        keywordScore * 0.35 +
        signalScore * 0.3 +
        participantScore * 0.1 +
        sourceScore * 0.05;
      const strongSharedTopic = hasStrongSharedTopicSignature(currentSignals, candidateSignals);
      const score = strongSharedTopic ? Math.max(0.82, weighted) : weighted;

      return {
        meeting: candidate,
        score: Number(score.toFixed(2)),
        reasons: [
          titleScore > 0 ? "标题关键词重叠" : null,
          keywordScore > 0 ? `主题关键词重叠 ${Math.round(keywordScore * 100)}%` : null,
          signalScore >= 0.5 ? "会议摘要/转写围绕相同主题信号" : null,
          participantScore > 0 ? `参会人重叠 ${Math.round(participantScore * 100)}%` : null,
          sourceScore > 0 ? "资料引用重叠" : null,
          strongSharedTopic
            ? `存在多个非通用主题信号重叠：${sharedDistinctiveSignals(
                currentSignals,
                candidateSignals
              )
                .slice(0, 5)
                .join("、")}`
            : null
        ].filter((reason): reason is string => reason !== null)
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const relatedCandidateIds = candidateMeetingIds(scored, input.meeting.id);
  const strongHistoricalCandidateIds = scored
    .filter((item) => item.score >= 0.78)
    .map((item) => item.meeting.id);
  const strongCandidateIds = unique([...strongHistoricalCandidateIds, input.meeting.id]);

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
      candidate_meeting_ids: hasRelatedHistoricalCandidate
        ? relatedCandidateIds
        : [input.meeting.id]
    });
  }

  if (best && best.score >= 0.78 && strongHistoricalCandidateIds.length >= 1) {
    return TopicMatchResultSchema.parse({
      current_meeting_id: input.meeting.id,
      matched_kb_id: null,
      matched_kb_name: null,
      score: best.score,
      match_reasons: ["发现至少一场强相关历史会议", ...best.reasons],
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

  if (hasNonGenericTopicSignal(input.extraction)) {
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
