import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ActionItemDraft,
  CalendarEventDraft,
  DateOnlySchema,
  DecisionDraft,
  IsoDateTimeSchema,
  MeetingExtractionResult,
  MeetingExtractionResultSchema,
  ManualMeetingInput,
  RiskDraft
} from "../src/schemas";
import { loadConfig } from "../src/config";
import { createLlmClient } from "../src/services/llm/createLlmClient";
import { LlmClient } from "../src/services/llm/llmClient";
import { createMemoryDatabase } from "../src/services/store/db";
import {
  ActionItemRow,
  CalendarDraftRow,
  ConfirmationRequestRow,
  createRepositories
} from "../src/services/store/repositories";
import { processMeetingWorkflow } from "../src/workflows/processMeetingWorkflow";

const DEFAULT_MANIFEST_PATH = join(process.cwd(), "evaluation/fixtures/manifest.json");
const DEFAULT_OUTPUT_DIR = join(process.cwd(), "evaluation-output");
const DEFAULT_JSON_REPORT_NAME = "evaluation-latest.json";
const DEFAULT_MARKDOWN_REPORT_NAME = "evaluation-report.md";
export type EvaluationLlmProvider = "mock" | "openai-compatible";
const RequiredScenarioSchema = z.enum([
  "explicit_action_owner_due",
  "explicit_calendar",
  "deadline_not_calendar",
  "ambiguous_no_task",
  "related_meetings_create_kb",
  "unrelated_meetings_no_create_kb",
  "decision_without_action",
  "risk_without_owner"
]);
export type RequiredScenario = z.infer<typeof RequiredScenarioSchema>;
export const REQUIRED_SCENARIOS: RequiredScenario[] = [...RequiredScenarioSchema.options];
const ScenarioDescriptions: Record<RequiredScenario, string> = {
  explicit_action_owner_due: "明确待办 + 明确负责人 + 明确截止时间",
  explicit_calendar: "明确日程",
  deadline_not_calendar: "只有截止时间但不是日程",
  ambiguous_no_task: "模糊表达，不应该生成任务",
  related_meetings_create_kb: "两场相关会议应触发 create_kb",
  unrelated_meetings_no_create_kb: "两场不相关会议不应触发 create_kb",
  decision_without_action: "有决策但无待办",
  risk_without_owner: "有风险但无明确负责人"
};

const ManifestItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  participants: z.array(z.string()),
  organizer: z.string().nullable(),
  started_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
  meeting_file: z.string().min(1),
  label_file: z.string().min(1),
  extraction_file: z.string().min(1)
});
const ManifestSchema = z.array(ManifestItemSchema).min(1);

const ExpectedActionLabelSchema = z.object({
  title_contains: z.string().min(1),
  owner: z.string().nullable().optional(),
  due_date: DateOnlySchema.nullable().optional()
});

const ExpectedCalendarLabelSchema = z.object({
  title_contains: z.string().min(1),
  start_time: IsoDateTimeSchema.nullable().optional()
});

const ExpectedDecisionLabelSchema = z.object({
  decision_contains: z.string().min(1)
});

const ExpectedRiskLabelSchema = z.object({
  risk_contains: z.string().min(1)
});

const EvaluationLabelSchema = z.object({
  expected_action_items: z.array(ExpectedActionLabelSchema),
  expected_calendar_drafts: z.array(ExpectedCalendarLabelSchema),
  expected_decisions: z.array(ExpectedDecisionLabelSchema),
  expected_risks: z.array(ExpectedRiskLabelSchema),
  expected_topic_keywords: z.array(z.string()),
  expected_should_create_kb: z.boolean(),
  covered_scenarios: z.array(RequiredScenarioSchema),
  notes: z.string().min(1)
});

export type ManifestItem = z.infer<typeof ManifestItemSchema>;
export type EvaluationLabel = z.infer<typeof EvaluationLabelSchema>;
export type ExpectedActionLabel = z.infer<typeof ExpectedActionLabelSchema>;
export type ExpectedCalendarLabel = z.infer<typeof ExpectedCalendarLabelSchema>;
export type ExpectedDecisionLabel = z.infer<typeof ExpectedDecisionLabelSchema>;
export type ExpectedRiskLabel = z.infer<typeof ExpectedRiskLabelSchema>;

export interface EvaluationFixtureSet {
  manifest: ManifestItem[];
  labels: EvaluationLabel[];
  extractions: MeetingExtractionResult[];
  meetingTexts: string[];
}

export interface MatchStats {
  expected: number;
  predicted: number;
  matched: number;
  false_positives: number;
  recall: number;
  precision: number;
}

export interface FieldAccuracyStats {
  expected: number;
  correct: number;
  accuracy: number;
}

export interface SampleEvaluation {
  id: string;
  title: string;
  notes: string;
  topic_action: string;
  expected_should_create_kb: boolean;
  generated_create_kb: boolean;
  kb_route_correct: boolean;
  action_items: MatchStats;
  calendar_drafts: MatchStats;
  action_owner: FieldAccuracyStats;
  action_due_date: FieldAccuracyStats;
  decisions: MatchStats;
  risks: MatchStats;
  topic_keywords: MatchStats;
  covered_scenarios: RequiredScenario[];
  generated_confirmations: number;
  accepted_confirmations: number;
  false_positive_confirmations: number;
  issues: string[];
}

