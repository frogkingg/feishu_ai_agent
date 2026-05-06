import { execFileSync } from "node:child_process";
import { createDatabase } from "../src/services/store/db";
import { createRepositories } from "../src/services/store/repositories";
import { createConfirmationRequest, confirmRequest } from "../src/services/confirmationService";
import { loadConfig, type AppConfig } from "../src/config";
import { nowIso } from "../src/utils/dates";
import { createId } from "../src/utils/id";
import type { GenerateJsonInput, LlmClient } from "../src/services/llm/llmClient";
import type { KnowledgeBaseDraft } from "../src/schemas";

const sqlitePath = `/tmp/meetingatlas-real-feishu-write-canary-${Date.now()}.db`;

class CanaryKnowledgeLlm implements LlmClient {
  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    if (input.schemaName !== "KnowledgeBaseDraft") {
      throw new Error(`Unexpected canary LLM schema: ${input.schemaName}`);
    }

    const draft: KnowledgeBaseDraft = {
      kb_id: `kb_real_feishu_canary_${Date.now()}`,
      name: "MeetingAtlas 真实写入 Canary 知识库",
      goal: "验证 MeetingAtlas 通过 confirmation-first 流程真实创建飞书知识库和文档。",
      description: "这是 MeetingAtlas 自动化真实写入 canary 生成的临时知识库。",
      owner: null,
      status: "active",
      confidence_origin: 0.9,
      related_keywords: ["MeetingAtlas", "canary", "真实写入"],
      created_from_meetings: [],
      pages: [
        {
          title: "00 Canary 总览",
          page_type: "home",
          source_signals: ["always"],
          markdown: [
            "# MeetingAtlas 真实写入 Canary",
            "",
            "这页用于验证 MeetingAtlas 的 create_kb confirmation 能真实写入飞书 Wiki/Doc。",
            "",
            `生成时间：${nowIso()}`
          ].join("\n")
        }
      ]
    };

    return draft as T;
  }
}

function maskedOpenId(openId: string): string {
  return `${openId.slice(0, 5)}...${openId.slice(-6)}`;
}

function currentUserOpenId(): string {
  const stdout = execFileSync("lark-cli", ["auth", "status", "--verify"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000
  });
  const parsed = JSON.parse(stdout) as { userOpenId?: unknown; tokenStatus?: unknown };
  if (typeof parsed.userOpenId !== "string" || !parsed.userOpenId.startsWith("ou_")) {
    throw new Error("lark-cli user auth is not ready; missing userOpenId");
  }
  if (parsed.tokenStatus !== "valid") {
    throw new Error(`lark-cli user auth is not valid: ${String(parsed.tokenStatus)}`);
  }
  return parsed.userOpenId;
}

function realConfig(overrides: Partial<AppConfig>): AppConfig {
  return loadConfig({
    feishuDryRun: false,
    feishuCardSendDryRun: true,
    feishuTaskCreateDryRun: true,
    feishuCalendarCreateDryRun: true,
    feishuKnowledgeWriteDryRun: true,
    sqlitePath,
    llmProvider: "mock",
    ...overrides
  });
}

