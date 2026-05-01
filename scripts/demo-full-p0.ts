import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ConfirmationRequestType =
  | "action"
  | "calendar"
  | "create_kb"
  | "append_meeting"
  | "archive_source";

export type DemoMode = "full-p0" | "cards-only" | "send-cards";

export interface HealthResponse {
  ok: boolean;
  service: string;
  dry_run: boolean;
  card_send_dry_run: boolean;
  llm_provider: string;
  sqlite_path: string;
}

export interface TopicMatchResponse {
  score: number;
  match_reasons: string[];
  suggested_action: "no_action" | "observe" | "ask_append" | "ask_create";
  candidate_meeting_ids: string[];
  matched_kb_id?: string | null;
  matched_kb_name?: string | null;
}

export interface MeetingResponse {
  meeting_id: string;
  extraction: {
    action_items: unknown[];
    calendar_drafts: unknown[];
  };
  confirmation_requests: string[];
  topic_match: TopicMatchResponse;
}

export interface ConfirmationRequest {
  id: string;
  request_type: ConfirmationRequestType;
  target_id: string;
  status: string;
  original_payload_json: string;
  dry_run_card?: {
    card_type: string;
    title: string;
    summary: string;
    sections: unknown[];
    editable_fields: unknown[];
    actions: Array<{ key: string }>;
    dry_run: true;
  };
}

export interface DryRunCardPreview {
  request_id: string;
  card_type: string;
  title: string;
  summary: string;
  sections: unknown[];
  editable_fields: unknown[];
  actions: Array<{ key: string }>;
  dry_run: true;
}

export interface SendCardsResponse {
  ok: boolean;
  total: number;
  planned: number;
  sent: number;
  failed: number;
  results: Array<{
    confirmation_id: string;
    card_type: string;
    status: "planned" | "sent" | "failed";
    dry_run: boolean;
    cli_run_id: string | null;
    chat_id: string | null;
    recipient: string | null;
    error: string | null;
  }>;
}

export interface ConfirmResponse {
  confirmation: ConfirmationRequest;
  result: unknown;
}

export interface ActionItemState {
  title: string;
  owner: string | null;
  due_date: string | null;
  priority: "P0" | "P1" | "P2" | null;
  confirmation_status: string;
  missing_fields_json: string;
}

export interface CalendarDraftState {
  participants_json: string;
  duration_minutes: number | null;
  location: string | null;
  confirmation_status: string;
  missing_fields_json: string;
}

export interface KnowledgeBaseState {
  name: string;
  wiki_url: string | null;
  homepage_url: string | null;
}

export interface KnowledgeUpdateState {
  update_type: string;
  summary?: string;
  after_text?: string | null;
}

export interface CliRunState {
  dry_run: 0 | 1;
  status: string;
  tool: string;
}

export interface StateResponse {
  meetings: unknown[];
  action_items: ActionItemState[];
  calendar_drafts: CalendarDraftState[];
  knowledge_bases: KnowledgeBaseState[];
  knowledge_updates: KnowledgeUpdateState[];
  confirmation_requests: ConfirmationRequest[];
  cli_runs: CliRunState[];
}

export interface DemoReportSummary {
  status: "passed";
  mode: DemoMode;
  generated_at: string;
  base_url: string;
  llm_provider: string;
  feishu_write_mode: "dry-run";
  dry_run_note: string;
  meetings_processed: number;
  action_confirmations_executed: number;
  calendar_confirmations_executed: number;
  knowledge_base_confirmations_executed: number;
  append_meeting_confirmations_executed: number;
  card_previews_generated: number;
  action_cards: number;
  calendar_cards: number;
  knowledge_base_cards: number;
  append_meeting_cards: number;
  card_send_cli_records: number;
  knowledge_base_name: string;
  knowledge_base_url: string;
  knowledge_update: string;
  knowledge_updates: string[];
  pending_confirmations: number;
  pending_confirmation_ids: string[];
  dry_run_cli_records: number;
  first_meeting: {
    id: string;
    action_items: number;
    calendar_drafts: number;
    topic_action: string;
  };
  second_meeting: {
    id: string;
    topic_action: string;
    topic_score: number;
    candidate_meeting_ids: string[];
  };
  third_meeting?: {
    id: string;
    action_items: number;
    calendar_drafts: number;
    topic_action: string;
    matched_kb_id: string | null;
  };
}

export interface RunFullP0DemoOptions {
  baseUrl?: string;
  outputDir?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
  writeOutputs?: boolean;
  mode?: DemoMode;
  recipient?: string;
  chatId?: string;
  allowDirty?: boolean;
}

export interface RunFullP0DemoResult {
  summary: DemoReportSummary;
  state: StateResponse;
  first: MeetingResponse;
  second: MeetingResponse;
  third?: MeetingResponse;
}

interface DemoContext {
  baseUrl: string;
  outputDir: string;
  latestJsonPath: string;
  reportPath: string;
  fetchFn: typeof fetch;
  log: (message: string) => void;
  writeOutputs: boolean;
  mode: DemoMode;
  recipient?: string;
  chatId?: string;
  allowDirty: boolean;
}

const DEFAULT_BASE_URL = process.env.MEETING_ATLAS_BASE_URL ?? "http://127.0.0.1:3000";
const CONTENT_TYPE_JSON = { "Content-Type": "application/json" };
const DEFAULT_DEMO_OUTPUT_DIR = join(process.cwd(), "demo-output");
const CLEAN_DATABASE_SERVICE_COMMAND =
  "PORT=3000 SQLITE_PATH=/tmp/meeting-atlas-demo-$(date +%s).db FEISHU_DRY_RUN=true FEISHU_CARD_SEND_DRY_RUN=true LLM_PROVIDER=mock npm run dev";

const FIRST_MEETING_TRANSCRIPT = `
会议主题：无人机操作方案初步访谈
会议时间：2026-04-28 10:00 - 11:00
参会人：张三、李四、Henry

Henry：今天我们做无人机操作方案真实 LLM 测试，
沿用无人机操作方案初步访谈场景，目标是调研无人机当前操作流程和试飞权限。
张三：现在流程散在几个人脑子里，我可以整理现有操作流程，2026-05-01 前给大家看。
李四：我这边去确认试飞场地权限，看看审批需要哪些材料。
Henry：好。下周二上午 10 点我们再约操作员访谈，重点确认真实操作步骤和限制。
张三：资料上可以先参考“无人机安全规范”。
Henry：今天先调研流程，不急着做技术方案。
`.trim();