export interface EvaluationMetrics {
  samples: number;
  expected_units: number;
  matched_units: number;
  overall_accuracy: number;
  action_item_recall: number;
  action_item_precision: number;
  action_recall: number;
  action_precision: number;
  owner_accuracy: number;
  due_date_accuracy: number;
  calendar_recall: number;
  calendar_precision: number;
  deadline_vs_calendar_accuracy: number;
  knowledge_base_trigger_accuracy: number;
  decision_recall: number;
  risk_recall: number;
  keyword_recall: number;
  kb_routing_accuracy: number;
  false_positive_count: number;
  generated_confirmations: number;
  accepted_confirmations: number;
  false_positive_confirmations: number;
  confirmation_burden_per_meeting: number;
  agent_runtime_seconds: number;
  manual_meeting_minutes_min: number;
  manual_meeting_minutes_max: number;
  manual_kb_minutes_min: number;
  manual_kb_minutes_max: number;
  manual_total_minutes_min: number;
  manual_total_minutes_max: number;
  user_acceptance_proxy: number;
  manual_minutes_baseline: number;
  agent_minutes_estimate: number;
  minutes_saved_estimate: number;
  minutes_saved_min: number;
  minutes_saved_max: number;
  efficiency_lift: number;
  efficiency_lift_min: number;
  efficiency_lift_max: number;
}

export interface ScenarioCoverage {
  required: RequiredScenario[];
  covered: RequiredScenario[];
  missing: RequiredScenario[];
  by_scenario: Record<RequiredScenario, string[]>;
}

export interface EvaluationRunContext {
  evaluation_type: "mock_fixture_pipeline" | "real_llm_extraction";
  provider: EvaluationLlmProvider;
  model: string | null;
}

const MetricDefinitions: Record<string, string> = {
  action_item_recall: "人工标注 action item 中，标题被生成结果命中的比例。",
  action_item_precision: "生成 action item 中，标题能命中人工标注的比例；这是粗略 precision。",
  owner_accuracy: "带 owner 标注的 action item 中，标题命中且 owner 完全一致的比例。",
  due_date_accuracy: "带 due_date 标注的 action item 中，标题命中且 due date 完全一致的比例。",
  calendar_recall: "人工标注 calendar draft 中，标题和 start_time 被生成结果命中的比例。",
  calendar_precision: "生成 calendar draft 中，能命中人工标注 calendar draft 的比例。",
  deadline_vs_calendar_accuracy:
    "标记为 deadline_not_calendar 的样本中，没有错误生成 calendar draft 的比例。",
  knowledge_base_trigger_accuracy:
    "每条样本的 expected_should_create_kb 与 topic clustering 实际 ask_create 是否一致的比例。",
  false_positive_count: "未命中人工标注的 action/calendar 生成项，加上误触发 create_kb 的数量。",
  confirmation_burden_per_meeting: "平均每场会议生成的 confirmation request 数量。",
  agent_runtime_seconds: "脚本本次评测的实际 wall-clock 运行秒数。",
  efficiency_lift: "使用人工耗时中位数估算：1 - Agent 实际运行分钟 / 人工总耗时中位数。"
};

export interface EffectivenessEvaluationResult {
  status: "passed" | "failed";
  generated_at: string;
  dry_run_only: true;
  llm_provider: EvaluationLlmProvider;
  evaluation_context: EvaluationRunContext;
  manifest_path: string;
  output_dir: string;
  metric_definitions: Record<string, string>;
  metrics: EvaluationMetrics;
  scenario_coverage: ScenarioCoverage;
  samples: SampleEvaluation[];
  report_paths: {
    json: string | null;
    markdown: string | null;
  };
}

export interface RunEffectivenessEvaluationOptions {
  manifestPath?: string;
  outputDir?: string;
  writeOutputs?: boolean;
  generatedAt?: string;
  llmProvider?: EvaluationLlmProvider;
}

class FixtureEvaluationLlmClient implements LlmClient {
  private index = 0;

  constructor(private readonly results: MeetingExtractionResult[]) {}

  async generateJson<T>(input: { schemaName: string }): Promise<T> {
    if (input.schemaName !== "MeetingExtractionResult") {
      throw new Error(`Evaluation fixture LLM does not support schema: ${input.schemaName}`);
    }

    const result = this.results[this.index];
    if (!result) {
      throw new Error("Evaluation fixture LLM has no remaining extraction result");
    }

    this.index += 1;
    return result as T;
  }
}

function readJson<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readEvaluationFixtureSet(
  manifestPath = DEFAULT_MANIFEST_PATH
): EvaluationFixtureSet {
  const manifest = readJson(manifestPath, ManifestSchema);
  return {
    manifest,
    labels: manifest.map((item) => readJson(item.label_file, EvaluationLabelSchema)),
    extractions: manifest.map((item) =>
      readJson(item.extraction_file, MeetingExtractionResultSchema)
    ),
    meetingTexts: manifest.map((item) => readText(item.meeting_file))
  };
}

function parseEvaluationLlmProvider(value: string | undefined): EvaluationLlmProvider {
  if (!value || value === "mock") {
    return "mock";
  }
  if (value === "openai-compatible") {
    return "openai-compatible";
  }
  throw new Error(
    `Unsupported EVALUATION_LLM_PROVIDER: ${value}. Expected mock or openai-compatible.`
  );
}

