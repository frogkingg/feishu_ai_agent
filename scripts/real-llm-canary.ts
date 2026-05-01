import { AppConfig, loadConfig } from "../src/config";
import { runMeetingExtractionAgent } from "../src/agents/meetingExtractionAgent";
import { buildConfirmationCardFromRequest } from "../src/agents/cardInteractionAgent";
import { ManualMeetingInput, MeetingExtractionResult } from "../src/schemas";
import { confirmRequest } from "../src/services/confirmationService";
import { createLlmClient } from "../src/services/llm/createLlmClient";
import { GenerateJsonInput, LlmClient } from "../src/services/llm/llmClient";
import { createDatabase } from "../src/services/store/db";
import {
  CalendarDraftRow,
  ConfirmationRequestRow,
  createRepositories,
  Repositories
} from "../src/services/store/repositories";
import { nowIso } from "../src/utils/dates";
import { processMeetingWorkflow, ProcessMeetingResult } from "../src/workflows/processMeetingWorkflow";

const DryRunEnvKeys = [
  "FEISHU_DRY_RUN",
  "FEISHU_CARD_SEND_DRY_RUN",
  "FEISHU_TASK_CREATE_DRY_RUN",
  "FEISHU_CALENDAR_CREATE_DRY_RUN",
  "FEISHU_KNOWLEDGE_WRITE_DRY_RUN"
] as const;

const ForbiddenKnowledgeWords = [/fallback/i, /等待\s*LLM/i, /正式结构由\s*LLM/i];
const DefaultLlmTimeoutMs = 180_000;
const DefaultStepTimeoutMs = 600_000;

interface CanaryOptions {
  dryCheck: boolean;
  help: boolean;
  sqlitePath: string;
  llmTimeoutMs: number;
  stepTimeoutMs: number;
}

type ConfirmationCounts = Record<string, number>;

interface StepResult<T> {
  value: T;
  seconds: number;
}

interface CreateKbTarget {
  confirmation: ConfirmationRequestRow;
  candidateMeetingCount: number;
  topicName: string | null;
  score: number | null;
}

interface CreateKbCanaryResult {
  id: string;
  candidate_meeting_count: number;
  topic_name: string | null;
  score: number | null;
  seconds: number;
  status: string | null;
  failed: boolean;
  error: string | null;
  dry_run: boolean | null;
  kb_name: string | null;
  wiki_url_is_mock: boolean;
  homepage_url_is_mock: boolean;
  page_count: number;
  page_titles: string[];
  forbidden_words_present: boolean;
  forbidden_words: string[];
  home_excerpt: string;
  progress_excerpt: string;
  decisions_excerpt: string;
}

interface ParsedArgs {
  options: CanaryOptions;
  errors: string[];
}

class StepTracker {
  private currentStep = "boot";

  constructor(private readonly log: (message: string) => void) {}

  set(step: string): void {
    this.currentStep = step;
  }

  get(): string {
    return this.currentStep;
  }

  info(event: string, data: Record<string, unknown> = {}): void {
    this.log(
      `[canary] ${new Date().toISOString()} ${event} ${JSON.stringify({
        step: this.currentStep,
        ...data
      })}`
    );
  }
}

class LoggingLlmClient implements LlmClient {
  private callCount = 0;

  constructor(
    private readonly inner: LlmClient,
    private readonly tracker: StepTracker,
    private readonly timeoutMs: number
  ) {}

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    const callId = ++this.callCount;
    const started = Date.now();
    this.tracker.info("llm.start", {
      call_id: callId,
      schema_name: input.schemaName,
      timeout_ms: this.timeoutMs
    });

    try {
      const result = await withTimeout({
        promise: this.inner.generateJson<T>(input),
        timeoutMs: this.timeoutMs,
        label: `LLM generateJson timed out after ${this.timeoutMs}ms`,
        onTimeout: () =>
          this.tracker.info("llm.timeout", {
            call_id: callId,
            schema_name: input.schemaName,
            elapsed_ms: Date.now() - started
          })
      });
      this.tracker.info("llm.done", {
        call_id: callId,
        schema_name: input.schemaName,
        elapsed_ms: Date.now() - started
      });
      return result;
    } catch (error) {
      this.tracker.info("llm.error", {
        call_id: callId,
        schema_name: input.schemaName,
        elapsed_ms: Date.now() - started,
        error: sanitizeError(error)
      });
      throw error;
    }
  }
}

