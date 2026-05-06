import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { confirmRequest, createConfirmationRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { createCalendarEvent } from "../../src/tools/larkCalendar";
import { type LarkCliRunner } from "../../src/tools/larkCli";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function createCalendarTestMeeting(repos: ReturnType<typeof createRepositories>) {
  return repos.createMeeting({
    id: "mtg_calendar_confirmation",
    external_meeting_id: null,
    title: "无人机操作方案初步访谈",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三", "李四"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "下周二上午十点再约操作员访谈。",
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 1
  });
}

describe("confirm calendar request", () => {
  it("marks calendar draft executed and records cli_runs in dry-run mode", async () => {
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

    const request = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "calendar");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request!.id
    });

    const updatedRequest = repos.getConfirmationRequest(request!.id);
    const calendar = repos.getCalendarDraft(request!.target_id);
    expect(updatedRequest?.status).toBe("executed");
    expect(calendar?.confirmation_status).toBe("created");
    expect(calendar?.calendar_event_id).toContain("dry_event_");
    expect(repos.listCliRuns()).toHaveLength(1);
  });

  it("keeps calendar creation dry-run when only card sending is real-enabled", async () => {
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

    const request = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "calendar");
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
    const calendar = repos.getCalendarDraft(request!.target_id);
    const cliRuns = repos.listCliRuns();

    expect(updatedRequest?.status).toBe("executed");
    expect(calendar).toMatchObject({
      confirmation_status: "created",
      calendar_event_id: expect.stringContaining("dry_event_"),
      event_url: expect.stringContaining("mock://feishu/calendar/")
    });
    expect(cliRuns).toHaveLength(1);
    expect(cliRuns[0]).toMatchObject({
      tool: "lark.calendar.create",
      dry_run: 1,
      status: "planned",
      error: null
    });
  });

  it("merges edited start time and participants before dry-run calendar creation", async () => {
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

    const request = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "calendar");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request!.id,
      editedPayload: {
        start_time: "2026-05-06T14:30:00+08:00",
        participants: ["王五", "赵六"]
      }
    });

    const calendar = repos.getCalendarDraft(request!.target_id);
    const cliRun = repos.listCliRuns()[0];
    const args = JSON.parse(cliRun.args_json) as string[];

    expect(calendar).toMatchObject({
      start_time: "2026-05-06T14:30:00+08:00",
      participants_json: JSON.stringify(["王五", "赵六"]),
      confirmation_status: "created"
    });
    expect(args).toContain("2026-05-06T14:30:00+08:00");
    expect(args).not.toContain("--attendee-ids");
    expect(args).not.toContain(JSON.stringify(["王五", "赵六"]));
  });

  it("keeps calendar canary planned when global Feishu dry-run is enabled", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createCalendarTestMeeting(repos);
    const calendar = repos.createCalendarDraft({
      id: "cal_global_dry_run_gate",
      meeting_id: meeting.id,
      kb_id: null,
      title: "无人机操作员访谈",
      start_time: "2026-05-05T10:00:00+08:00",
      end_time: "2026-05-05T11:00:00+08:00",
      duration_minutes: 60,
      participants_json: JSON.stringify(["ou_alpha"]),
      agenda: "确认真实操作步骤和限制",
      location: null,
      evidence: "下周二上午 10 点再约操作员访谈。",
      confidence: 0.82,
      missing_fields_json: JSON.stringify([]),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "calendar",
      targetId: calendar.id,
      recipient: meeting.organizer,
      originalPayload: { draft: calendar }
    });
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({ data: { event_id: "event_real" } }),
        stderr: ""
      };
    };

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuCalendarCreateDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      id: request.id,
      runner
    });

    expect(calls).toHaveLength(0);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.calendar.create",
      dry_run: 1,
      status: "planned"
    });
    expect(repos.getCalendarDraft(calendar.id)).toMatchObject({
      confirmation_status: "created",
      calendar_event_id: "dry_event_cal_global_dry_run_gate",
      event_url: "mock://feishu/calendar/cal_global_dry_run_gate"
    });
  });

  it("keeps calendar creation dry-run when config is omitted but calendar dry-run is enabled", async () => {
    const previousFeishuDryRun = process.env.FEISHU_DRY_RUN;
    const previousCalendarDryRun = process.env.FEISHU_CALENDAR_CREATE_DRY_RUN;
    const previousLarkCliBin = process.env.LARK_CLI_BIN;
    process.env.FEISHU_DRY_RUN = "false";
    process.env.FEISHU_CALENDAR_CREATE_DRY_RUN = "true";
    process.env.LARK_CLI_BIN = "fake-lark-cli";

    try {
      const repos = createRepositories(createMemoryDatabase());
      const meeting = createCalendarTestMeeting(repos);
      const calendar = repos.createCalendarDraft({
        id: "cal_omitted_config_calendar_dry_run",
        meeting_id: meeting.id,
        kb_id: null,
        title: "无人机操作员访谈",
        start_time: "2026-05-05T10:00:00+08:00",
        end_time: "2026-05-05T11:00:00+08:00",
        duration_minutes: 60,
        participants_json: JSON.stringify(["ou_alpha"]),
        agenda: "确认真实操作步骤和限制",
        location: null,
        evidence: "下周二上午 10 点再约操作员访谈。",
        confidence: 0.82,
        missing_fields_json: JSON.stringify([]),
        confirmation_status: "sent",
        calendar_event_id: null,
        event_url: null
      });
      const calls: Array<{ bin: string; args: string[] }> = [];
      const runner: LarkCliRunner = async (bin, args) => {
        calls.push({ bin, args });
        return {
          stdout: JSON.stringify({ data: { event_id: "event_real" } }),
          stderr: ""
        };
      };

      const result = await createCalendarEvent({
        repos,
        draft: calendar,
        runner
      });

      expect(calls).toHaveLength(0);
      expect(result).toMatchObject({
        calendar_event_id: "dry_event_cal_omitted_config_calendar_dry_run",
        event_url: "mock://feishu/calendar/cal_omitted_config_calendar_dry_run",
        dry_run: true
      });
      expect(repos.listCliRuns()[0]).toMatchObject({
        tool: "lark.calendar.create",
        dry_run: 1,
        status: "planned"
      });
    } finally {
      if (previousFeishuDryRun === undefined) {
        delete process.env.FEISHU_DRY_RUN;
      } else {
        process.env.FEISHU_DRY_RUN = previousFeishuDryRun;
      }
      if (previousCalendarDryRun === undefined) {
        delete process.env.FEISHU_CALENDAR_CREATE_DRY_RUN;
      } else {
        process.env.FEISHU_CALENDAR_CREATE_DRY_RUN = previousCalendarDryRun;
      }
      if (previousLarkCliBin === undefined) {
        delete process.env.LARK_CLI_BIN;
      } else {
        process.env.LARK_CLI_BIN = previousLarkCliBin;
      }
    }
  });

  it("fails before real calendar CLI execution when end time is missing", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createCalendarTestMeeting(repos);
    const calendar = repos.createCalendarDraft({
      id: "cal_missing_end_time_real",
      meeting_id: meeting.id,
      kb_id: null,
      title: "无人机操作员访谈",
      start_time: "2026-05-05T10:00:00+08:00",
      end_time: null,
      duration_minutes: null,
      participants_json: JSON.stringify(["ou_alpha"]),
      agenda: "确认真实操作步骤和限制",
      location: null,
      evidence: "下周二上午 10 点再约操作员访谈。",
      confidence: 0.82,
      missing_fields_json: JSON.stringify(["end_time"]),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({ data: { event_id: "event_real" } }),
        stderr: ""
      };
    };

    await expect(
      createCalendarEvent({
        repos,
        config: loadConfig({
          feishuDryRun: false,
          feishuCalendarCreateDryRun: false,
          larkCliBin: "fake-lark-cli"
        }),
        draft: calendar,
        runner
      })
    ).rejects.toThrow("calendar end_time is required before creating a real Feishu event");
    expect(calls).toHaveLength(0);
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("creates real Feishu events with the calendar canary and filters attendees to open_ids", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createCalendarTestMeeting(repos);
    const calendar = repos.createCalendarDraft({
      id: "cal_real_event_create",
      meeting_id: meeting.id,
      kb_id: null,
      title: "无人机操作员访谈",
      start_time: "2026-05-05T10:00:00+08:00",
      end_time: "2026-05-05T11:00:00+08:00",
      duration_minutes: 60,
      participants_json: JSON.stringify(["ou_alpha", "张三", "ou_beta", "oc_group"]),
      agenda: "确认真实操作步骤和限制",
      location: null,
      evidence: "下周二上午 10 点再约操作员访谈。",
      confidence: 0.82,
      missing_fields_json: JSON.stringify([]),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "calendar",
      targetId: calendar.id,
      recipient: meeting.organizer,
      originalPayload: { draft: calendar }
    });
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({
          data: {
            event_id: "event_real",
            url: "https://applink.feishu.cn/client/calendar/event_real"
          }
        }),
        stderr: ""
      };
    };

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        feishuCalendarCreateDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      id: request.id,
      runner
    });

    const updatedCalendar = repos.getCalendarDraft(calendar.id);
    const updatedRequest = repos.getConfirmationRequest(request.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bin: "fake-lark-cli" });
    expect(calls[0].args).toEqual([
      "calendar",
      "+create",
      "--summary",
      "无人机操作员访谈",
      "--start",
      "2026-05-05T10:00:00+08:00",
      "--end",
      "2026-05-05T11:00:00+08:00",
      "--description",
      "确认真实操作步骤和限制",
      "--attendee-ids",
      "ou_alpha,ou_beta",
      "--as",
      "user"
    ]);
    expect(updatedRequest).toMatchObject({
      status: "executed",
      error: null
    });
    expect(updatedCalendar).toMatchObject({
      confirmation_status: "created",
      calendar_event_id: "event_real",
      event_url: "https://applink.feishu.cn/client/calendar/event_real"
    });
  });

  it("treats a real Feishu calendar response with event_id only as successful", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createCalendarTestMeeting(repos);
    const calendar = repos.createCalendarDraft({
      id: "cal_real_event_id_only",
      meeting_id: meeting.id,
      kb_id: null,
      title: "REAL-CALENDAR-CANARY Henry SHA1 日历会议",
      start_time: "2026-05-01T22:45:00+08:00",
      end_time: "2026-05-01T23:00:00+08:00",
      duration_minutes: 15,
      participants_json: JSON.stringify(["Henry"]),
      agenda: "card-action 40 位 SHA1 签名验证",
      location: "线上会议",
      evidence: "真实 CLI 仅返回 data.event_id。",
      confidence: 1,
      missing_fields_json: JSON.stringify([]),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "calendar",
      targetId: calendar.id,
      recipient: meeting.organizer,
      originalPayload: { draft: calendar }
    });
    const runner: LarkCliRunner = async () => ({
      stdout: JSON.stringify({
        data: {
          event_id: "672e330d-fc32-4e41-9e84-201b547a08f8_0",
          summary: "REAL-CALENDAR-CANARY Henry SHA1 日历会议"
        }
      }),
      stderr: ""
    });

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        feishuCalendarCreateDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      id: request.id,
      runner
    });

    expect(repos.getConfirmationRequest(request.id)).toMatchObject({
      status: "executed",
      error: null
    });
    expect(repos.getCalendarDraft(calendar.id)).toMatchObject({
      confirmation_status: "created",
      calendar_event_id: "672e330d-fc32-4e41-9e84-201b547a08f8_0",
      event_url: ""
    });
  });

  it("fails confirmation when calendar start time is missing instead of faking success", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createCalendarTestMeeting(repos);
    const calendar = repos.createCalendarDraft({
      id: "cal_missing_start_time",
      meeting_id: meeting.id,
      kb_id: null,
      title: "无人机操作员访谈",
      start_time: null,
      end_time: null,
      duration_minutes: null,
      participants_json: JSON.stringify(["ou_alpha"]),
      agenda: "确认真实操作步骤和限制",
      location: null,
      evidence: "下周二上午 10 点再约操作员访谈。",
      confidence: 0.82,
      missing_fields_json: JSON.stringify(["start_time"]),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "calendar",
      targetId: calendar.id,
      recipient: meeting.organizer,
      originalPayload: { draft: calendar }
    });

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuCalendarCreateDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      id: request.id
    });

    expect(repos.getConfirmationRequest(request.id)).toMatchObject({
      status: "failed",
      error: "calendar start_time is required before creating a Feishu event"
    });
    expect(repos.getCalendarDraft(calendar.id)).toMatchObject({
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("removes filled participants and location while keeping still-missing end time", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = createCalendarTestMeeting(repos);
    const calendar = repos.createCalendarDraft({
      id: "cal_missing_participants_location",
      meeting_id: meeting.id,
      kb_id: null,
      title: "无人机操作员访谈",
      start_time: "2026-05-05T10:00:00+08:00",
      end_time: null,
      duration_minutes: null,
      participants_json: JSON.stringify([]),
      agenda: "确认真实操作步骤和限制",
      location: null,
      evidence: "下周二上午 10 点再约操作员访谈。",
      confidence: 0.82,
      missing_fields_json: JSON.stringify(["participants", "end_time", "location"]),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });
    const request = createConfirmationRequest({
      repos,
      requestType: "calendar",
      targetId: calendar.id,
      recipient: meeting.organizer,
      originalPayload: { draft: calendar }
    });

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request.id,
      editedPayload: {
        participants: ["王五", "赵六"],
        location: "线上会议室"
      }
    });

    const updatedCalendar = repos.getCalendarDraft(calendar.id);
    const missingFields = JSON.parse(updatedCalendar!.missing_fields_json) as string[];

    expect(missingFields).not.toContain("participants");
    expect(missingFields).not.toContain("location");
    expect(missingFields).toContain("end_time");
    expect(missingFields).toEqual(["end_time"]);
  });
});