async function main() {
  const userOpenId = currentUserOpenId();
  const db = createDatabase(sqlitePath);
  const repos = createRepositories(db);
  const startedAt = nowIso();
  const meeting = repos.createMeeting({
    id: createId("mtg"),
    external_meeting_id: `real-feishu-write-canary-${Date.now()}`,
    title: "MeetingAtlas 真实飞书写入 Canary",
    started_at: startedAt,
    ended_at: startedAt,
    organizer: userOpenId,
    participants_json: JSON.stringify([userOpenId]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "MeetingAtlas 真实写入 canary：创建测试任务、测试日程和测试知识库。",
    summary: "验证真实飞书写入路径。",
    keywords_json: JSON.stringify(["MeetingAtlas", "canary"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 1,
    calendar_count: 1
  });

  const action = repos.createActionItem({
    id: createId("act"),
    meeting_id: meeting.id,
    kb_id: null,
    title: `MeetingAtlas Canary 待办 ${new Date().toISOString()}`,
    description: "由 MeetingAtlas 真实写入 canary 创建，可在验证后手动删除。",
    owner: userOpenId,
    collaborators_json: JSON.stringify([]),
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    priority: "P2",
    evidence: "用户授权进行真实飞书写入 canary。",
    confidence: 1,
    suggested_reason: "真实写入 canary。",
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "sent",
    feishu_task_guid: null,
    task_url: null,
    rejection_reason: null
  });
  const actionConfirmation = createConfirmationRequest({
    repos,
    requestType: "action",
    targetId: action.id,
    recipient: userOpenId,
    originalPayload: { draft: action, meeting_id: meeting.id }
  });
  const actionResult = await confirmRequest({
    repos,
    config: realConfig({ feishuTaskCreateDryRun: false }),
    id: actionConfirmation.id
  });

  const calendarStart = new Date(Date.now() + 25 * 60 * 60 * 1000);
  calendarStart.setMinutes(0, 0, 0);
  const calendarEnd = new Date(calendarStart.getTime() + 30 * 60 * 1000);
  const calendar = repos.createCalendarDraft({
    id: createId("cal"),
    meeting_id: meeting.id,
    kb_id: null,
    title: `MeetingAtlas Canary 日程 ${new Date().toISOString()}`,
    start_time: calendarStart.toISOString(),
    end_time: calendarEnd.toISOString(),
    duration_minutes: 30,
    participants_json: JSON.stringify([userOpenId]),
    agenda: "由 MeetingAtlas 真实写入 canary 创建，可在验证后手动删除。",
    location: "线上",
    evidence: "用户授权进行真实飞书写入 canary。",
    confidence: 1,
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "sent",
    calendar_event_id: null,
    event_url: null
  });
  const calendarConfirmation = createConfirmationRequest({
    repos,
    requestType: "calendar",
    targetId: calendar.id,
    recipient: userOpenId,
    originalPayload: { draft: calendar, meeting_id: meeting.id }
  });
  const calendarResult = await confirmRequest({
    repos,
    config: realConfig({ feishuCalendarCreateDryRun: false }),
    id: calendarConfirmation.id
  });

  const kbConfirmation = createConfirmationRequest({
    repos,
    requestType: "create_kb",
    targetId: `kb_canary_${Date.now()}`,
    recipient: userOpenId,
    originalPayload: {
      topic_name: `MeetingAtlas 真实写入 Canary ${new Date().toISOString()}`,
      suggested_goal: "验证 MeetingAtlas 真实知识库写入。",
      candidate_meeting_ids: [meeting.id],
      topic_match: {
        current_meeting_id: meeting.id,
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.9,
        match_reasons: ["用户授权进行真实写入 canary"],
        suggested_action: "ask_create",
        candidate_meeting_ids: [meeting.id]
      },
      reason: "真实写入 canary。"
    }
  });
  const knowledgeResult = await confirmRequest({
    repos,
    config: realConfig({ feishuKnowledgeWriteDryRun: false }),
    id: kbConfirmation.id,
    llm: new CanaryKnowledgeLlm()
  });

  const actionRow = repos.getActionItem(action.id);
  const calendarRow = repos.getCalendarDraft(calendar.id);
  const knowledgeConfirmation = repos.getConfirmationRequest(kbConfirmation.id);
  const knowledgeBases = repos.listKnowledgeBases();
  const cliRuns = repos.listCliRuns();

  console.log(
    JSON.stringify(
      {
        ok:
          actionResult.confirmation.status === "executed" &&
          calendarResult.confirmation.status === "executed" &&
          knowledgeConfirmation?.status === "executed",
        sqlite_path: sqlitePath,
        user_open_id_masked: maskedOpenId(userOpenId),
        action: {
          confirmation_status: actionResult.confirmation.status,
          task_url_present: Boolean(actionRow?.task_url),
          dry_run: (actionResult.result as { dry_run?: unknown }).dry_run
        },
        calendar: {
          confirmation_status: calendarResult.confirmation.status,
          event_url_present: Boolean(calendarRow?.event_url),
          dry_run: (calendarResult.result as { dry_run?: unknown }).dry_run
        },
        knowledge: {
          confirmation_status: knowledgeConfirmation?.status,
          wiki_url_present: Boolean(knowledgeBases.at(-1)?.wiki_url),
          homepage_url_present: Boolean(knowledgeBases.at(-1)?.homepage_url)
        },
        cli_runs: cliRuns.map((run) => ({
          tool: run.tool,
          dry_run: run.dry_run,
          status: run.status,
          error: run.error
        }))
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