function usage(): string {
  return [
    "Usage: npm run canary:real-llm -- [options]",
    "",
    "Runs a real OpenAI-compatible LLM canary while all Feishu write/card paths stay dry-run.",
    "",
    "Options:",
    "  --dry-check                 Validate env safety and LLM config without calling the LLM.",
    "  --sqlite-path <path>         Use an explicit SQLite path. Default: /tmp/meetingatlas-real-llm-canary-<timestamp>.db",
    "  --llm-timeout-ms <ms>        Timeout for each generateJson call. Default: 180000",
    "  --step-timeout-ms <ms>       Timeout for each top-level step. Default: 600000",
    "  --help                      Show this help text."
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const options: CanaryOptions = {
    dryCheck: false,
    help: false,
    sqlitePath: `/tmp/meetingatlas-real-llm-canary-${timestamp}.db`,
    llmTimeoutMs: DefaultLlmTimeoutMs,
    stepTimeoutMs: DefaultStepTimeoutMs
  };
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-check") {
      options.dryCheck = true;
      continue;
    }
    if (arg === "--sqlite-path") {
      const value = argv[index + 1];
      if (!value) {
        errors.push("--sqlite-path requires a value");
      } else {
        options.sqlitePath = value;
        index += 1;
      }
      continue;
    }
    if (arg === "--llm-timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        errors.push("--llm-timeout-ms requires a positive number");
      } else {
        options.llmTimeoutMs = value;
        index += 1;
      }
      continue;
    }
    if (arg === "--step-timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        errors.push("--step-timeout-ms requires a positive number");
      } else {
        options.stepTimeoutMs = value;
        index += 1;
      }
      continue;
    }

    errors.push(`Unknown option: ${arg}`);
  }

  return { options, errors };
}

function isTrueLike(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

function envDryRunState(): Record<(typeof DryRunEnvKeys)[number], boolean> {
  return Object.fromEntries(DryRunEnvKeys.map((key) => [key, isTrueLike(process.env[key])])) as Record<
    (typeof DryRunEnvKeys)[number],
    boolean
  >;
}

function assertDryRunEnv(): Record<(typeof DryRunEnvKeys)[number], boolean> {
  const state = envDryRunState();
  const unsafe = Object.entries(state)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);

  if (unsafe.length > 0) {
    throw new Error(`Refusing to run real-LLM canary; dry-run env must be true: ${unsafe.join(", ")}`);
  }

  return state;
}

function assertRealLlmConfig(config: AppConfig): void {
  const missing = [
    ["LLM_PROVIDER=openai-compatible", config.llmProvider === "openai-compatible"],
    ["LLM_BASE_URL", Boolean(config.llmBaseUrl)],
    ["LLM_API_KEY", Boolean(config.llmApiKey)],
    ["LLM_MODEL", Boolean(config.llmModel)]
  ]
    .filter(([, ok]) => !ok)
    .map(([label]) => label);

  if (missing.length > 0) {
    throw new Error(`Real LLM canary requires openai-compatible config. Missing: ${missing.join(", ")}`);
  }
}

function maskModel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.length <= 8 ? "[set]" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sanitizeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s)]+/gi, "[REDACTED_URL]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 800);
}

function elapsedSeconds(started: number): number {
  return Number(((Date.now() - started) / 1000).toFixed(2));
}