const SECOND_MEETING_TRANSCRIPT = `
会议主题：无人机操作员访谈
会议时间：2026-04-29 10:00 - 11:00
参会人：张三、王五、Henry

Henry：这次继续讨论无人机操作方案，
重点看操作员视角下的操作流程、试飞权限和风险控制。
王五：现在操作流程不统一，试飞前权限确认也比较分散。
Henry：我们需要建立统一无人机操作 SOP，把操作流程、权限审批和风险控制串起来。
王五：我负责在 2026-05-03 前整理风险清单，
把试飞权限、天气、电池状态和现场安全员都列出来。
张三：上次提到的无人机安全规范也要继续参考。
Henry：后续要把这两次访谈整理成一个无人机操作方案知识库。
`.trim();

const THIRD_MEETING_TRANSCRIPT = `
会议主题：无人机实施风险评审
会议时间：2026-05-03 10:00 - 11:00
参会人：张三、李四、王五、Henry

Henry：这次继续围绕无人机操作方案做风险评审，前两次访谈已经沉淀成知识库了。
张三：操作流程已经有第一版，但试飞权限还没有完全确认。
李四：试飞前必须确认场地权限、现场安全员和电池状态，我负责在 2026-05-06 前确认试飞权限。
王五：风险控制这块要追加到已有的无人机操作方案知识库，尤其是天气、电池状态和现场安全员。
Henry：好，这场会议结束后加入已有知识库，不要再新建一个。
`.trim();

const EDITED_SECOND_ACTION = {
  title: "确认无人机试飞场地权限并输出审批说明",
  owner: "王五",
  due_date: "2026-05-02",
  priority: "P0"
};

const EDITED_CALENDAR = {
  participants: ["张三", "李四", "王五"],
  duration_minutes: 60,
  location: "线上会议"
};

const KNOWLEDGE_BASE_ACTION_PATTERNS = [
  /创建.{0,12}知识库/,
  /整理.{0,12}知识库/,
  /归档到.{0,12}知识库/,
  /建立.{0,12}知识库/
];
const ACTION_CARD_ACTION_KEYS = [
  "confirm",
  "confirm_with_edits",
  "reject",
  "not_mine",
  "remind_later"
];
const CALENDAR_CARD_ACTION_KEYS = [
  "confirm",
  "confirm_with_edits",
  "reject",
  "convert_to_task",
  "remind_later"
];
const CREATE_KB_CARD_ACTION_KEYS = [
  "create_kb",
  "edit_and_create",
  "append_current_only",
  "reject",
  "never_remind_topic"
];
const APPEND_MEETING_CARD_ACTION_KEYS = ["confirm", "reject"];
const DEFAULT_CARD_ACTION_KEYS = ["confirm", "reject"];
const TERMINAL_CONFIRMATION_STATUSES = new Set(["executed", "rejected", "failed"]);

function getDemoOutputStem(mode: DemoMode): string {
  switch (mode) {
    case "full-p0":
      return "p0-demo";
    case "cards-only":
      return "cards-only-demo";
    case "send-cards":
      return "send-cards-demo";
  }
}

function createDemoContext(options: RunFullP0DemoOptions): DemoContext {
  const outputDir = options.outputDir ?? DEFAULT_DEMO_OUTPUT_DIR;
  const mode = options.mode ?? "full-p0";
  const outputStem = getDemoOutputStem(mode);

  return {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    outputDir,
    latestJsonPath: join(outputDir, `${outputStem}-latest.json`),
    reportPath: join(outputDir, `${outputStem}-report.md`),
    fetchFn: options.fetchFn ?? fetch,
    log: options.log ?? ((message) => console.log(message)),
    writeOutputs: options.writeOutputs ?? true,
    mode,
    recipient: options.recipient,
    chatId: options.chatId,
    allowDirty: options.allowDirty ?? false
  };
}

function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function step(context: DemoContext, message: string): void {
  context.log(`\n[step] ${message}`);
}

function ok(context: DemoContext, message: string): void {
  context.log(`[ok] ${message}`);
}

