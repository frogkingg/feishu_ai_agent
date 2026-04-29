import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ConfirmationRequestType = "action" | "calendar" | "create_kb" | "append_meeting" | "archive_source";

export interface HealthResponse {
  ok: boolean;
  service: string;
  dry_run: boolean;
  llm_provider: string;
  sqlite_path: string;
}

export interface TopicMatchResponse {
  score: number;
  match_reasons: string[];
  suggested_action: "no_action" | "observe" | "ask_append" | "ask_create";
  candidate_meeting_ids: string[];
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
  generated_at: string;
  base_url: string;
  llm_provider: string;
  feishu_write_mode: "dry-run";
  dry_run_note: string;
  meetings_processed: number;
  action_confirmations_executed: number;
  calendar_confirmations_executed: number;
  knowledge_base_confirmations_executed: number;
  knowledge_base_name: string;
  knowledge_base_url: string;
  knowledge_update: string;
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
}

export interface RunFullP0DemoOptions {
  baseUrl?: string;
  outputDir?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
  writeOutputs?: boolean;
}

export interface RunFullP0DemoResult {
  summary: DemoReportSummary;
  state: StateResponse;
  first: MeetingResponse;
  second: MeetingResponse;
}

interface DemoContext {
  baseUrl: string;
  outputDir: string;
  latestJsonPath: string;
  reportPath: string;
  fetchFn: typeof fetch;
  log: (message: string) => void;
  writeOutputs: boolean;
}

const DEFAULT_BASE_URL = process.env.MEETING_ATLAS_BASE_URL ?? "http://127.0.0.1:3000";
const CONTENT_TYPE_JSON = { "Content-Type": "application/json" };
const DEFAULT_DEMO_OUTPUT_DIR = join(process.cwd(), "demo-output");