function createEvaluationLlmClient(input: {
  provider: EvaluationLlmProvider;
  fixtureExtractions: MeetingExtractionResult[];
}): { llm: LlmClient; context: EvaluationRunContext } {
  if (input.provider === "mock") {
    return {
      llm: new FixtureEvaluationLlmClient(input.fixtureExtractions),
      context: {
        evaluation_type: "mock_fixture_pipeline",
        provider: "mock",
        model: "fixture extraction corpus"
      }
    };
  }

  const config = loadConfig({
    llmProvider: "openai-compatible"
  });

  return {
    llm: createLlmClient(config),
    context: {
      evaluation_type: "real_llm_extraction",
      provider: "openai-compatible",
      model: config.llmModel
    }
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 1;
  }
  return numerator / denominator;
}

function includesText(value: string | null, expected: string): boolean {
  return (value ?? "").includes(expected);
}

function matchActionTitle(
  expected: ExpectedActionLabel,
  item: ActionItemDraft | ActionItemRow
): boolean {
  return includesText(item.title, expected.title_contains);
}

function matchAction(
  expected: ExpectedActionLabel,
  item: ActionItemDraft | ActionItemRow
): boolean {
  return (
    includesText(item.title, expected.title_contains) &&
    (expected.owner === undefined || item.owner === expected.owner) &&
    (expected.due_date === undefined || item.due_date === expected.due_date)
  );
}

function matchCalendar(
  expected: ExpectedCalendarLabel,
  item: CalendarEventDraft | CalendarDraftRow
): boolean {
  return (
    includesText(item.title, expected.title_contains) &&
    (expected.start_time === undefined || item.start_time === expected.start_time)
  );
}

function matchDecision(expected: ExpectedDecisionLabel, item: DecisionDraft): boolean {
  return includesText(item.decision, expected.decision_contains);
}

function matchRisk(expected: ExpectedRiskLabel, item: RiskDraft): boolean {
  return includesText(item.risk, expected.risk_contains);
}

function matchKeyword(expected: string, actual: string): boolean {
  return actual.includes(expected) || expected.includes(actual);
}

function countMatches<TExpected, TActual>(
  expected: TExpected[],
  actual: TActual[],
  predicate: (expected: TExpected, actual: TActual) => boolean
): {
  matched: number;
  matchedActualIndexes: Set<number>;
  matchedPairs: Array<{ expectedIndex: number; actualIndex: number }>;
} {
  const used = new Set<number>();
  const matchedPairs: Array<{ expectedIndex: number; actualIndex: number }> = [];
  let matched = 0;

  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const expectedItem = expected[expectedIndex]!;
    const actualIndex = actual.findIndex(
      (actualItem, index) => !used.has(index) && predicate(expectedItem, actualItem)
    );
    if (actualIndex >= 0) {
      used.add(actualIndex);
      matchedPairs.push({ expectedIndex, actualIndex });
      matched += 1;
    }
  }

  return { matched, matchedActualIndexes: used, matchedPairs };
}

export function calculateMatchStats(
  expected: number,
  predicted: number,
  matched: number
): MatchStats {
  return {
    expected,
    predicted,
    matched,
    false_positives: Math.max(predicted - matched, 0),
    recall: ratio(matched, expected),
    precision: ratio(matched, predicted)
  };
}

function actionFieldAccuracy(
  expected: ExpectedActionLabel[],
  actual: ActionItemDraft[],
  matchedPairs: Array<{ expectedIndex: number; actualIndex: number }>,
  field: "owner" | "due_date"
): FieldAccuracyStats {
  const expectedWithField = expected
    .map((label, index) => ({ label, index }))
    .filter(({ label }) => label[field] !== undefined);
  const correct = expectedWithField.filter(({ label, index }) => {
    const pair = matchedPairs.find((item) => item.expectedIndex === index);
    if (!pair) {
      return false;
    }
    return actual[pair.actualIndex]?.[field] === label[field];
  }).length;

  return {
    expected: expectedWithField.length,
    correct,
    accuracy: ratio(correct, expectedWithField.length)
  };
}

function describeMisses(
  sampleId: string,
  label: EvaluationLabel,
  extraction: MeetingExtractionResult,
  stats: Pick<
    SampleEvaluation,
    "action_items" | "calendar_drafts" | "decisions" | "risks" | "topic_keywords"
  >
): string[] {
  const issues: string[] = [];
  if (stats.action_items.matched < stats.action_items.expected) {
    issues.push(`${sampleId}: action item recall missed expected label`);
  }
  if (stats.calendar_drafts.matched < stats.calendar_drafts.expected) {
    issues.push(`${sampleId}: calendar draft recall missed expected label`);
  }
  if (stats.decisions.matched < stats.decisions.expected) {
    issues.push(`${sampleId}: decision recall missed expected label`);
  }
  if (stats.risks.matched < stats.risks.expected) {
    issues.push(`${sampleId}: risk recall missed expected label`);
  }
  if (stats.topic_keywords.matched < stats.topic_keywords.expected) {
    issues.push(`${sampleId}: topic keyword recall missed expected label`);
  }
  if (label.expected_calendar_drafts.length === 0 && extraction.calendar_drafts.length > 0) {
    issues.push(`${sampleId}: generated unexpected calendar draft`);
  }
  if (label.expected_action_items.length === 0 && extraction.action_items.length > 0) {
    issues.push(`${sampleId}: generated unexpected action item`);
  }
  return issues;
}