async function withTimeout<T>(input: {
  promise: Promise<T>;
  timeoutMs: number;
  label: string;
  onTimeout?: () => void;
}): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      input.promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          input.onTimeout?.();
          reject(new Error(input.label));
        }, input.timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function runStep<T>(input: {
  name: string;
  tracker: StepTracker;
  timeoutMs: number;
  action: () => Promise<T>;
  summarize?: (value: T) => Record<string, unknown>;
}): Promise<StepResult<T>> {
  input.tracker.set(input.name);
  const started = Date.now();
  input.tracker.info("step.start", {
    timeout_ms: input.timeoutMs
  });

  try {
    const value = await withTimeout({
      promise: input.action(),
      timeoutMs: input.timeoutMs,
      label: `Step ${input.name} timed out after ${input.timeoutMs}ms`,
      onTimeout: () =>
        input.tracker.info("step.timeout", {
          elapsed_ms: Date.now() - started
        })
    });
    const seconds = elapsedSeconds(started);
    input.tracker.info("step.done", {
      seconds,
      ...(input.summarize?.(value) ?? {})
    });
    return { value, seconds };
  } catch (error) {
    input.tracker.info("step.error", {
      seconds: elapsedSeconds(started),
      error: sanitizeError(error)
    });
    throw error;
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function compact(value: unknown, maxLength = 120): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function confirmationCounts(confirmations: ConfirmationRequestRow[]): ConfirmationCounts {
  return confirmations.reduce<ConfirmationCounts>((counts, confirmation) => {
    const key = `${confirmation.request_type}:${confirmation.status}`;
    return {
      ...counts,
      [key]: (counts[key] ?? 0) + 1
    };
  }, {});
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = keyFor(value);
    return {
      ...counts,
      [key]: (counts[key] ?? 0) + 1
    };
  }, {});
}