function isKnowledgeBaseActionText(input: {
  title?: string;
  description?: string | null;
}): boolean {
  const text = `${input.title ?? ""} ${input.description ?? ""}`;
  return KNOWLEDGE_BASE_ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isKnowledgeBaseActionConfirmation(request: ConfirmationRequest): boolean {
  try {
    const payload = JSON.parse(request.original_payload_json) as {
      draft?: {
        title?: string;
        description?: string | null;
      };
    };
    return isKnowledgeBaseActionText(payload.draft ?? {});
  } catch {
    return false;
  }
}

async function requestJson<T>(
  context: DemoContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  let response: Response;
  try {
    response = await context.fetchFn(`${context.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : CONTENT_TYPE_JSON,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach MeetingAtlas at ${context.baseUrl}. ` +
        `Start the service first, then rerun the demo. ${detail}`
    );
  }

  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${text}`);
  }

  return parsed as T;
}

async function getHealth(context: DemoContext): Promise<HealthResponse> {
  step(context, "GET /health");
  const health = await requestJson<HealthResponse>(context, "GET", "/health");
  assertDemo(health.ok === true, "Health check did not return ok=true");
  assertDemo(
    health.dry_run === true,
    "Demo requires FEISHU_DRY_RUN=true; refusing to run against real write mode"
  );
  ok(
    context,
    [
      `service=${health.service}`,
      `dry_run=${health.dry_run}`,
      `card_send_dry_run=${health.card_send_dry_run}`,
      `sqlite=${health.sqlite_path}`
    ].join(", ")
  );
  return health;
}

function getCleanStateCounts(state: StateResponse): Array<[string, number]> {
  return [
    ["meetings", state.meetings.length],
    ["action_items", state.action_items.length],
    ["calendar_drafts", state.calendar_drafts.length],
    ["knowledge_bases", state.knowledge_bases.length],
    ["confirmation_requests", state.confirmation_requests.length]
  ];
}

function formatStateCounts(counts: Array<[string, number]>): string {
  return counts.map(([name, count]) => `${name}=${count}`).join("\n");
}

function formatDirtyDatabaseError(state: StateResponse): string {
  return [
    "Demo requires a clean dry-run database.",
    "",
    "Current state:",
    formatStateCounts(getCleanStateCounts(state)),
    "",
    "Start a clean service with:",
    CLEAN_DATABASE_SERVICE_COMMAND,
    "",
    "For development debugging only, rerun with --allow-dirty to bypass this guard."
  ].join("\n");
}

async function assertCleanDatabase(context: DemoContext): Promise<StateResponse> {
  step(context, "GET /dev/state (clean database check)");
  const state = await requestJson<StateResponse>(context, "GET", "/dev/state");
  const counts = getCleanStateCounts(state);
  const isClean = counts.every(([, count]) => count === 0);

  if (!isClean && !context.allowDirty) {
    throw new Error(formatDirtyDatabaseError(state));
  }

  ok(
    context,
    isClean
      ? "clean dry-run database verified"
      : `dirty database allowed by --allow-dirty (${counts
          .map(([name, count]) => `${name}=${count}`)
          .join(", ")})`
  );
  return state;
}

async function submitMeeting(
  context: DemoContext,
  payload: {
    title: string;
    participants: string[];
    organizer: string;
    started_at: string;
    ended_at: string;
    transcript_text: string;
  }
): Promise<MeetingResponse> {
  step(context, `POST /dev/meetings/manual (${payload.title})`);
  const result = await requestJson<MeetingResponse>(
    context,
    "POST",
    "/dev/meetings/manual",
    payload
  );
  ok(
    context,
    [
      `meeting=${result.meeting_id}`,
      `confirmations=${result.confirmation_requests.length}`,
      `topic=${result.topic_match.suggested_action}/${result.topic_match.score}`
    ].join(", ")
  );
  return result;
}

async function listConfirmations(context: DemoContext): Promise<ConfirmationRequest[]> {
  step(context, "GET /dev/confirmations");
  const confirmations = await requestJson<ConfirmationRequest[]>(
    context,
    "GET",
    "/dev/confirmations"
  );
  const cardCount = confirmations.filter(
    (confirmation) => confirmation.dry_run_card?.dry_run === true
  ).length;
  assertDemo(
    cardCount === confirmations.length,
    "Every confirmation should include a dry-run card"
  );
  const actionableConfirmations = confirmations.filter((confirmation) =>
    ["draft", "sent", "edited", "failed"].includes(confirmation.status)
  );
  const missingActionButtons = actionableConfirmations.flatMap((confirmation) => {
    const actionKeys = confirmation.dry_run_card?.actions.map((action) => action.key) ?? [];
    const expectedKeys =
      confirmation.request_type === "action"
        ? ACTION_CARD_ACTION_KEYS
        : confirmation.request_type === "calendar"
          ? CALENDAR_CARD_ACTION_KEYS
          : confirmation.request_type === "create_kb"
            ? CREATE_KB_CARD_ACTION_KEYS
            : confirmation.request_type === "append_meeting"
              ? APPEND_MEETING_CARD_ACTION_KEYS
              : DEFAULT_CARD_ACTION_KEYS;
    const missing = expectedKeys.filter((key) => !actionKeys.includes(key));
    return missing.length > 0
      ? [`${confirmation.id}/${confirmation.request_type}: missing ${missing.join(",")}`]
      : [];
  });
  assertDemo(
    missingActionButtons.length === 0,
    `Dry-run cards should include the expected action buttons: ${missingActionButtons.join("; ")}`
  );
  ok(context, `confirmations=${confirmations.length}, dry_run_cards=${cardCount}`);
  return confirmations;
}

async function listCards(context: DemoContext): Promise<DryRunCardPreview[]> {
  step(context, "GET /dev/cards");
  const cards = await requestJson<DryRunCardPreview[]>(context, "GET", "/dev/cards");
  assertDemo(
    cards.every((card) => card.dry_run === true),
    "Every /dev/cards item should be a dry-run card"
  );
  ok(context, `cards=${cards.length}`);
  return cards;
}

function formatCardSendFailure(result: SendCardsResponse): string {
  const firstFailed = result.results.find((item) => item.status === "failed" || item.error);
  return [
    "Card send reported failed sends.",
    "Check /dev/state cli_runs for lark.im.send_card stderr/error.",
    `Failed count: ${result.failed}`,
    `First failed confirmation_id: ${firstFailed?.confirmation_id ?? "unknown"}`,
    `First failed card_type: ${firstFailed?.card_type ?? "unknown"}`,
    `First failed card send error: ${firstFailed?.error ?? "unknown error"}`
  ].join("\n");
}

async function sendAllCards(
  context: DemoContext,
  health: HealthResponse
): Promise<SendCardsResponse> {
  const body =
    context.chatId !== undefined
      ? { chat_id: context.chatId }
      : context.recipient !== undefined
        ? { recipient: context.recipient }
        : undefined;
  step(context, "POST /dev/cards/send-all");
  const result = await requestJson<SendCardsResponse>(context, "POST", "/dev/cards/send-all", body);
  assertDemo(result.ok === true, formatCardSendFailure(result));

  if (health.card_send_dry_run) {
    assertDemo(result.total === result.planned, "All card sends should be planned in dry-run mode");
    assertDemo(
      result.results.every((item) => item.dry_run === true && item.cli_run_id !== null),
      "Every dry-run card send should record a cli_run"
    );
    ok(context, `dry-run card sends planned=${result.planned}, failed=${result.failed}`);
  } else {
    assertDemo(
      result.total === result.sent,
      "All card sends should be sent when FEISHU_CARD_SEND_DRY_RUN=false"
    );
    assertDemo(
      result.results.every((item) => item.dry_run === false && item.cli_run_id !== null),
      "Every real card send should record a cli_run"
    );
    ok(context, `real card sends sent=${result.sent}, failed=${result.failed}`);
  }

  return result;
}

async function confirmRequest(
  context: DemoContext,
  id: string,
  editedPayload?: unknown
): Promise<ConfirmResponse> {
  const body = editedPayload === undefined ? {} : { edited_payload: editedPayload };
  step(context, `POST /dev/confirmations/${id}/confirm`);
  const result = await requestJson<ConfirmResponse>(
    context,
    "POST",
    `/dev/confirmations/${id}/confirm`,
    body
  );
  assertDemo(
    result.confirmation.status === "executed",
    `Confirmation ${id} did not execute; status=${result.confirmation.status}`
  );
  ok(context, `executed ${result.confirmation.request_type} confirmation ${id}`);
  return result;
}

async function getState(context: DemoContext): Promise<StateResponse> {
  step(context, "GET /dev/state");
  const state = await requestJson<StateResponse>(context, "GET", "/dev/state");
  ok(
    context,
    [
      `meetings=${state.meetings.length}`,
      `actions=${state.action_items.length}`,
      `calendars=${state.calendar_drafts.length}`,
      `knowledge_bases=${state.knowledge_bases.length}`,
      `cli_runs=${state.cli_runs.length}`
    ].join(", ")
  );
  return state;
}

function requestsForMeeting(
  result: MeetingResponse,
  confirmations: ConfirmationRequest[],
  requestType: ConfirmationRequestType
): ConfirmationRequest[] {
  const ids = new Set(result.confirmation_requests);
  return confirmations.filter(
    (confirmation) => ids.has(confirmation.id) && confirmation.request_type === requestType
  );
}

function cardsForMeeting(
  result: MeetingResponse,
  cards: DryRunCardPreview[],
  cardType: string
): DryRunCardPreview[] {
  const ids = new Set(result.confirmation_requests);
  return cards.filter((card) => ids.has(card.request_id) && card.card_type === cardType);
}

function pendingConfirmations(state: StateResponse): ConfirmationRequest[] {
  return state.confirmation_requests.filter(
    (confirmation) => !TERMINAL_CONFIRMATION_STATUSES.has(confirmation.status)
  );
}

function buildReportSummary(input: {
  context: DemoContext;
  health: HealthResponse;
  first: MeetingResponse;
  second: MeetingResponse;
  third: MeetingResponse;
  confirmedActionIds: string[];
  confirmedCalendarIds: string[];
  confirmedCreateKbId: string;
  confirmedAppendMeetingId: string;
  cardStats: {
    actionCards: number;
    calendarCards: number;
    knowledgeBaseCards: number;
    appendMeetingCards: number;
  };
  state: StateResponse;
}): DemoReportSummary {
  const dryRunCliCount = input.state.cli_runs.filter((run) => run.dry_run === 1).length;
  const cardSendCliCount = input.state.cli_runs.filter(
    (run) => run.tool === "lark.im.send_card"
  ).length;
  const latestKnowledgeBase = input.state.knowledge_bases.at(-1);
  const latestKnowledgeUpdate = input.state.knowledge_updates.at(-1);
  const pending = pendingConfirmations(input.state);

  return {
    status: "passed",
    mode: input.context.mode,
    generated_at: new Date().toISOString(),
    base_url: input.context.baseUrl,
    llm_provider: input.health.llm_provider,
    feishu_write_mode: "dry-run",
    dry_run_note: "FEISHU_DRY_RUN=true; this demo did not perform real Feishu writes.",
    meetings_processed: 3,
    action_confirmations_executed: input.confirmedActionIds.length,
    calendar_confirmations_executed: input.confirmedCalendarIds.length,
    knowledge_base_confirmations_executed: 1,
    append_meeting_confirmations_executed: 1,
    card_previews_generated:
      input.cardStats.actionCards +
      input.cardStats.calendarCards +
      input.cardStats.knowledgeBaseCards +
      input.cardStats.appendMeetingCards,
    action_cards: input.cardStats.actionCards,
    calendar_cards: input.cardStats.calendarCards,
    knowledge_base_cards: input.cardStats.knowledgeBaseCards,
    append_meeting_cards: input.cardStats.appendMeetingCards,
    card_send_cli_records: cardSendCliCount,
    knowledge_base_name: latestKnowledgeBase?.name ?? "n/a",
    knowledge_base_url: latestKnowledgeBase?.wiki_url ?? latestKnowledgeBase?.homepage_url ?? "n/a",
    knowledge_update: latestKnowledgeUpdate?.update_type ?? "n/a",
    knowledge_updates: input.state.knowledge_updates.map((update) => update.update_type),
    pending_confirmations: pending.length,
    pending_confirmation_ids: pending.map((confirmation) => confirmation.id),
    dry_run_cli_records: dryRunCliCount,
    first_meeting: {
      id: input.first.meeting_id,
      action_items: input.first.extraction.action_items.length,
      calendar_drafts: input.first.extraction.calendar_drafts.length,
      topic_action: input.first.topic_match.suggested_action
    },
    second_meeting: {
      id: input.second.meeting_id,
      topic_action: input.second.topic_match.suggested_action,
      topic_score: input.second.topic_match.score,
      candidate_meeting_ids: input.second.topic_match.candidate_meeting_ids
    },
    third_meeting: {
      id: input.third.meeting_id,
      action_items: input.third.extraction.action_items.length,
      calendar_drafts: input.third.extraction.calendar_drafts.length,
      topic_action: input.third.topic_match.suggested_action,
      matched_kb_id: input.third.topic_match.matched_kb_id ?? null
    }
  };
}

function buildCardPhaseReportSummary(input: {
  context: DemoContext;
  health: HealthResponse;
  first: MeetingResponse;
  second: MeetingResponse;
  cards: DryRunCardPreview[];
  state: StateResponse;
}): DemoReportSummary {
  const dryRunCliCount = input.state.cli_runs.filter((run) => run.dry_run === 1).length;
  const cardSendCliCount = input.state.cli_runs.filter(
    (run) => run.tool === "lark.im.send_card"
  ).length;
  const pending = pendingConfirmations(input.state);

  return {
    status: "passed",
    mode: input.context.mode,
    generated_at: new Date().toISOString(),
    base_url: input.context.baseUrl,
    llm_provider: input.health.llm_provider,
    feishu_write_mode: "dry-run",
    dry_run_note:
      input.context.mode === "send-cards"
        ? input.health.card_send_dry_run
          ? "FEISHU_DRY_RUN=true; this demo dry-run sends confirmation cards only and does not execute confirmations."
          : "FEISHU_DRY_RUN=true; this demo sends real Feishu confirmation cards only and does not execute confirmations."
        : "FEISHU_DRY_RUN=true; this demo generates confirmation cards only and does not execute confirmations.",
    meetings_processed: 2,
    action_confirmations_executed: 0,
    calendar_confirmations_executed: 0,
    knowledge_base_confirmations_executed: 0,
    append_meeting_confirmations_executed: 0,
    card_previews_generated: input.cards.length,
    action_cards: input.cards.filter((card) => card.card_type === "action_confirmation").length,
    calendar_cards: input.cards.filter((card) => card.card_type === "calendar_confirmation").length,
    knowledge_base_cards: input.cards.filter((card) => card.card_type === "create_kb_confirmation")
      .length,
    append_meeting_cards: input.cards.filter((card) => card.card_type === "generic_confirmation")
      .length,
    card_send_cli_records: cardSendCliCount,
    knowledge_base_name: "n/a",
    knowledge_base_url: "n/a",
    knowledge_update: "n/a",
    knowledge_updates: [],
    pending_confirmations: pending.length,
    pending_confirmation_ids: pending.map((confirmation) => confirmation.id),
    dry_run_cli_records: dryRunCliCount,
    first_meeting: {
      id: input.first.meeting_id,
      action_items: input.first.extraction.action_items.length,
      calendar_drafts: input.first.extraction.calendar_drafts.length,
      topic_action: input.first.topic_match.suggested_action
    },
    second_meeting: {
      id: input.second.meeting_id,
      topic_action: input.second.topic_match.suggested_action,
      topic_score: input.second.topic_match.score,
      candidate_meeting_ids: input.second.topic_match.candidate_meeting_ids
    }
  };
}

function formatTerminalReport(summary: DemoReportSummary): string {
  return [
    "",
    "✅ MeetingAtlas P0 Demo passed",
    "",
    `Mode: ${summary.mode}`,
    `LLM Provider: ${summary.llm_provider}`,
    `Feishu Write Mode: ${summary.feishu_write_mode}`,
    `Mode note: ${summary.dry_run_note}`,
    `Meetings processed: ${summary.meetings_processed}`,
    `Action confirmations executed: ${summary.action_confirmations_executed}`,
    `Calendar confirmations executed: ${summary.calendar_confirmations_executed}`,
    `Knowledge base confirmations executed: ${summary.knowledge_base_confirmations_executed}`,
    `Append meeting confirmations executed: ${summary.append_meeting_confirmations_executed}`,
    `Card previews generated: ${summary.card_previews_generated}`,
    `Action cards: ${summary.action_cards}`,
    `Calendar cards: ${summary.calendar_cards}`,
    `Knowledge base cards: ${summary.knowledge_base_cards}`,
    `Append meeting cards: ${summary.append_meeting_cards}`,
    `Card send CLI records: ${summary.card_send_cli_records}`,
    `Knowledge base name: ${summary.knowledge_base_name}`,
    `Knowledge base URL: ${summary.knowledge_base_url}`,
    `Knowledge update: ${summary.knowledge_update}`,
    `Pending confirmations: ${summary.pending_confirmations}`,
    `Dry-run CLI records: ${summary.dry_run_cli_records}`
  ].join("\n");
}

function getMarkdownReportTitle(mode: DemoMode): string {
  switch (mode) {
    case "full-p0":
      return "MeetingAtlas P0 Demo Report";
    case "cards-only":
      return "MeetingAtlas Cards-only Demo Report";
    case "send-cards":
      return "MeetingAtlas Send-cards Demo Report";
  }
}

function formatMarkdownReport(summary: DemoReportSummary): string {
  return [
    `# ${getMarkdownReportTitle(summary.mode)}`,
    "",
    "✅ MeetingAtlas P0 Demo passed",
    "",
    `- Generated at: ${summary.generated_at}`,
    `- Mode: ${summary.mode}`,
    `- Base URL: ${summary.base_url}`,
    `- LLM Provider: ${summary.llm_provider}`,
    `- Feishu Write Mode: ${summary.feishu_write_mode}`,
    `- Mode note: ${summary.dry_run_note}`,
    `- Meetings processed: ${summary.meetings_processed}`,
    `- Action confirmations executed: ${summary.action_confirmations_executed}`,
    `- Calendar confirmations executed: ${summary.calendar_confirmations_executed}`,
    `- Knowledge base confirmations executed: ${summary.knowledge_base_confirmations_executed}`,
    `- Append meeting confirmations executed: ${summary.append_meeting_confirmations_executed}`,
    `- Card previews generated: ${summary.card_previews_generated}`,
    `- Action cards: ${summary.action_cards}`,
    `- Calendar cards: ${summary.calendar_cards}`,
    `- Knowledge base cards: ${summary.knowledge_base_cards}`,
    `- Append meeting cards: ${summary.append_meeting_cards}`,
    `- Card send CLI records: ${summary.card_send_cli_records}`,
    `- Knowledge base name: ${summary.knowledge_base_name}`,
    `- Knowledge base URL: ${summary.knowledge_base_url}`,
    `- Knowledge update: ${summary.knowledge_update}`,
    `- Knowledge updates: ${summary.knowledge_updates.join(" -> ") || "n/a"}`,
    `- Pending confirmations: ${summary.pending_confirmations}`,
    `- Pending confirmation IDs: ${summary.pending_confirmation_ids.join(", ") || "none"}`,
    `- Dry-run CLI records: ${summary.dry_run_cli_records}`,
    "",
    "## Topic Flow",
    "",
    `- First meeting: ${summary.first_meeting.id}`,
    `- First topic action: ${summary.first_meeting.topic_action}`,
    [
      `- First extraction: actions=${summary.first_meeting.action_items}`,
      `calendars=${summary.first_meeting.calendar_drafts}`
    ].join(", "),
    `- Second meeting: ${summary.second_meeting.id}`,
    `- Second topic action: ${summary.second_meeting.topic_action}`,
    `- Second topic score: ${summary.second_meeting.topic_score}`,
    `- Candidate meetings: ${summary.second_meeting.candidate_meeting_ids.join(", ")}`,
    ...(summary.third_meeting
      ? [
          `- Third meeting: ${summary.third_meeting.id}`,
          `- Third topic action: ${summary.third_meeting.topic_action}`,
          `- Third matched knowledge base: ${summary.third_meeting.matched_kb_id ?? "n/a"}`,
          [
            `- Third extraction: actions=${summary.third_meeting.action_items}`,
            `calendars=${summary.third_meeting.calendar_drafts}`
          ].join(", ")
        ]
      : []),
    "",
    "## Product Story",
    "",
    "- Meeting 1 creates personal action and calendar confirmation cards.",
    "- Meeting 2 detects a repeated drone-operation topic and creates the knowledge base after confirmation.",
    "- Meeting 3 matches the existing knowledge base and appends a meeting update after confirmation.",
    "",
    "## Safety Notes",
    "",
    "- Current run is dry-run only; no real Feishu writes were performed.",
    "- This report intentionally does not include API keys, secrets, or `.env` contents.",
    ""
  ].join("\n");
}