function confirmationAcceptance(input: {
  confirmations: ConfirmationRequestRow[];
  label: EvaluationLabel;
  actionRows: ActionItemRow[];
  calendarRows: CalendarDraftRow[];
}): { accepted: number; falsePositive: number } {
  let accepted = 0;
  let falsePositive = 0;

  for (const confirmation of input.confirmations) {
    if (confirmation.request_type === "action") {
      const action = input.actionRows.find((row) => row.id === confirmation.target_id);
      const matches = action
        ? input.label.expected_action_items.some((expected) => matchAction(expected, action))
        : false;
      accepted += matches ? 1 : 0;
      falsePositive += matches ? 0 : 1;
    }

    if (confirmation.request_type === "calendar") {
      const calendar = input.calendarRows.find((row) => row.id === confirmation.target_id);
      const matches = calendar
        ? input.label.expected_calendar_drafts.some((expected) => matchCalendar(expected, calendar))
        : false;
      accepted += matches ? 1 : 0;
      falsePositive += matches ? 0 : 1;
    }

    if (confirmation.request_type === "create_kb") {
      accepted += input.label.expected_should_create_kb ? 1 : 0;
      falsePositive += input.label.expected_should_create_kb ? 0 : 1;
    }
  }

  return { accepted, falsePositive };
}

function estimateManualEffort(input: {
  sampleCount: number;
  knowledgeBaseTriggerCount: number;
  agentRuntimeSeconds: number;
}): {
  meetingMin: number;
  meetingMax: number;
  kbMin: number;
  kbMax: number;
  totalMin: number;
  totalMax: number;
  totalMid: number;
  agentMinutes: number;
  savedMin: number;
  savedMax: number;
  savedMid: number;
  liftMin: number;
  liftMax: number;
  liftMid: number;
} {
  const meetingMin = input.sampleCount * 5;
  const meetingMax = input.sampleCount * 10;
  const kbMin = input.knowledgeBaseTriggerCount * 20;
  const kbMax = input.knowledgeBaseTriggerCount * 30;
  const totalMin = meetingMin + kbMin;
  const totalMax = meetingMax + kbMax;
  const totalMid = (totalMin + totalMax) / 2;
  const agentMinutes = input.agentRuntimeSeconds / 60;
  const savedMin = Math.max(totalMin - agentMinutes, 0);
  const savedMax = Math.max(totalMax - agentMinutes, 0);
  const savedMid = Math.max(totalMid - agentMinutes, 0);

  return {
    meetingMin,
    meetingMax,
    kbMin,
    kbMax,
    totalMin,
    totalMax,
    totalMid,
    agentMinutes,
    savedMin,
    savedMax,
    savedMid,
    liftMin: ratio(savedMin, totalMin),
    liftMax: ratio(savedMax, totalMax),
    liftMid: ratio(savedMid, totalMid)
  };
}

