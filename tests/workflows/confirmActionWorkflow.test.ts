import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { confirmRequest, createConfirmationRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";
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
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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

  it("keeps task creation dry-run when only card sending is real-enabled", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        larkCliBin: "definitely-not-real-lark"
      }),
      id: request!.id
    });

    const updatedRequest = repos.getConfirmationRequest(request!.id);
    const action = repos.getActionItem(request!.target_id);
    const cliRuns = repos.listCliRuns();

    expect(updatedRequest?.status).toBe("executed");
    expect(action).toMatchObject({
      confirmation_status: "created",
      feishu_task_guid: expect.stringContaining("dry_task_"),
      task_url: expect.stringContaining("mock://feishu/task/")
    });
    expect(cliRuns).toHaveLength(1);
    expect(cliRuns[0]).toMatchObject({
      tool: "lark.task.create",
      dry_run: 1,
      status: "planned",
      error: null
    });
  });

  it("merges edited title, owner, and due date before dry-run task creation", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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
    expect(args).not.toContain("王五");
    expect(args).not.toContain("--assignee");
    expect(args).toContain("2026-05-08");
    expect(args).toEqual(
      expect.arrayContaining([
        "task",
        "+create",
        "--summary",
        "修订后的飞行安全清单",
        "--due",
        "2026-05-08",
        "--as",
        "user"
      ])
    );
  });

  it("creates real Feishu tasks with the task canary while global writes stay dry-run", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createActionTestMeeting(repos);
    const action = repos.createActionItem({
      id: "act_real_task_create",
      meeting_id: meeting.id,
      kb_id: null,
      title: "确认试飞场地权限",
      description: "确认宝石湖试飞是否需要额外审批。",
      owner: "ou_owner",
      collaborators_json: JSON.stringify([]),
      due_date: "2026-05-08",
      priority: "P1",
      evidence: "李四说他去确认试飞场地权限。",
      confidence: 0.84,
      suggested_reason: "会议明确点名负责人。",
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
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({
          data: {
            guid: "task_guid_real",
            url: "https://applink.feishu.cn/client/todo/detail?guid=task_guid_real"
          }
        }),
        stderr: ""
      };
    };

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuTaskCreateDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      id: request.id,
      runner
    });

    const updatedAction = repos.getActionItem(action.id);
    const updatedRequest = repos.getConfirmationRequest(request.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bin: "fake-lark-cli" });
    expect(calls[0].args).toEqual([
      "task",
      "+create",
      "--summary",
      "确认试飞场地权限",
      "--description",
      "确认宝石湖试飞是否需要额外审批。",
      "--due",
      "2026-05-08",
      "--assignee",
      "ou_owner",
      "--as",
      "user"
    ]);
    expect(updatedRequest).toMatchObject({
      status: "executed",
      error: null
    });
    expect(updatedAction).toMatchObject({
      confirmation_status: "created",
      feishu_task_guid: "task_guid_real",
      task_url: "https://applink.feishu.cn/client/todo/detail?guid=task_guid_real"
    });
  });

  it("passes the recipient fallback assignee to real task creation when owner is missing", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createActionTestMeeting(repos);
    const action = repos.createActionItem({
      id: "act_real_task_create_personal",
      meeting_id: meeting.id,
      kb_id: null,
      title: "整理客户访谈结论",
      description: "汇总访谈输出。",
      owner: null,
      collaborators_json: JSON.stringify([]),
      due_date: "2026-05-08",
      priority: "P1",
      evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
      confidence: 0.84,
      suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
      missing_fields_json: JSON.stringify(["owner"]),
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "action",
      targetId: action.id,
      recipient: "ou_personal_recipient",
      originalPayload: { draft: action }
    });
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({
          data: {
            guid: "task_guid_personal",
            url: "https://applink.feishu.cn/client/todo/detail?guid=task_guid_personal"
          }
        }),
        stderr: ""
      };
    };

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuTaskCreateDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      id: request.id,
      runner
    });

    const updatedAction = repos.getActionItem(action.id);
    const updatedRequest = repos.getConfirmationRequest(request.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "task",
      "+create",
      "--summary",
      "整理客户访谈结论",
      "--description",
      "汇总访谈输出。",
      "--due",
      "2026-05-08",
      "--assignee",
      "ou_personal_recipient",
      "--as",
      "user"
    ]);
    expect(updatedRequest).toMatchObject({
      status: "executed",
      error: null
    });
    expect(updatedAction).toMatchObject({
      owner: "ou_personal_recipient",
      confirmation_status: "created",
      feishu_task_guid: "task_guid_personal",
      task_url: "https://applink.feishu.cn/client/todo/detail?guid=task_guid_personal"
    });
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

  it("creates a personal task for the recipient when the action owner is missing", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createActionTestMeeting(repos);
    const action = repos.createActionItem({
      id: "act_missing_owner_completion",
      meeting_id: meeting.id,
      kb_id: null,
      title: "整理客户访谈结论",
      description: "汇总访谈输出。",
      owner: null,
      collaborators_json: JSON.stringify([]),
      due_date: "2026-05-08",
      priority: "P1",
      evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
      confidence: 0.84,
      suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
      missing_fields_json: JSON.stringify(["owner"]),
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "action",
      targetId: action.id,
      recipient: "ou_personal_recipient",
      originalPayload: { draft: action }
    });

    const result = await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request.id
    });

    const updatedRequest = repos.getConfirmationRequest(request.id);
    const updatedAction = repos.getActionItem(action.id);
    expect(result.result).toMatchObject({
      dry_run: true,
      feishu_task_guid: `dry_task_${action.id}`,
      task_url: `mock://feishu/task/${action.id}`
    });
    expect(updatedRequest).toMatchObject({
      status: "executed",
      error: null
    });
    expect(updatedAction).toMatchObject({
      owner: "ou_personal_recipient",
      confirmation_status: "created",
      feishu_task_guid: `dry_task_${action.id}`,
      task_url: `mock://feishu/task/${action.id}`
    });
    const cliRuns = repos.listCliRuns();
    expect(cliRuns).toHaveLength(1);
    const args = JSON.parse(cliRuns[0].args_json) as string[];
    expect(args).toEqual(expect.arrayContaining(["--assignee", "ou_personal_recipient"]));
    expect(JSON.stringify(updatedAction)).not.toContain("认领");
    expect(JSON.stringify(updatedAction)).not.toContain("承诺");
  });

  it("fails clearly when an owner-missing action has no personal owner open_id", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createActionTestMeeting(repos);
    const action = repos.createActionItem({
      id: "act_missing_owner_no_recipient",
      meeting_id: meeting.id,
      kb_id: null,
      title: "整理客户访谈结论",
      description: "汇总访谈输出。",
      owner: null,
      collaborators_json: JSON.stringify([]),
      due_date: "2026-05-08",
      priority: "P1",
      evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
      confidence: 0.84,
      suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
      missing_fields_json: JSON.stringify(["owner"]),
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "action",
      targetId: action.id,
      recipient: null,
      originalPayload: { draft: action }
    });

    const result = await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request.id
    });

    const updatedRequest = repos.getConfirmationRequest(request.id);
    const updatedAction = repos.getActionItem(action.id);
    expect(result.result).toMatchObject({
      failed: true,
      error:
        "Cannot create personal Feishu task: missing confirmation recipient open_id or card callback open_id"
    });
    expect(updatedRequest).toMatchObject({
      status: "failed",
      error:
        "Cannot create personal Feishu task: missing confirmation recipient open_id or card callback open_id"
    });
    expect(updatedAction).toMatchObject({
      owner: null,
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("marks confirmation failed in real mode when the fake lark CLI runner fails", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const failingRunner: LarkCliRunner = async () => {
      throw new Error("fake lark CLI failure");
    };
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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
      config: loadConfig({ feishuDryRun: false, larkCliBin: "fake-lark-cli" }),
      id: request!.id,
      runner: failingRunner
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
    expect(cliRuns[0].error).toContain("fake lark CLI failure");
  });
});