function createSmokeMeeting() {
  const timestamp = nowIso();
  return {
    id: "smoke_real_llm_canary",
    external_meeting_id: null,
    title: "Real LLM canary smoke",
    started_at: timestamp,
    ended_at: timestamp,
    organizer: "ou_canary_owner",
    participants_json: JSON.stringify(["Leo", "May", "Chen"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text:
      "周五前完成竞品分析，Leo 负责；下周二 10 点和产品评审排期，拉上 May 和 Chen。这次 OpenClaw 的知识库要沉淀成 onboarding 包，把前两次访谈和今天的结论合并。",
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function openClawMeetingOne(): ManualMeetingInput {
  return {
    external_meeting_id: "real-llm-canary-openclaw-001",
    title: "OpenClaw 新人访谈复盘",
    participants: ["Leo", "May", "Chen"],
    organizer: "ou_canary_owner",
    started_at: "2026-05-02T09:30:00+08:00",
    ended_at: "2026-05-02T10:20:00+08:00",
    minutes_url: "https://example.feishu.cn/minutes/openclaw-canary-001",
    transcript_url: "https://example.feishu.cn/minutes/openclaw-canary-001/transcript",
    transcript_text:
      "今天复盘 OpenClaw 前两次新人访谈。结论：新同学 onboarding 主要卡在环境安装、权限申请、核心概念地图和常见故障定位。May 负责周五前整理环境安装 FAQ，Chen 负责下周一前补齐权限申请清单。下周二 10 点和产品、工程做 onboarding 包结构评审，拉上 Leo、May、Chen。风险：资料分散在旧文档和访谈纪要里，版本不一致。"
  };
}

function openClawMeetingTwo(): ManualMeetingInput {
  return {
    external_meeting_id: "real-llm-canary-openclaw-002",
    title: "OpenClaw Onboarding 包沉淀决策会",
    participants: ["Leo", "May", "Chen", "产品"],
    organizer: "ou_canary_owner",
    started_at: "2026-05-02T14:00:00+08:00",
    ended_at: "2026-05-02T14:45:00+08:00",
    minutes_url: "https://example.feishu.cn/minutes/openclaw-canary-002",
    transcript_url: "https://example.feishu.cn/minutes/openclaw-canary-002/transcript",
    transcript_text:
      "这次 OpenClaw 的知识库要沉淀成一个 onboarding 包，把前两次访谈和今天的结论合并。首页要让新人知道第一天怎么跑通，第二页解释权限和环境，第三页放常见问题和决策记录。Leo 负责周五前给出最终目录和负责人分配；May 明天下午 3 点和 Chen 过一遍 FAQ 缺口，不用拉全员；下周三 11 点安排一次 30 分钟 onboarding 包验收会，拉上 Leo、May、Chen 和产品。决策：先做新人成本最低的路径，不追求覆盖所有历史细节。"
  };
}

function topicSummary(result: ProcessMeetingResult): Record<string, unknown> {
  return {
    meeting_id: result.meeting_id,
    topic_action: result.topic_match.suggested_action,
    topic_score: result.topic_match.score,
    actions: result.extraction.action_items.length,
    calendars: result.extraction.calendar_drafts.length,
    confirmations: result.confirmation_requests.length
  };
}

function smokeSummary(result: MeetingExtractionResult): Record<string, unknown> {
  return {
    actions: result.action_items.length,
    calendars: result.calendar_drafts.length,
    keywords: result.topic_keywords.slice(0, 6),
    confidence: result.confidence
  };
}

function createKbTargets(confirmations: ConfirmationRequestRow[]): CreateKbTarget[] {
  return confirmations
    .filter((confirmation) => confirmation.request_type === "create_kb")
    .map((confirmation) => {
      const payload = parseJsonObject(confirmation.original_payload_json);
      const meetingIds = stringArray(payload.meeting_ids).length
        ? stringArray(payload.meeting_ids)
        : stringArray(payload.candidate_meeting_ids);
      const score = typeof payload.score === "number" ? payload.score : null;
      return {
        confirmation,
        candidateMeetingCount: meetingIds.length,
        topicName: typeof payload.topic_name === "string" ? payload.topic_name : null,
        score
      };
    })
    .sort((left, right) => left.candidateMeetingCount - right.candidateMeetingCount);
}

function forbiddenWordsForText(text: string): string[] {
  return ForbiddenKnowledgeWords.filter((pattern) => pattern.test(text)).map((pattern) =>
    pattern.source.replace(/\\s\*/g, " ")
  );
}

function pageByTitle(
  pages: Array<{ title: string; markdown: string }>,
  needle: string
): { title: string; markdown: string } | null {
  return pages.find((page) => page.title.includes(needle)) ?? null;
}

function cardSummary(repos: Repositories, confirmations: ConfirmationRequestRow[]) {
  return confirmations.map((confirmation) => {
    const card = buildConfirmationCardFromRequest(confirmation, { repos });
    return {
      id: confirmation.id,
      type: confirmation.request_type,
      status: confirmation.status,
      card_type: card.card_type,
      title: card.title,
      summary: card.summary,
      sections: card.sections.map((section) => ({
        title: section.title,
        fields: section.fields.slice(0, 4).map((field) => ({
          key: field.key,
          label: field.label,
          value: compact(field.value_text ?? field.value, 90)
        }))
      })),
      actions: card.actions.map((action) => action.key)
    };
  });
}

function calendarMissingFieldIssues(calendars: CalendarDraftRow[]) {
  return calendars
    .map((calendar) => {
      const missingFields = parseJsonArray(calendar.missing_fields_json);
      const issueFields: string[] = [];
      if (calendar.end_time !== null && missingFields.includes("end_time")) {
        issueFields.push("end_time");
      }
      if (calendar.duration_minutes !== null && missingFields.includes("duration_minutes")) {
        issueFields.push("duration_minutes");
      }

      return {
        title: calendar.title,
        start_time: calendar.start_time,
        end_time: calendar.end_time,
        duration_minutes: calendar.duration_minutes,
        missing_fields: missingFields,
        issue_fields: issueFields
      };
    })
    .filter((item) => item.issue_fields.length > 0);
}

async function confirmCreateKbTargets(input: {
  repos: Repositories;
  config: AppConfig;
  llm: LlmClient;
  targets: CreateKbTarget[];
  tracker: StepTracker;
  stepTimeoutMs: number;
}): Promise<CreateKbCanaryResult[]> {
  const results: CreateKbCanaryResult[] = [];
  for (const target of input.targets) {
    const stepName = `confirm_create_kb_${target.candidateMeetingCount}_meeting_${
      results.length + 1
    }`;
    const confirmed = await runStep({
      name: stepName,
      tracker: input.tracker,
      timeoutMs: input.stepTimeoutMs,
      action: async () =>
        confirmRequest({
          repos: input.repos,
          config: input.config,
          id: target.confirmation.id,
          llm: input.llm
        }),
      summarize: (value) => ({
        status: value.confirmation.status,
        failed: Boolean(asRecord(value.result).failed),
        target_id: value.confirmation.target_id
      })
    });
    const result = asRecord(confirmed.value.result);
    const draft = asRecord(result.draft);
    const pages = Array.isArray(draft.pages)
      ? (draft.pages as Array<{ title: string; markdown: string }>)
      : [];
    const pageText = pages.map((page) => `${page.title}\n${page.markdown}`).join("\n---\n");
    const forbiddenWords = forbiddenWordsForText(pageText);
    const knowledgeBase = asRecord(result.knowledge_base);
    const wikiUrl = typeof knowledgeBase.wiki_url === "string" ? knowledgeBase.wiki_url : null;
    const homepageUrl =
      typeof knowledgeBase.homepage_url === "string" ? knowledgeBase.homepage_url : null;

    results.push({
      id: target.confirmation.id,
      candidate_meeting_count: target.candidateMeetingCount,
      topic_name: target.topicName,
      score: target.score,
      seconds: confirmed.seconds,
      status: confirmed.value.confirmation.status,
      failed: Boolean(result.failed) || confirmed.value.confirmation.status === "failed",
      error:
        typeof result.error === "string"
          ? sanitizeError(result.error)
          : confirmed.value.confirmation.error,
      dry_run: typeof result.dry_run === "boolean" ? result.dry_run : null,
      kb_name: typeof knowledgeBase.name === "string" ? knowledgeBase.name : null,
      wiki_url_is_mock: wikiUrl?.startsWith("mock://feishu/wiki/") ?? false,
      homepage_url_is_mock: homepageUrl?.startsWith("mock://feishu/wiki/") ?? false,
      page_count: pages.length,
      page_titles: pages.map((page) => page.title),
      forbidden_words_present: forbiddenWords.length > 0,
      forbidden_words: forbiddenWords,
      home_excerpt: compact(pageByTitle(pages, "首页")?.markdown, 240),
      progress_excerpt: compact(pageByTitle(pages, "当前进度")?.markdown, 240),
      decisions_excerpt: compact(pageByTitle(pages, "关键结论")?.markdown, 240)
    });
  }

  return results;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function runCanary(options: CanaryOptions) {
  process.env.SQLITE_PATH = options.sqlitePath;
  const dryRun = assertDryRunEnv();
  const config = {
    ...loadConfig(),
    llmTimeoutMs: options.llmTimeoutMs
  };
  assertRealLlmConfig(config);

  const configSummary = {
    provider: config.llmProvider,
    model_masked: maskModel(config.llmModel),
    api_key_present: Boolean(config.llmApiKey),
    base_url_present: Boolean(config.llmBaseUrl),
    sqlite_path: config.sqlitePath,
    llm_timeout_ms: config.llmTimeoutMs,
    step_timeout_ms: options.stepTimeoutMs,
    dry_run: dryRun
  };

  if (options.dryCheck) {
    return {
      ok: true,
      mode: "dry-check",
      config: configSummary,
      note: "No LLM call, SQLite write, Feishu call, or card send was attempted."
    };
  }

  const tracker = new StepTracker((message) => process.stdout.write(`${message}\n`));
  tracker.info("canary.config", configSummary);

  const repos = createRepositories(createDatabase(config.sqlitePath));
  const llm = new LoggingLlmClient(createLlmClient(config), tracker, options.llmTimeoutMs);
  const started = Date.now();

  const smoke = await runStep({
    name: "smoke_extraction",
    tracker,
    timeoutMs: options.stepTimeoutMs,
    action: async () =>
      runMeetingExtractionAgent({
        meeting: createSmokeMeeting(),
        llm
      }),
    summarize: smokeSummary
  });
  const meetingOne = await runStep({
    name: "workflow_m1",
    tracker,
    timeoutMs: options.stepTimeoutMs,
    action: async () =>
      processMeetingWorkflow({
        repos,
        llm,
        meeting: openClawMeetingOne()
      }),
    summarize: topicSummary
  });
  const meetingTwo = await runStep({
    name: "workflow_m2",
    tracker,
    timeoutMs: options.stepTimeoutMs,
    action: async () =>
      processMeetingWorkflow({
        repos,
        llm,
        meeting: openClawMeetingTwo()
      }),
    summarize: topicSummary
  });

  const confirmationsBeforeConfirm = repos.listConfirmationRequests();
  const cardsBeforeConfirm = cardSummary(repos, confirmationsBeforeConfirm);
  const targets = createKbTargets(confirmationsBeforeConfirm);
  tracker.info("create_kb.targets", {
    count: targets.length,
    targets: targets.map((target) => ({
      id: target.confirmation.id,
      candidate_meeting_count: target.candidateMeetingCount,
      topic_name: target.topicName,
      score: target.score
    }))
  });
  const createKbResults = await confirmCreateKbTargets({
    repos,
    config,
    llm,
    targets,
    tracker,
    stepTimeoutMs: options.stepTimeoutMs
  });

  const state = repos.getStateSummary();
  const calendarIssues = calendarMissingFieldIssues(state.calendar_drafts);
  const cliRuns = state.cli_runs.map((run) => ({
    tool: run.tool,
    dry_run: Boolean(run.dry_run),
    status: run.status
  }));
  const cliRunsSafe = cliRuns.every((run) => run.dry_run && run.status === "planned");
  const quality = {
    create_kb_present: targets.length > 0,
    single_create_kb_confirm_not_failed: createKbResults
      .filter((result) => result.candidate_meeting_count <= 1)
      .every((result) => !result.failed),
    knowledge_no_forbidden_words: createKbResults
      .filter((result) => !result.failed)
      .every((result) => !result.forbidden_words_present),
    calendar_missing_fields_clean: calendarIssues.length === 0,
    cli_runs_safe: cliRuns.length === 0 || cliRunsSafe,
    no_real_feishu_write_or_card_send: cliRuns.length === 0 || cliRunsSafe
  };

  return {
    ok: Object.values(quality).every(Boolean),
    mode: "real-llm-dry-run-canary",
    config: configSummary,
    total_seconds: elapsedSeconds(started),
    timings: {
      smoke_seconds: smoke.seconds,
      meeting1_seconds: meetingOne.seconds,
      meeting2_seconds: meetingTwo.seconds,
      create_kb_seconds: createKbResults.reduce((total, result) => total + result.seconds, 0)
    },
    smoke: {
      actions: smoke.value.action_items.map((item) => ({
        title: item.title,
        owner: item.owner,
        due_date: item.due_date,
        missing_fields: item.missing_fields
      })),
      calendars: smoke.value.calendar_drafts.map((draft) => ({
        title: draft.title,
        start_time: draft.start_time,
        duration_minutes: draft.duration_minutes,
        missing_fields: draft.missing_fields
      }))
    },
    topic_results: [
      {
        meeting: "m1",
        action: meetingOne.value.topic_match.suggested_action,
        score: meetingOne.value.topic_match.score,
        candidates: meetingOne.value.topic_match.candidate_meeting_ids,
        reasons: meetingOne.value.topic_match.match_reasons
      },
      {
        meeting: "m2",
        action: meetingTwo.value.topic_match.suggested_action,
        score: meetingTwo.value.topic_match.score,
        candidates: meetingTwo.value.topic_match.candidate_meeting_ids,
        reasons: meetingTwo.value.topic_match.match_reasons
      }
    ],
    extraction_counts: {
      m1: {
        actions: meetingOne.value.extraction.action_items.length,
        calendars: meetingOne.value.extraction.calendar_drafts.length,
        confirmations: meetingOne.value.confirmation_requests.length
      },
      m2: {
        actions: meetingTwo.value.extraction.action_items.length,
        calendars: meetingTwo.value.extraction.calendar_drafts.length,
        confirmations: meetingTwo.value.confirmation_requests.length
      }
    },
    confirmation_counts_before_create_kb_confirm: confirmationCounts(confirmationsBeforeConfirm),
    confirmation_counts_after_create_kb_confirm: confirmationCounts(repos.listConfirmationRequests()),
    card_counts_before_create_kb_confirm: countBy(cardsBeforeConfirm, (card) => card.card_type),
    cards_before_create_kb_confirm: cardsBeforeConfirm,
    create_kb_results: createKbResults,
    knowledge_page_titles: createKbResults.flatMap((result) => result.page_titles),
    calendar_drafts: state.calendar_drafts.map((calendar) => ({
      title: calendar.title,
      start_time: calendar.start_time,
      end_time: calendar.end_time,
      duration_minutes: calendar.duration_minutes,
      missing_fields: parseJsonArray(calendar.missing_fields_json)
    })),
    calendar_missing_field_issues: calendarIssues,
    cli_runs_count: cliRuns.length,
    cli_runs: cliRuns,
    quality
  };
}

export async function runRealLlmCanaryCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.join("; "));
  }

  const result = await runCanary(parsed.options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  runRealLlmCanaryCli().catch((error: unknown) => {
    process.stderr.write(`${sanitizeError(error)}\n`);
    process.exit(1);
  });
}