export function calculateEvaluationMetrics(
  samples: SampleEvaluation[],
  labels: Array<Pick<EvaluationLabel, "expected_should_create_kb">>,
  agentRuntimeSeconds: number
): EvaluationMetrics {
  const sum = (selector: (sample: SampleEvaluation) => number): number =>
    samples.reduce((total, sample) => total + selector(sample), 0);
  const deadlineSamples = samples.filter((sample) =>
    sample.covered_scenarios.includes("deadline_not_calendar")
  );
  const deadlineCorrect = deadlineSamples.filter(
    (sample) => sample.calendar_drafts.predicted === 0
  ).length;
  const expectedUnits =
    sum((sample) => sample.action_items.expected) +
    sum((sample) => sample.calendar_drafts.expected) +
    sum((sample) => sample.decisions.expected) +
    sum((sample) => sample.risks.expected) +
    sum((sample) => sample.topic_keywords.expected) +
    samples.length;
  const matchedUnits =
    sum((sample) => sample.action_items.matched) +
    sum((sample) => sample.calendar_drafts.matched) +
    sum((sample) => sample.decisions.matched) +
    sum((sample) => sample.risks.matched) +
    sum((sample) => sample.topic_keywords.matched) +
    samples.filter((sample) => sample.kb_route_correct).length;
  const generatedConfirmations = sum((sample) => sample.generated_confirmations);
  const acceptedConfirmations = sum((sample) => sample.accepted_confirmations);
  const falsePositiveConfirmations = sum((sample) => sample.false_positive_confirmations);
  const falsePositiveCount =
    sum((sample) => sample.action_items.false_positives) +
    sum((sample) => sample.calendar_drafts.false_positives) +
    samples.filter((sample) => sample.generated_create_kb && !sample.expected_should_create_kb)
      .length;
  const manualEffort = estimateManualEffort({
    sampleCount: samples.length,
    knowledgeBaseTriggerCount: labels.filter((label) => label.expected_should_create_kb).length,
    agentRuntimeSeconds
  });

  return {
    samples: samples.length,
    expected_units: expectedUnits,
    matched_units: matchedUnits,
    overall_accuracy: ratio(matchedUnits, expectedUnits),
    action_item_recall: ratio(
      sum((sample) => sample.action_items.matched),
      sum((sample) => sample.action_items.expected)
    ),
    action_item_precision: ratio(
      sum((sample) => sample.action_items.matched),
      sum((sample) => sample.action_items.predicted)
    ),
    action_recall: ratio(
      sum((sample) => sample.action_items.matched),
      sum((sample) => sample.action_items.expected)
    ),
    action_precision: ratio(
      sum((sample) => sample.action_items.matched),
      sum((sample) => sample.action_items.predicted)
    ),
    owner_accuracy: ratio(
      sum((sample) => sample.action_owner.correct),
      sum((sample) => sample.action_owner.expected)
    ),
    due_date_accuracy: ratio(
      sum((sample) => sample.action_due_date.correct),
      sum((sample) => sample.action_due_date.expected)
    ),
    calendar_recall: ratio(
      sum((sample) => sample.calendar_drafts.matched),
      sum((sample) => sample.calendar_drafts.expected)
    ),
    calendar_precision: ratio(
      sum((sample) => sample.calendar_drafts.matched),
      sum((sample) => sample.calendar_drafts.predicted)
    ),
    deadline_vs_calendar_accuracy: ratio(deadlineCorrect, deadlineSamples.length),
    knowledge_base_trigger_accuracy: ratio(
      samples.filter((sample) => sample.kb_route_correct).length,
      samples.length
    ),
    decision_recall: ratio(
      sum((sample) => sample.decisions.matched),
      sum((sample) => sample.decisions.expected)
    ),
    risk_recall: ratio(
      sum((sample) => sample.risks.matched),
      sum((sample) => sample.risks.expected)
    ),
    keyword_recall: ratio(
      sum((sample) => sample.topic_keywords.matched),
      sum((sample) => sample.topic_keywords.expected)
    ),
    kb_routing_accuracy: ratio(
      samples.filter((sample) => sample.kb_route_correct).length,
      samples.length
    ),
    false_positive_count: falsePositiveCount,
    generated_confirmations: generatedConfirmations,
    accepted_confirmations: acceptedConfirmations,
    false_positive_confirmations: falsePositiveConfirmations,
    confirmation_burden_per_meeting: ratio(generatedConfirmations, samples.length),
    agent_runtime_seconds: agentRuntimeSeconds,
    manual_meeting_minutes_min: manualEffort.meetingMin,
    manual_meeting_minutes_max: manualEffort.meetingMax,
    manual_kb_minutes_min: manualEffort.kbMin,
    manual_kb_minutes_max: manualEffort.kbMax,
    manual_total_minutes_min: manualEffort.totalMin,
    manual_total_minutes_max: manualEffort.totalMax,
    user_acceptance_proxy: ratio(acceptedConfirmations, generatedConfirmations),
    manual_minutes_baseline: manualEffort.totalMid,
    agent_minutes_estimate: manualEffort.agentMinutes,
    minutes_saved_estimate: manualEffort.savedMid,
    minutes_saved_min: manualEffort.savedMin,
    minutes_saved_max: manualEffort.savedMax,
    efficiency_lift: manualEffort.liftMid,
    efficiency_lift_min: manualEffort.liftMin,
    efficiency_lift_max: manualEffort.liftMax
  };
}