const FIRST_MEETING_TRANSCRIPT = `
会议主题：无人机操作方案初步访谈
会议时间：2026-04-28 10:00 - 11:00
参会人：张三、李四、Henry

Henry：今天我们做无人机操作方案真实 LLM 测试，沿用无人机操作方案初步访谈场景，目标是调研无人机当前操作流程和试飞权限。
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

Henry：这次继续讨论无人机操作方案，重点看操作员视角下的操作流程、试飞权限和风险控制。
王五：现在操作流程不统一，试飞前权限确认也比较分散。
Henry：我们需要建立统一无人机操作 SOP，把操作流程、权限审批和风险控制串起来。
王五：我负责在 2026-05-03 前整理风险清单，把试飞权限、天气、电池状态和现场安全员都列出来。
张三：上次提到的无人机安全规范也要继续参考。
Henry：后续要把这两次访谈整理成一个无人机操作方案知识库。
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

function createDemoContext(options: RunFullP0DemoOptions): DemoContext {
  const outputDir = options.outputDir ?? DEFAULT_DEMO_OUTPUT_DIR;
  return {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    outputDir,
    latestJsonPath: join(outputDir, "p0-demo-latest.json"),
    reportPath: join(outputDir, "p0-demo-report.md"),
    fetchFn: options.fetchFn ?? fetch,
    log: options.log ?? ((message) => console.log(message)),
    writeOutputs: options.writeOutputs ?? true
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

function isKnowledgeBaseActionText(input: { title?: string; description?: string | null }): boolean {
  const text = `${input.title ?? ""} ${input.description ?? ""}`;
  return KNOWLEDGE_BASE_ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isKnowledgeBaseActionConfirmation(request: ConfirmationRequest): boolean {
  try {
    const payload = JSON.parse(request.original_payload_json) as { draft?: { title?: string; description?: string | null } };
    return isKnowledgeBaseActionText(payload.draft ?? {});
  } catch {
    return false;
  }
}

async function requestJson<T>(context: DemoContext, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await context.fetchFn(`${context.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : CONTENT_TYPE_JSON,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(
      `Cannot reach MeetingAtlas at ${context.baseUrl}. Start the service first, then rerun the demo. ${error instanceof Error ? error.message : String(error)}`
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
  assertDemo(health.dry_run === true, "Demo requires FEISHU_DRY_RUN=true; refusing to run against real write mode");
  ok(context, `service=${health.service}, dry_run=${health.dry_run}, sqlite=${health.sqlite_path}`);
  return health;
}

async function submitMeeting(context: DemoContext, payload: {
  title: string;
  participants: string[];
  organizer: string;
  started_at: string;
  ended_at: string;
  transcript_text: string;
}): Promise<MeetingResponse> {
  step(context, `POST /dev/meetings/manual (${payload.title})`);
  const result = await requestJson<MeetingResponse>(context, "POST", "/dev/meetings/manual", payload);
  ok(context, `meeting=${result.meeting_id}, confirmations=${result.confirmation_requests.length}, topic=${result.topic_match.suggested_action}/${result.topic_match.score}`);
  return result;
}

async function listConfirmations(context: DemoContext): Promise<ConfirmationRequest[]> {
  step(context, "GET /dev/confirmations");
  const confirmations = await requestJson<ConfirmationRequest[]>(context, "GET", "/dev/confirmations");
  ok(context, `confirmations=${confirmations.length}`);
  return confirmations;
}

async function confirmRequest(context: DemoContext, id: string, editedPayload?: unknown): Promise<ConfirmResponse> {
  const body = editedPayload === undefined ? {} : { edited_payload: editedPayload };
  step(context, `POST /dev/confirmations/${id}/confirm`);
  const result = await requestJson<ConfirmResponse>(context, "POST", `/dev/confirmations/${id}/confirm`, body);
  assertDemo(result.confirmation.status === "executed", `Confirmation ${id} did not execute; status=${result.confirmation.status}`);
  ok(context, `executed ${result.confirmation.request_type} confirmation ${id}`);
  return result;
}

async function getState(context: DemoContext): Promise<StateResponse> {
  step(context, "GET /dev/state");
  const state = await requestJson<StateResponse>(context, "GET", "/dev/state");
  ok(
    context,
    `meetings=${state.meetings.length}, actions=${state.action_items.length}, calendars=${state.calendar_drafts.length}, knowledge_bases=${state.knowledge_bases.length}, cli_runs=${state.cli_runs.length}`
  );
  return state;
}

function requestsForMeeting(result: MeetingResponse, confirmations: ConfirmationRequest[], requestType: ConfirmationRequestType): ConfirmationRequest[] {
  const ids = new Set(result.confirmation_requests);
  return confirmations.filter((confirmation) => ids.has(confirmation.id) && confirmation.request_type === requestType);
}

function buildReportSummary(input: {
  context: DemoContext;
  health: HealthResponse;
  first: MeetingResponse;
  second: MeetingResponse;
  confirmedActionIds: string[];
  confirmedCalendarIds: string[];
  confirmedCreateKbId: string;
  state: StateResponse;
}): DemoReportSummary {
  const dryRunCliCount = input.state.cli_runs.filter((run) => run.dry_run === 1).length;
  const latestKnowledgeBase = input.state.knowledge_bases.at(-1);
  const latestKnowledgeUpdate = input.state.knowledge_updates.at(-1);

  return {
    status: "passed",
    generated_at: new Date().toISOString(),
    base_url: input.context.baseUrl,
    llm_provider: input.health.llm_provider,
    feishu_write_mode: "dry-run",
    dry_run_note: "FEISHU_DRY_RUN=true; this demo did not perform real Feishu writes.",
    meetings_processed: 2,
    action_confirmations_executed: input.confirmedActionIds.length,
    calendar_confirmations_executed: input.confirmedCalendarIds.length,
    knowledge_base_confirmations_executed: 1,
    knowledge_base_name: latestKnowledgeBase?.name ?? "n/a",
    knowledge_base_url: latestKnowledgeBase?.wiki_url ?? latestKnowledgeBase?.homepage_url ?? "n/a",
    knowledge_update: latestKnowledgeUpdate?.update_type ?? "n/a",
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
    `LLM Provider: ${summary.llm_provider}`,
    `Feishu Write Mode: ${summary.feishu_write_mode}`,
    `Meetings processed: ${summary.meetings_processed}`,
    `Action confirmations executed: ${summary.action_confirmations_executed}`,
    `Calendar confirmations executed: ${summary.calendar_confirmations_executed}`,
    `Knowledge base confirmations executed: ${summary.knowledge_base_confirmations_executed}`,
    `Knowledge base name: ${summary.knowledge_base_name}`,
    `Knowledge base URL: ${summary.knowledge_base_url}`,
    `Knowledge update: ${summary.knowledge_update}`,
    `Dry-run CLI records: ${summary.dry_run_cli_records}`
  ].join("\n");
}

function formatMarkdownReport(summary: DemoReportSummary): string {
  return [
    "# MeetingAtlas P0 Demo Report",
    "",
    "✅ MeetingAtlas P0 Demo passed",
    "",
    `- Generated at: ${summary.generated_at}`,
    `- Base URL: ${summary.base_url}`,
    `- LLM Provider: ${summary.llm_provider}`,
    `- Feishu Write Mode: ${summary.feishu_write_mode}`,
    `- Meetings processed: ${summary.meetings_processed}`,
    `- Action confirmations executed: ${summary.action_confirmations_executed}`,
    `- Calendar confirmations executed: ${summary.calendar_confirmations_executed}`,
    `- Knowledge base confirmations executed: ${summary.knowledge_base_confirmations_executed}`,
    `- Knowledge base name: ${summary.knowledge_base_name}`,
    `- Knowledge base URL: ${summary.knowledge_base_url}`,
    `- Knowledge update: ${summary.knowledge_update}`,
    `- Dry-run CLI records: ${summary.dry_run_cli_records}`,
    "",
    "## Topic Flow",
    "",
    `- First meeting: ${summary.first_meeting.id}`,
    `- First topic action: ${summary.first_meeting.topic_action}`,
    `- First extraction: actions=${summary.first_meeting.action_items}, calendars=${summary.first_meeting.calendar_drafts}`,
    `- Second meeting: ${summary.second_meeting.id}`,
    `- Second topic action: ${summary.second_meeting.topic_action}`,
    `- Second topic score: ${summary.second_meeting.topic_score}`,
    `- Candidate meetings: ${summary.second_meeting.candidate_meeting_ids.join(", ")}`,
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

export async function runFullP0Demo(options: RunFullP0DemoOptions = {}): Promise<RunFullP0DemoResult> {
  const context = createDemoContext(options);
  const health = await getHealth(context);

  const first = await submitMeeting(context, {
    title: "无人机操作方案真实 LLM 测试",
    participants: ["张三", "李四"],
    organizer: "张三",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    transcript_text: FIRST_MEETING_TRANSCRIPT
  });
  assertDemo(first.extraction.action_items.length >= 2, "First meeting should extract at least two action items");
  assertDemo(first.extraction.calendar_drafts.length >= 1, "First meeting should extract at least one calendar draft");
  assertDemo(
    first.topic_match.suggested_action === "observe",
    "First meeting should be observe. If this service already has related drone meetings, restart it with a fresh SQLITE_PATH for the demo."
  );
  ok(context, "first meeting extraction and observe state verified");

  const firstConfirmations = await listConfirmations(context);
  const actionRequests = requestsForMeeting(first, firstConfirmations, "action");
  const calendarRequests = requestsForMeeting(first, firstConfirmations, "calendar");
  assertDemo(actionRequests.length >= 2, "First meeting should create at least two action confirmations");
  assertDemo(calendarRequests.length >= 1, "First meeting should create at least one calendar confirmation");

  await confirmRequest(context, actionRequests[0].id);
  await confirmRequest(context, actionRequests[1].id, EDITED_SECOND_ACTION);
  await confirmRequest(context, calendarRequests[0].id, EDITED_CALENDAR);

  const second = await submitMeeting(context, {
    title: "无人机操作员访谈",
    participants: ["张三", "王五"],
    organizer: "张三",
    started_at: "2026-04-29T10:00:00+08:00",
    ended_at: "2026-04-29T11:00:00+08:00",
    transcript_text: SECOND_MEETING_TRANSCRIPT
  });
  assertDemo(second.topic_match.score >= 0.9, `Second meeting topic score should be >= 0.9, got ${second.topic_match.score}`);
  assertDemo(second.topic_match.suggested_action === "ask_create", "Second meeting should suggest ask_create");
  assertDemo(second.topic_match.candidate_meeting_ids.length >= 2, "Second meeting should have at least two candidate meetings");
  assertDemo(
    second.topic_match.candidate_meeting_ids.includes(first.meeting_id) && second.topic_match.candidate_meeting_ids.includes(second.meeting_id),
    "Second meeting candidates should include both first and second meetings"
  );
  ok(context, "second meeting topic clustering and create_kb suggestion verified");

  const secondConfirmations = await listConfirmations(context);
  const createKbRequests = requestsForMeeting(second, secondConfirmations, "create_kb");
  const duplicateKnowledgeBaseActionRequests = requestsForMeeting(second, secondConfirmations, "action").filter(isKnowledgeBaseActionConfirmation);
  assertDemo(createKbRequests.length >= 1, "Second meeting should create a create_kb confirmation");
  assertDemo(
    duplicateKnowledgeBaseActionRequests.length === 0,
    "Second meeting should not create duplicate action confirmations for knowledge-base creation tasks"
  );
  await confirmRequest(context, createKbRequests[0].id);

  const state = await getState(context);
  const latestKnowledgeBase = state.knowledge_bases.at(-1);
  const latestKnowledgeUpdate = state.knowledge_updates.at(-1);
  assertDemo(state.knowledge_bases.length >= 1, "Final state should include at least one knowledge base");
  assertDemo(state.knowledge_updates.length >= 1, "Final state should include at least one knowledge update");
  assertDemo(latestKnowledgeBase?.name.includes("无人机操作方案"), "Latest knowledge base name should contain 无人机操作方案");
  assertDemo(latestKnowledgeBase?.wiki_url?.startsWith("mock://"), "Latest knowledge base wiki_url should be a mock:// URL");
  assertDemo(latestKnowledgeBase?.homepage_url?.startsWith("mock://"), "Latest knowledge base homepage_url should be a mock:// URL");
  assertDemo(latestKnowledgeUpdate?.update_type === "kb_created", "Latest knowledge update should be kb_created");
  assertDemo(state.cli_runs.some((run) => run.tool === "lark.task.create" && run.dry_run === 1), "Final state should include dry-run task CLI records");
  assertDemo(state.cli_runs.some((run) => run.tool === "lark.calendar.create" && run.dry_run === 1), "Final state should include dry-run calendar CLI records");
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

  const summary = buildReportSummary({
    context,
    health,
    first,
    second,
    confirmedActionIds: [actionRequests[0].id, actionRequests[1].id],
    confirmedCalendarIds: [calendarRequests[0].id],
    confirmedCreateKbId: createKbRequests[0].id,
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

async function main(): Promise<void> {
  const { summary } = await runFullP0Demo();
  console.log(formatTerminalReport(summary));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\n[failed] MeetingAtlas P0 demo did not complete.");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\nStart a clean dry-run service with, for example:");
    console.error("PORT=3000 SQLITE_PATH=/tmp/meeting-atlas-demo.db FEISHU_DRY_RUN=true npm run dev");
    process.exit(1);
  });
}
