import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { confirmRequest, createConfirmationRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function createActionTestMeeting(repos: ReturnType<typeof createRepositories>) {
  return repos.createMeeting({
    id: "mtg_action_confirmation",
    external_meeting_id: null,
    title: "无人机操作方案初步访谈",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三", "李四"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "李四负责确认试飞场地权限。",
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 1,
    calendar_count: 0
  });
}

describe("confirm action request", () => {
  it("marks action executed and records cli_runs in dry-run mode", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");

    await processMeetingWorkflow({
      repos,
      llm: new MockLlmClient(),
      meeting: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: transcript
      }
    });

    const request = repos.listConfirmationRequests().find((item) => item.request_type === "action");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request!.id
    });

    const updatedRequest = repos.getConfirmationRequest(request!.id);
    const action = repos.getActionItem(request!.target_id);
    expect(updatedRequest?.status).toBe("executed");
    expect(action?.confirmation_status).toBe("created");
    expect(action?.feishu_task_guid).toContain("dry_task_");
    expect(repos.listCliRuns()).toHaveLength(1);
  });

  it("merges edited title, owner, and due date before dry-run task creation", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");

    await processMeetingWorkflow({
      repos,
      llm: new MockLlmClient(),
      meeting: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: transcript
      }
    });

    const request = repos.listConfirmationRequests().find((item) => item.request_type === "action");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request!.id,
      editedPayload: {
        title: "修订后的飞行安全清单",
        owner: "王五",
        due_date: "2026-05-08"
      }
    });

    const action = repos.getActionItem(request!.target_id);
    const cliRun = repos.listCliRuns()[0];
    const args = JSON.parse(cliRun.args_json) as string[];

    expect(action).toMatchObject({
      title: "修订后的飞行安全清单",
      owner: "王五",
      due_date: "2026-05-08",
      confirmation_status: "created"
    });
    expect(args).toContain("修订后的飞行安全清单");
    expect(args).toContain("王五");
    expect(args).toContain("2026-05-08");
  });

  it("removes due date from missing fields when edited payload fills it", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createActionTestMeeting(repos);
    const action = repos.createActionItem({
      id: "act_missing_due_date",
      meeting_id: meeting.id,
      kb_id: null,
      title: "确认试飞场地权限",
      description: null,
      owner: "李四",
      collaborators_json: JSON.stringify([]),
      due_date: null,
      priority: "P1",
      evidence: "李四说他去确认试飞场地权限。",
      confidence: 0.84,
      suggested_reason: "会议明确点名李四负责确认试飞场地权限。",
      missing_fields_json: JSON.stringify(["due_date"]),
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "action",
      targetId: action.id,
      recipient: action.owner,
      originalPayload: { draft: action }
    });

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request.id,
      editedPayload: {
        due_date: "2026-05-08"
      }
    });

    const updatedAction = repos.getActionItem(action.id);
    const missingFields = JSON.parse(updatedAction!.missing_fields_json) as string[];

    expect(missingFields).not.toContain("due_date");
    expect(missingFields).toEqual([]);
  });

  it("adds a confirmation note when edited payload changes the owner", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createActionTestMeeting(repos);
    const action = repos.createActionItem({
      id: "act_changed_owner",
      meeting_id: meeting.id,
      kb_id: null,
      title: "确认试飞场地权限",
      description: null,
      owner: "李四",
      collaborators_json: JSON.stringify([]),
      due_date: "2026-05-08",
      priority: "P1",
      evidence: "李四说他去确认试飞场地权限。",
      confidence: 0.84,
      suggested_reason: "会议明确点名李四负责确认试飞场地权限。",
      missing_fields_json: JSON.stringify([]),
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "action",
      targetId: action.id,
      recipient: action.owner,
      originalPayload: { draft: action }
    });

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request.id,
      editedPayload: {
        owner: "王五"
      }
    });

    const updatedAction = repos.getActionItem(action.id);

    expect(updatedAction?.owner).toBe("王五");
    expect(updatedAction?.suggested_reason).toContain("用户确认时已修改字段：owner。");
    expect(updatedAction?.suggested_reason).toContain("以用户确认结果为准");
  });

  it("marks confirmation failed in real mode when lark CLI is missing", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");

    await processMeetingWorkflow({
      repos,
      llm: new MockLlmClient(),
      meeting: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: transcript
      }
    });

    const request = repos.listConfirmationRequests().find((item) => item.request_type === "action");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: false, larkCliBin: "definitely-not-real-lark" }),
      id: request!.id
    });

    const updatedRequest = repos.getConfirmationRequest(request!.id);
    const action = repos.getActionItem(request!.target_id);
    const cliRuns = repos.listCliRuns();

    expect(updatedRequest?.status).toBe("failed");
    expect(updatedRequest?.error).toContain("lark.task.create failed");
    expect(action?.confirmation_status).toBe("sent");
    expect(action?.feishu_task_guid).toBeNull();
    expect(action?.task_url).toBeNull();
    expect(cliRuns).toHaveLength(1);
    expect(cliRuns[0]).toMatchObject({
      dry_run: 0,
      status: "failed"
    });
    expect(cliRuns[0].error).toContain("definitely-not-real-lark");
  });
});