function buildScenarioCoverage(samples: SampleEvaluation[]): ScenarioCoverage {
  const byScenario = Object.fromEntries(
    REQUIRED_SCENARIOS.map((scenario) => [scenario, [] as string[]])
  ) as Record<RequiredScenario, string[]>;

  for (const sample of samples) {
    for (const scenario of sample.covered_scenarios) {
      byScenario[scenario].push(sample.id);
    }
  }

  const covered = REQUIRED_SCENARIOS.filter((scenario) => byScenario[scenario].length > 0);
  return {
    required: [...REQUIRED_SCENARIOS],
    covered,
    missing: REQUIRED_SCENARIOS.filter((scenario) => byScenario[scenario].length === 0),
    by_scenario: byScenario
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderEvaluationModeBlock(result: EffectivenessEvaluationResult): string[] {
  if (result.evaluation_context.evaluation_type === "mock_fixture_pipeline") {
    return [
      "## Mock Fixture 流程验证",
      "",
      `- Mock Fixture 流程通过率：${formatPercent(result.metrics.overall_accuracy)} (${result.metrics.matched_units}/${result.metrics.expected_units})`,
      "- 该指标验证：人工标签、fixture extraction、workflow、topic clustering、confirmation 生成和指标计算是否按预期工作。",
      "- 该指标不代表真实 LLM 在未知会议上的准确率，也不应被解读为模型准确率。",
      `- Provider：${result.evaluation_context.provider}`,
      `- Fixture model：${result.evaluation_context.model}`,
      `- 运行时间：${result.metrics.agent_runtime_seconds.toFixed(2)} 秒`,
      ""
    ];
  }

  return [
    "## Real LLM Extraction Evaluation",
    "",
    `- Provider：${result.evaluation_context.provider}`,
    `- Model：${result.evaluation_context.model ?? "unknown"}`,
    `- 运行时间：${result.metrics.agent_runtime_seconds.toFixed(2)} 秒`,
    `- Extraction evaluation score：${formatPercent(result.metrics.overall_accuracy)} (${result.metrics.matched_units}/${result.metrics.expected_units})`,
    "- 该指标来自本次真实模型对固定评测集的抽取结果，不等同于生产环境泛化准确率。",
    ""
  ];
}

function renderLimitationsBlock(): string[] {
  return [
    "## 局限性",
    "",
    "- 当前 mock 评测使用预置 extraction，不代表真实 LLM 准确率。",
    "- 当前样本只有 8 条，只证明 P0 场景覆盖。",
    "- Precision 使用标题包含匹配和字段精确匹配，是工程化粗略估算。",
    "- 效率提升基于人工耗时假设，不是真实用户工时审计。",
    "- 当前不覆盖真实飞书权限、真实卡片发送、真实任务/日程/Wiki 创建。",
    "- 真实效果需要使用 `EVALUATION_LLM_PROVIDER=openai-compatible` 复测。",
    ""
  ];
}

function renderMarkdown(result: EffectivenessEvaluationResult): string {
  const lines = [
    "# MeetingAtlas 效果验证评测报告",
    "",
    `生成时间：${result.generated_at}`,
    `执行方式：${result.llm_provider === "mock" ? "fixture mock extraction" : "openai-compatible LLM extraction"} + 内存 SQLite；不连接真实飞书，不修改 FEISHU_DRY_RUN。`,
    "",
    ...renderEvaluationModeBlock(result),
    "## 指标明细",
    "",
    `- 样本数：${result.metrics.samples}`,
    `- Action item 召回率：${formatPercent(result.metrics.action_item_recall)}`,
    `- Action item precision 粗略估算：${formatPercent(result.metrics.action_item_precision)}`,
    `- Owner 准确率：${formatPercent(result.metrics.owner_accuracy)}`,
    `- Due date 准确率：${formatPercent(result.metrics.due_date_accuracy)}`,
    `- Calendar 召回 / 精确：${formatPercent(result.metrics.calendar_recall)} / ${formatPercent(result.metrics.calendar_precision)}`,
    `- Deadline-vs-calendar 区分正确率：${formatPercent(result.metrics.deadline_vs_calendar_accuracy)}`,
    `- Knowledge base trigger accuracy：${formatPercent(result.metrics.knowledge_base_trigger_accuracy)}`,
    `- Decision 召回：${formatPercent(result.metrics.decision_recall)}`,
    `- Risk 召回：${formatPercent(result.metrics.risk_recall)}`,
    `- Topic keyword 召回：${formatPercent(result.metrics.keyword_recall)}`,
    `- False positive count：${result.metrics.false_positive_count}`,
    `- Confirmation burden：${result.metrics.confirmation_burden_per_meeting.toFixed(2)} / meeting`,
    `- 用户接受度代理指标：${formatPercent(result.metrics.user_acceptance_proxy)} (${result.metrics.accepted_confirmations}/${result.metrics.generated_confirmations})`,
    ...(result.evaluation_context.evaluation_type === "mock_fixture_pipeline"
      ? [
          `- Mock dry-run 自动化耗时：${result.metrics.agent_runtime_seconds.toFixed(2)} 秒`,
          "- 效率说明：当前只展示理论节省上界，真实节省比例需用真实 LLM 和真实用户确认链路复测。"
        ]
      : [
          `- Agent dry-run 完整处理耗时：${result.metrics.agent_runtime_seconds.toFixed(2)} 秒`,
          `- 估算节省时间：${formatPercent(result.metrics.efficiency_lift)}（范围 ${formatPercent(result.metrics.efficiency_lift_min)} - ${formatPercent(result.metrics.efficiency_lift_max)}）`
        ]),
    "",
    "## 效率提升估算",
    "",
    "- 人工整理一场会议待办和日程：约 5-10 分钟。",
    "- 人工创建知识库并整理两场会议：约 20-30 分钟。",
    `- 本评测共 ${result.metrics.samples} 场会议，预期触发 ${result.samples.filter((sample) => sample.expected_should_create_kb).length} 次知识库创建。`,
    `- 人工会议整理耗时：${result.metrics.manual_meeting_minutes_min.toFixed(1)} - ${result.metrics.manual_meeting_minutes_max.toFixed(1)} 分钟。`,
    `- 人工知识库整理耗时：${result.metrics.manual_kb_minutes_min.toFixed(1)} - ${result.metrics.manual_kb_minutes_max.toFixed(1)} 分钟。`,
    `- 人工总耗时估算：${result.metrics.manual_total_minutes_min.toFixed(1)} - ${result.metrics.manual_total_minutes_max.toFixed(1)} 分钟；中位估算 ${result.metrics.manual_minutes_baseline.toFixed(1)} 分钟。`,
    ...(result.evaluation_context.evaluation_type === "mock_fixture_pipeline"
      ? [
          `- Mock dry-run 自动化耗时：${result.metrics.agent_runtime_seconds.toFixed(2)} 秒。`,
          "- 该耗时不包含真实 LLM 延迟、真实飞书 API 延迟和用户确认等待时间。",
          "- 基于人工耗时模型，当前自动化链路展示了理论节省上界；真实节省比例需用真实 LLM 和真实用户确认链路复测。",
          `- 理论可节省人工整理时间：${result.metrics.minutes_saved_min.toFixed(1)} - ${result.metrics.minutes_saved_max.toFixed(1)} 分钟（上界估算，不作为真实节省比例结论）。`
        ]
      : [
          `- Agent dry-run 完整处理：${result.metrics.agent_runtime_seconds.toFixed(2)} 秒，约 ${result.metrics.agent_minutes_estimate.toFixed(2)} 分钟。`,
          `- 估算节省：${result.metrics.minutes_saved_min.toFixed(1)} - ${result.metrics.minutes_saved_max.toFixed(1)} 分钟；中位估算 ${result.metrics.minutes_saved_estimate.toFixed(1)} 分钟。`,
          `- 估算节省时间：${formatPercent(result.metrics.efficiency_lift)}（按中位耗时计算）。`
        ]),
    "",
    ...renderLimitationsBlock(),
    "## 指标定义",
    "",
    ...Object.entries(result.metric_definitions).map(
      ([name, definition]) => `- ${name}: ${definition}`
    ),
    "",
    "## 关键场景覆盖",
    "",
    `覆盖进度：${result.scenario_coverage.covered.length}/${result.scenario_coverage.required.length}`,
    "",
    ...result.scenario_coverage.required.map((scenario) => {
      const sampleIds = result.scenario_coverage.by_scenario[scenario];
      const mark = sampleIds.length > 0 ? "PASS" : "MISS";
      return `- ${mark} ${ScenarioDescriptions[scenario]}：${sampleIds.join(", ") || "未覆盖"}`;
    }),
    "",
    "## 样本明细",
    ""
  ];

  for (const sample of result.samples) {
    const status = sample.issues.length === 0 && sample.kb_route_correct ? "PASS" : "CHECK";
    lines.push(
      `### ${sample.id} - ${status}`,
      "",
      `- 会议：${sample.title}`,
      `- 主题路由：${sample.topic_action}；create_kb 期望/实际：${sample.expected_should_create_kb}/${sample.generated_create_kb}`,
      `- Action：${sample.action_items.matched}/${sample.action_items.expected} expected，预测 ${sample.action_items.predicted}`,
      `- Owner：${sample.action_owner.correct}/${sample.action_owner.expected} expected`,
      `- Due date：${sample.action_due_date.correct}/${sample.action_due_date.expected} expected`,
      `- Calendar：${sample.calendar_drafts.matched}/${sample.calendar_drafts.expected} expected，预测 ${sample.calendar_drafts.predicted}`,
      `- Decision：${sample.decisions.matched}/${sample.decisions.expected} expected`,
      `- Risk：${sample.risks.matched}/${sample.risks.expected} expected`,
      `- Keyword：${sample.topic_keywords.matched}/${sample.topic_keywords.expected} expected`,
      `- 覆盖场景：${sample.covered_scenarios.map((scenario) => ScenarioDescriptions[scenario]).join("；") || "无"}`,
      `- Confirmation 接受度：${sample.accepted_confirmations}/${sample.generated_confirmations}`,
      `- 标注说明：${sample.notes}`
    );
    if (sample.issues.length > 0) {
      lines.push(`- 待检查：${sample.issues.join("；")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function resultStatus(
  metrics: EvaluationMetrics,
  samples: SampleEvaluation[],
  scenarioCoverage: ScenarioCoverage
): "passed" | "failed" {
  const hasIssues = samples.some((sample) => sample.issues.length > 0 || !sample.kb_route_correct);
  return !hasIssues &&
    scenarioCoverage.missing.length === 0 &&
    metrics.overall_accuracy >= 0.9 &&
    metrics.user_acceptance_proxy >= 0.8 &&
    metrics.efficiency_lift > 0
    ? "passed"
    : "failed";
}

export async function runEffectivenessEvaluation(
  options: RunEffectivenessEvaluationOptions = {}
): Promise<EffectivenessEvaluationResult> {
  const startedAt = process.hrtime.bigint();
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const llmProvider =
    options.llmProvider ?? parseEvaluationLlmProvider(process.env.EVALUATION_LLM_PROVIDER);
  const { manifest, labels, extractions, meetingTexts } = readEvaluationFixtureSet(manifestPath);
  const repos = createRepositories(createMemoryDatabase());
  const { llm, context } = createEvaluationLlmClient({
    provider: llmProvider,
    fixtureExtractions: extractions
  });
  const samples: SampleEvaluation[] = [];

  for (let index = 0; index < manifest.length; index += 1) {
    const item: ManifestItem = manifest[index]!;
    const label = labels[index]!;
    const meeting: ManualMeetingInput = {
      title: item.title,
      participants: item.participants,
      organizer: item.organizer,
      started_at: item.started_at,
      ended_at: item.ended_at,
      transcript_text: meetingTexts[index]!
    };
    const confirmationCountBefore = repos.listConfirmationRequests().length;
    const actionCountBefore = repos.listActionItems().length;
    const calendarCountBefore = repos.listCalendarDrafts().length;
    const workflowResult = await processMeetingWorkflow({ repos, llm, meeting });
    const extraction = workflowResult.extraction;
    const confirmations = repos.listConfirmationRequests().slice(confirmationCountBefore);
    const actionRows = repos.listActionItems().slice(actionCountBefore);
    const calendarRows = repos.listCalendarDrafts().slice(calendarCountBefore);

    const actionMatches = countMatches(
      label.expected_action_items,
      extraction.action_items,
      matchActionTitle
    );
    const calendarMatches = countMatches(
      label.expected_calendar_drafts,
      extraction.calendar_drafts,
      matchCalendar
    );
    const decisionMatches = countMatches(
      label.expected_decisions,
      extraction.key_decisions,
      matchDecision
    );
    const riskMatches = countMatches(label.expected_risks, extraction.risks, matchRisk);
    const keywordMatches = countMatches(
      label.expected_topic_keywords,
      extraction.topic_keywords,
      matchKeyword
    );
    const generatedCreateKb = workflowResult.topic_match.suggested_action === "ask_create";
    const kbRouteCorrect = label.expected_should_create_kb === generatedCreateKb;
    const confirmationStats = confirmationAcceptance({
      confirmations,
      label,
      actionRows,
      calendarRows
    });
    const sampleStats = {
      action_items: calculateMatchStats(
        label.expected_action_items.length,
        extraction.action_items.length,
        actionMatches.matched
      ),
      action_owner: actionFieldAccuracy(
        label.expected_action_items,
        extraction.action_items,
        actionMatches.matchedPairs,
        "owner"
      ),
      action_due_date: actionFieldAccuracy(
        label.expected_action_items,
        extraction.action_items,
        actionMatches.matchedPairs,
        "due_date"
      ),
      calendar_drafts: calculateMatchStats(
        label.expected_calendar_drafts.length,
        extraction.calendar_drafts.length,
        calendarMatches.matched
      ),
      decisions: calculateMatchStats(
        label.expected_decisions.length,
        extraction.key_decisions.length,
        decisionMatches.matched
      ),
      risks: calculateMatchStats(
        label.expected_risks.length,
        extraction.risks.length,
        riskMatches.matched
      ),
      topic_keywords: calculateMatchStats(
        label.expected_topic_keywords.length,
        extraction.topic_keywords.length,
        keywordMatches.matched
      )
    };
    const issues = describeMisses(item.id, label, extraction, sampleStats);
    if (!kbRouteCorrect) {
      issues.push(
        `${item.id}: create_kb routing expected ${label.expected_should_create_kb} but got ${generatedCreateKb}`
      );
    }

    samples.push({
      id: item.id,
      title: item.title,
      notes: label.notes,
      topic_action: workflowResult.topic_match.suggested_action,
      expected_should_create_kb: label.expected_should_create_kb,
      generated_create_kb: generatedCreateKb,
      kb_route_correct: kbRouteCorrect,
      ...sampleStats,
      covered_scenarios: label.covered_scenarios,
      generated_confirmations: confirmations.length,
      accepted_confirmations: confirmationStats.accepted,
      false_positive_confirmations: confirmationStats.falsePositive,
      issues
    });
  }

  const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
  const metrics = calculateEvaluationMetrics(samples, labels, elapsedSeconds);
  const scenarioCoverage = buildScenarioCoverage(samples);
  const result: EffectivenessEvaluationResult = {
    status: resultStatus(metrics, samples, scenarioCoverage),
    generated_at: options.generatedAt ?? new Date().toISOString(),
    dry_run_only: true,
    llm_provider: llmProvider,
    evaluation_context: context,
    manifest_path: manifestPath,
    output_dir: outputDir,
    metric_definitions: MetricDefinitions,
    metrics,
    scenario_coverage: scenarioCoverage,
    samples,
    report_paths: {
      json: null,
      markdown: null
    }
  };

  if (options.writeOutputs ?? true) {
    const jsonPath = join(outputDir, DEFAULT_JSON_REPORT_NAME);
    const markdownPath = join(outputDir, DEFAULT_MARKDOWN_REPORT_NAME);
    if (!existsSync(dirname(jsonPath))) {
      mkdirSync(dirname(jsonPath), { recursive: true });
    }
    writeFileSync(markdownPath, renderMarkdown(result));
    result.report_paths = {
      json: jsonPath,
      markdown: markdownPath
    };
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

function parseArgs(argv: string[]): {
  outputDir?: string;
  writeOutputs: boolean;
  jsonOnly: boolean;
} {
  const parsed: { outputDir?: string; writeOutputs: boolean; jsonOnly: boolean } = {
    writeOutputs: true,
    jsonOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a value");
      }
      parsed.outputDir = value;
      index += 1;
    } else if (arg === "--no-write") {
      parsed.writeOutputs = false;
    } else if (arg === "--json") {
      parsed.jsonOnly = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export async function runFixtureEvaluationCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEffectivenessEvaluation({
    outputDir: args.outputDir,
    writeOutputs: args.writeOutputs
  });

  if (args.jsonOnly) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "MeetingAtlas effectiveness evaluation",
        `Status: ${result.status}`,
        `Samples: ${result.metrics.samples}`,
        `LLM provider: ${result.llm_provider}`,
        result.evaluation_context.evaluation_type === "mock_fixture_pipeline"
          ? `Mock fixture pipeline pass rate: ${formatPercent(result.metrics.overall_accuracy)}`
          : `Real LLM extraction evaluation: ${formatPercent(result.metrics.overall_accuracy)}`,
        `Scenario coverage: ${result.scenario_coverage.covered.length}/${result.scenario_coverage.required.length}`,
        `User acceptance proxy: ${formatPercent(result.metrics.user_acceptance_proxy)}`,
        `Agent dry-run runtime: ${result.metrics.agent_runtime_seconds.toFixed(2)}s`,
        result.evaluation_context.evaluation_type === "mock_fixture_pipeline"
          ? "Efficiency note: theoretical upper bound only; rerun with real LLM and user confirmation flow for true savings."
          : `Estimated efficiency lift: ${formatPercent(result.metrics.efficiency_lift)}`,
        result.report_paths.markdown ? `Markdown report: ${result.report_paths.markdown}` : null,
        result.report_paths.json ? `JSON report: ${result.report_paths.json}` : null
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    );
    process.stdout.write("\n");
  }

  if (result.status !== "passed") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runFixtureEvaluationCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