async function writeDemoOutputs(context: DemoContext, summary: DemoReportSummary): Promise<void> {
  if (!context.writeOutputs) {
    return;
  }

  await mkdir(context.outputDir, { recursive: true });
  await writeFile(context.latestJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(context.reportPath, formatMarkdownReport(summary), "utf8");
  ok(context, `wrote ${context.latestJsonPath}`);
  ok(context, `wrote ${context.reportPath}`);
}

async function runCardPhaseDemo(options: RunFullP0DemoOptions): Promise<RunFullP0DemoResult> {
  const context = createDemoContext(options);
  const health = await getHealth(context);
  await assertCleanDatabase(context);

  const first = await submitMeeting(context, {
    title: "无人机操作方案真实 LLM 测试",
    participants: ["张三", "李四"],
    organizer: "张三",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    transcript_text: FIRST_MEETING_TRANSCRIPT
  });
  assertDemo(
    first.extraction.action_items.length >= 2,
    "First meeting should extract at least two action items"
  );
  assertDemo(
    first.extraction.calendar_drafts.length >= 1,
    "First meeting should extract at least one calendar draft"
  );
  assertDemo(first.topic_match.suggested_action === "observe", "First meeting should be observe");

  const firstConfirmations = await listConfirmations(context);
  const actionRequests = requestsForMeeting(first, firstConfirmations, "action");
  const calendarRequests = requestsForMeeting(first, firstConfirmations, "calendar");
  const firstCards = await listCards(context);
  const firstActionCards = cardsForMeeting(first, firstCards, "action_confirmation");
  const firstCalendarCards = cardsForMeeting(first, firstCards, "calendar_confirmation");
  assertDemo(
    actionRequests.length >= 2,
    "First meeting should create at least two action confirmations"
  );
  assertDemo(
    calendarRequests.length >= 1,
    "First meeting should create at least one calendar confirmation"
  );
  assertDemo(firstActionCards.length >= 2, "First meeting should expose action cards");
  assertDemo(firstCalendarCards.length >= 1, "First meeting should expose calendar cards");

  const second = await submitMeeting(context, {
    title: "无人机操作员访谈",
    participants: ["张三", "王五"],
    organizer: "张三",
    started_at: "2026-04-29T10:00:00+08:00",
    ended_at: "2026-04-29T11:00:00+08:00",
    transcript_text: SECOND_MEETING_TRANSCRIPT
  });
  assertDemo(
    second.topic_match.score >= 0.9,
    `Second meeting topic score should be >= 0.9, got ${second.topic_match.score}`
  );
  assertDemo(
    second.topic_match.suggested_action === "ask_create",
    "Second meeting should suggest ask_create"
  );

  const secondConfirmations = await listConfirmations(context);
  const createKbRequests = requestsForMeeting(second, secondConfirmations, "create_kb");
  const allCards = await listCards(context);
  const secondCreateKbCards = cardsForMeeting(second, allCards, "create_kb_confirmation");
  const duplicateKnowledgeBaseActionRequests = requestsForMeeting(
    second,
    secondConfirmations,
    "action"
  ).filter(isKnowledgeBaseActionConfirmation);
  assertDemo(createKbRequests.length >= 1, "Second meeting should create a create_kb confirmation");
  assertDemo(
    secondCreateKbCards.length === 1,
    `Second meeting should expose exactly one create_kb card, got ${secondCreateKbCards.length}`
  );
  assertDemo(
    duplicateKnowledgeBaseActionRequests.length === 0,
    "Second meeting should not create duplicate action confirmations for knowledge-base creation tasks"
  );

  if (context.mode === "send-cards") {
    await sendAllCards(context, health);
  }

  const state = await getState(context);
  assertDemo(
    state.confirmation_requests.every((request) => request.status === "sent"),
    "Card-only demo should leave confirmation requests unexecuted"
  );
  assertDemo(
    state.knowledge_bases.length === 0,
    "Card-only demo should not create knowledge bases"
  );
  assertDemo(
    state.knowledge_updates.length === 0,
    "Card-only demo should not create knowledge updates"
  );
  assertDemo(
    context.mode === "send-cards"
      ? state.cli_runs.filter((run) => run.tool === "lark.im.send_card").length === allCards.length
      : state.cli_runs.length === 0,
    "Card-only mode should only record card-send CLI runs when requested"
  );

  const summary = buildCardPhaseReportSummary({
    context,
    health,
    first,
    second,
    cards: allCards,
    state
  });
  await writeDemoOutputs(context, summary);

  return {
    summary,
    state,
    first,
    second
  };
}

export async function runFullP0Demo(
  options: RunFullP0DemoOptions = {}
): Promise<RunFullP0DemoResult> {
  if (options.mode === "cards-only" || options.mode === "send-cards") {
    return runCardPhaseDemo(options);
  }

  const context = createDemoContext(options);
  const health = await getHealth(context);
  await assertCleanDatabase(context);

  const first = await submitMeeting(context, {
    title: "无人机操作方案真实 LLM 测试",
    participants: ["张三", "李四"],
    organizer: "张三",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    transcript_text: FIRST_MEETING_TRANSCRIPT
  });
  assertDemo(
    first.extraction.action_items.length >= 2,
    "First meeting should extract at least two action items"
  );
  assertDemo(
    first.extraction.calendar_drafts.length >= 1,
    "First meeting should extract at least one calendar draft"
  );
  assertDemo(
    first.topic_match.suggested_action === "observe",
    [
      "First meeting should be observe.",
      "If this service already has related drone meetings,",
      "restart it with a fresh SQLITE_PATH for the demo."
    ].join(" ")
  );
  ok(context, "first meeting extraction and observe state verified");

  const firstConfirmations = await listConfirmations(context);
  const actionRequests = requestsForMeeting(first, firstConfirmations, "action");
  const calendarRequests = requestsForMeeting(first, firstConfirmations, "calendar");
  const firstCards = await listCards(context);
  const firstActionCards = cardsForMeeting(first, firstCards, "action_confirmation");
  const firstCalendarCards = cardsForMeeting(first, firstCards, "calendar_confirmation");
  assertDemo(
    actionRequests.length >= 2,
    "First meeting should create at least two action confirmations"
  );
  assertDemo(
    calendarRequests.length >= 1,
    "First meeting should create at least one calendar confirmation"
  );
  assertDemo(
    firstActionCards.length >= 2,
    `First meeting should create at least two action cards, got ${firstActionCards.length}`
  );
  assertDemo(
    firstCalendarCards.length >= 1,
    `First meeting should create at least one calendar card, got ${firstCalendarCards.length}`
  );
  ok(
    context,
    `first meeting card previews verified: action=${firstActionCards.length}, calendar=${firstCalendarCards.length}`
  );

  const confirmedActionIds: string[] = [];
  const confirmedCalendarIds: string[] = [];

  for (const [index, request] of actionRequests.entries()) {
    await confirmRequest(context, request.id, index === 1 ? EDITED_SECOND_ACTION : undefined);
    confirmedActionIds.push(request.id);
  }
  for (const [index, request] of calendarRequests.entries()) {
    await confirmRequest(context, request.id, index === 0 ? EDITED_CALENDAR : undefined);
    confirmedCalendarIds.push(request.id);
  }

  const second = await submitMeeting(context, {
    title: "无人机操作员访谈",
    participants: ["张三", "王五"],
    organizer: "张三",
    started_at: "2026-04-29T10:00:00+08:00",
    ended_at: "2026-04-29T11:00:00+08:00",
    transcript_text: SECOND_MEETING_TRANSCRIPT
  });
  assertDemo(
    second.topic_match.score >= 0.9,
    `Second meeting topic score should be >= 0.9, got ${second.topic_match.score}`
  );
  assertDemo(
    second.topic_match.suggested_action === "ask_create",
    "Second meeting should suggest ask_create"
  );
  assertDemo(
    second.topic_match.candidate_meeting_ids.length >= 2,
    "Second meeting should have at least two candidate meetings"
  );
  assertDemo(
    second.topic_match.candidate_meeting_ids.includes(first.meeting_id) &&
      second.topic_match.candidate_meeting_ids.includes(second.meeting_id),
    "Second meeting candidates should include both first and second meetings"
  );
  ok(context, "second meeting topic clustering and create_kb suggestion verified");

  const secondConfirmations = await listConfirmations(context);
  const createKbRequests = requestsForMeeting(second, secondConfirmations, "create_kb");
  const secondActionRequests = requestsForMeeting(second, secondConfirmations, "action");
  const secondCalendarRequests = requestsForMeeting(second, secondConfirmations, "calendar");
  const secondCards = await listCards(context);
  const secondActionCards = cardsForMeeting(second, secondCards, "action_confirmation");
  const secondCalendarCards = cardsForMeeting(second, secondCards, "calendar_confirmation");
  const secondCreateKbCards = cardsForMeeting(second, secondCards, "create_kb_confirmation");
  const duplicateKnowledgeBaseActionRequests = requestsForMeeting(
    second,
    secondConfirmations,
    "action"
  ).filter(isKnowledgeBaseActionConfirmation);
  assertDemo(createKbRequests.length >= 1, "Second meeting should create a create_kb confirmation");
  assertDemo(
    secondCreateKbCards.length === 1,
    `Second meeting should expose exactly one create_kb card, got ${secondCreateKbCards.length}`
  );
  assertDemo(
    secondActionCards.length === secondActionRequests.length,
    "Second meeting action cards should match action confirmations"
  );
  assertDemo(
    secondCalendarCards.length === secondCalendarRequests.length,
    "Second meeting calendar cards should match calendar confirmations"
  );
  assertDemo(
    duplicateKnowledgeBaseActionRequests.length === 0,
    "Second meeting should not create duplicate action confirmations for knowledge-base creation tasks"
  );
  for (const request of secondActionRequests) {
    await confirmRequest(context, request.id);
    confirmedActionIds.push(request.id);
  }
  for (const request of secondCalendarRequests) {
    await confirmRequest(context, request.id);
    confirmedCalendarIds.push(request.id);
  }
  await confirmRequest(context, createKbRequests[0].id);

  const third = await submitMeeting(context, {
    title: "无人机实施风险评审",
    participants: ["张三", "李四", "王五"],
    organizer: "张三",
    started_at: "2026-05-03T10:00:00+08:00",
    ended_at: "2026-05-03T11:00:00+08:00",
    transcript_text: THIRD_MEETING_TRANSCRIPT
  });
  assertDemo(
    third.topic_match.suggested_action === "ask_append",
    `Third meeting should suggest ask_append, got ${third.topic_match.suggested_action}`
  );
  assertDemo(
    typeof third.topic_match.matched_kb_id === "string" &&
      third.topic_match.matched_kb_id.length > 0,
    "Third meeting should match the existing knowledge base"
  );
  ok(context, "third meeting matched existing knowledge base and suggested append verified");

  const thirdConfirmations = await listConfirmations(context);
  const thirdActionRequests = requestsForMeeting(third, thirdConfirmations, "action");
  const thirdCalendarRequests = requestsForMeeting(third, thirdConfirmations, "calendar");
  const appendMeetingRequests = requestsForMeeting(third, thirdConfirmations, "append_meeting");
  const thirdCards = await listCards(context);
  const thirdActionCards = cardsForMeeting(third, thirdCards, "action_confirmation");
  const thirdCalendarCards = cardsForMeeting(third, thirdCards, "calendar_confirmation");
  const appendMeetingCards = cardsForMeeting(third, thirdCards, "append_meeting_confirmation");
  assertDemo(
    thirdActionRequests.length === third.extraction.action_items.length,
    `Third meeting action confirmations should match extracted actions, got ${thirdActionRequests.length}`
  );
  assertDemo(
    thirdCalendarRequests.length === third.extraction.calendar_drafts.length,
    `Third meeting calendar confirmations should match extracted calendars, got ${thirdCalendarRequests.length}`
  );
  assertDemo(
    thirdActionCards.length === thirdActionRequests.length,
    "Third meeting action cards should match action confirmations"
  );
  assertDemo(
    thirdCalendarCards.length === thirdCalendarRequests.length,
    "Third meeting calendar cards should match calendar confirmations"
  );
  assertDemo(
    appendMeetingRequests.length === 1,
    `Third meeting should create one append_meeting confirmation, got ${appendMeetingRequests.length}`
  );
  assertDemo(
    appendMeetingCards.length === 1,
    `Third meeting should expose one append meeting card, got ${appendMeetingCards.length}`
  );
  for (const request of thirdActionRequests) {
    await confirmRequest(context, request.id);
    confirmedActionIds.push(request.id);
  }
  for (const request of thirdCalendarRequests) {
    await confirmRequest(context, request.id);
    confirmedCalendarIds.push(request.id);
  }
  await confirmRequest(context, appendMeetingRequests[0].id);

  const state = await getState(context);
  const latestKnowledgeBase = state.knowledge_bases.at(-1);
  const latestKnowledgeUpdate = state.knowledge_updates.at(-1);
  assertDemo(
    state.knowledge_bases.length >= 1,
    "Final state should include at least one knowledge base"
  );
  assertDemo(
    state.knowledge_updates.length >= 1,
    "Final state should include at least one knowledge update"
  );
  assertDemo(
    latestKnowledgeBase?.name.includes("无人机操作流程主题知识库"),
    "Latest knowledge base name should contain 无人机操作流程主题知识库"
  );
  assertDemo(
    latestKnowledgeBase?.wiki_url?.startsWith("mock://"),
    "Latest knowledge base wiki_url should be a mock:// URL"
  );
  assertDemo(
    latestKnowledgeBase?.homepage_url?.startsWith("mock://"),
    "Latest knowledge base homepage_url should be a mock:// URL"
  );
  assertDemo(
    state.knowledge_updates.some((update) => update.update_type === "kb_created"),
    "Final state should include a kb_created update"
  );
  assertDemo(
    latestKnowledgeUpdate?.update_type === "meeting_added",
    "Latest knowledge update should be meeting_added"
  );
  assertDemo(
    latestKnowledgeUpdate?.after_text?.includes("无人机实施风险评审"),
    "Latest append update should include the third meeting title"
  );
  assertDemo(
    state.cli_runs.some((run) => run.tool === "lark.task.create" && run.dry_run === 1),
    "Final state should include dry-run task CLI records"
  );
  assertDemo(
    state.cli_runs.some((run) => run.tool === "lark.calendar.create" && run.dry_run === 1),
    "Final state should include dry-run calendar CLI records"
  );
  assertDemo(
    state.action_items.some(
      (item) =>
        item.title === EDITED_SECOND_ACTION.title &&
        item.owner === EDITED_SECOND_ACTION.owner &&
        item.due_date === EDITED_SECOND_ACTION.due_date &&
        item.priority === EDITED_SECOND_ACTION.priority
    ),
    "Edited action payload should be persisted in final state"
  );
  assertDemo(
    state.calendar_drafts.some(
      (item) =>
        item.participants_json === JSON.stringify(EDITED_CALENDAR.participants) &&
        item.duration_minutes === EDITED_CALENDAR.duration_minutes &&
        item.location === EDITED_CALENDAR.location
    ),
    "Edited calendar payload should be persisted in final state"
  );
  assertDemo(
    pendingConfirmations(state).length === 0,
    "Full P0 demo should not leave unexpected pending confirmations"
  );

  const summary = buildReportSummary({
    context,
    health,
    first,
    second,
    third,
    confirmedActionIds,
    confirmedCalendarIds,
    confirmedCreateKbId: createKbRequests[0].id,
    confirmedAppendMeetingId: appendMeetingRequests[0].id,
    cardStats: {
      actionCards: firstActionCards.length + secondActionCards.length + thirdActionCards.length,
      calendarCards:
        firstCalendarCards.length + secondCalendarCards.length + thirdCalendarCards.length,
      knowledgeBaseCards: secondCreateKbCards.length,
      appendMeetingCards: appendMeetingCards.length
    },
    state
  });
  await writeDemoOutputs(context, summary);

  return {
    summary,
    state,
    first,
    second,
    third
  };
}

function readArgValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }

  return undefined;
}

function parseDemoMode(args: string[]): DemoMode {
  const cardsOnly = args.includes("--cards-only");
  const sendCards = args.includes("--send-cards");
  if (cardsOnly && sendCards) {
    throw new Error("Use only one of --cards-only or --send-cards");
  }

  if (cardsOnly) {
    return "cards-only";
  }
  if (sendCards) {
    return "send-cards";
  }
  return "full-p0";
}

function parseMainOptions(args: string[]): RunFullP0DemoOptions {
  return {
    mode: parseDemoMode(args),
    recipient: readArgValue(args, "--recipient"),
    chatId: readArgValue(args, "--chat-id"),
    allowDirty: args.includes("--allow-dirty")
  };
}

async function main(): Promise<void> {
  const { summary } = await runFullP0Demo(parseMainOptions(process.argv.slice(2)));
  console.log(formatTerminalReport(summary));
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Demo requires a clean dry-run database.")) {
      console.error(`\n[failed] ${message}`);
    } else {
      console.error("\n[failed] MeetingAtlas P0 demo did not complete.");
      console.error(message);
      console.error("\nStart a clean dry-run service with, for example:");
      console.error(CLEAN_DATABASE_SERVICE_COMMAND);
    }
    process.exit(1);
  });
}
