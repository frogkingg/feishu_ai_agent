import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("SQLite repositories", () => {
  it("initializes schema and inserts meeting, action item, and confirmation request", () => {
    const db = createMemoryDatabase();
    const repos = createRepositories(db);

    const meeting = repos.createMeeting({
      id: "m_001",
      external_meeting_id: "external_001",
      title: "无人机操作方案初步访谈",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      organizer: "张三",
      participants_json: JSON.stringify(["张三", "李四"]),
      minutes_url: null,
      transcript_url: null,
      transcript_text: "张三整理现有操作流程，周五前给大家看。",
      summary: null,
      keywords_json: JSON.stringify([]),
      matched_kb_id: null,
      match_score: null,
      archive_status: "not_archived",
      action_count: 0,
      calendar_count: 0
    });

    const action = repos.createActionItem({
      id: "act_001",
      meeting_id: meeting.id,
      kb_id: null,
      title: "整理现有操作流程",
      description: null,
      owner: "张三",
      collaborators_json: JSON.stringify([]),
      due_date: "2026-05-01",
      priority: "P1",
      evidence: "张三整理现有操作流程，周五前给大家看。",
      confidence: 0.88,
      suggested_reason: "会议中明确点名张三负责。",
      missing_fields_json: JSON.stringify([]),
      confirmation_status: "draft",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });

    const confirmation = repos.createConfirmationRequest({
      id: "conf_001",
      request_type: "action",
      target_id: action.id,
      recipient: "张三",
      card_message_id: null,
      status: "draft",
      original_payload_json: JSON.stringify({ title: action.title }),
      edited_payload_json: null,
      confirmed_at: null,
      executed_at: null,
      error: null
    });

    expect(repos.getMeeting("m_001")?.title).toBe("无人机操作方案初步访谈");
    expect(repos.getActionItem("act_001")?.owner).toBe("张三");
    expect(repos.getConfirmationRequest("conf_001")?.target_id).toBe(confirmation.target_id);
  });

  it("records cli_runs without executing external commands", () => {
    const db = createMemoryDatabase();
    const repos = createRepositories(db);

    repos.createCliRun({
      id: "cli_001",
      tool: "lark.task.create",
      args_json: JSON.stringify(["task", "+create", "--summary", "demo"]),
      dry_run: 1,
      status: "planned",
      stdout: null,
      stderr: null,
      error: null
    });

    expect(repos.listCliRuns()).toHaveLength(1);
  });
});
