import { runKnowledgeCuratorAgent } from "../../src/agents/knowledgeCuratorAgent";
import { ActionItemRow, CalendarDraftRow, MeetingRow } from "../../src/services/store/repositories";

const Now = "2026-04-30T10:00:00+08:00";

function meeting(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: "mtg_1",
    external_meeting_id: null,
    title: "项目同步",
    started_at: Now,
    ended_at: "2026-04-30T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "本次会议同步项目背景。",
    summary: "本次会议同步项目背景。",
    keywords_json: JSON.stringify(["项目背景"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0,
    created_at: Now,
    updated_at: Now,
    ...overrides
  };
}

function action(overrides: Partial<ActionItemRow> = {}): ActionItemRow {
  return {
    id: "act_1",
    meeting_id: "mtg_1",
    kb_id: null,
    title: "整理 SOP 草案",
    description: null,
    owner: "张三",
    collaborators_json: JSON.stringify([]),
    due_date: "2026-05-01",
    priority: "P1",
    evidence: "张三负责整理 SOP 草案。",
    confidence: 0.9,
    suggested_reason: "会议中明确认领。",
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "draft",
    feishu_task_guid: null,
    task_url: null,
    rejection_reason: null,
    created_at: Now,
    updated_at: Now,
    ...overrides
  };
}

function calendar(overrides: Partial<CalendarDraftRow> = {}): CalendarDraftRow {
  return {
    id: "cal_1",
    meeting_id: "mtg_1",
    kb_id: null,
    title: "SOP 评审会",
    start_time: "2026-05-02T10:00:00+08:00",
    end_time: "2026-05-02T10:30:00+08:00",
    duration_minutes: 30,
    participants_json: JSON.stringify(["张三"]),
    agenda: "评审 SOP 草案。",
    location: null,
    evidence: "下周评审 SOP 草案。",
    confidence: 0.82,
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "draft",
    calendar_event_id: null,
    event_url: null,
    created_at: Now,
    updated_at: Now,
    ...overrides
  };
}

describe("knowledgeCuratorAgent", () => {
  it("creates a GitHub-style knowledge base structure even with sparse signals", () => {
    const draft = runKnowledgeCuratorAgent({
      topicName: "项目背景主题知识库",
      owner: null,
      meetings: [meeting()],
      actions: [],
      calendars: [],
      confidenceOrigin: 0.7
    });

    expect(draft.pages.map((page) => page.page_type)).toEqual([
      "home",
      "board",
      "timeline",
      "meetings",
      "resources",
      "decisions",
      "calendar"
    ]);
    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 README / 项目总览",
      "01 Project Board / 进度与待办",
      "02 Timeline / 里程碑与甘特",
      "03 Meetings / 会议记录",
      "04 Docs & Resources / 文档与资料",
      "05 Decisions & Risks / 决策与风险",
      "06 Calendar / 日程索引"
    ]);
    expect(draft.pages[0].markdown).toContain("## 项目简介");
    expect(draft.pages[0].markdown).toContain("## 当前状态");
    expect(draft.pages[0].markdown).toContain("## 下一步");
    expect(draft.pages[0].markdown).toContain("## 关键链接 / 来源");
    expect(draft.pages[0].markdown).toContain("## 会议范围");
    expect(draft.pages[0].markdown).toContain("风险/待验证：0 条");
    expect(draft.pages[0].markdown).toContain("关联资料：0 条");
  });

  it("fills board, timeline, meetings, resources, decisions, risks, and calendar pages", () => {
    const draft = runKnowledgeCuratorAgent({
      topicName: "无人机 SOP 主题知识库",
      owner: "张三",
      meetings: [
        meeting({
          title: "无人机 SOP 评审",
          summary: "本次会议明确需要建立统一 SOP，并指出试飞权限未确认会影响排期。",
          transcript_text: [
            "李四：结论是需要建立统一 SOP。",
            "李四：试飞权限未确认会阻塞排期。",
            "张三：资料上可以先参考“无人机安全规范”。"
          ].join("\n"),
          keywords_json: JSON.stringify(["无人机", "SOP"])
        })
      ],
      actions: [action()],
      calendars: [calendar()],
      confidenceOrigin: 0.88
    });

    expect(draft.pages.map((page) => page.page_type)).toEqual([
      "home",
      "board",
      "timeline",
      "meetings",
      "resources",
      "decisions",
      "calendar"
    ]);
    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 README / 项目总览",
      "01 Project Board / 进度与待办",
      "02 Timeline / 里程碑与甘特",
      "03 Meetings / 会议记录",
      "04 Docs & Resources / 文档与资料",
      "05 Decisions & Risks / 决策与风险",
      "06 Calendar / 日程索引"
    ]);
    expect(draft.pages.find((page) => page.page_type === "board")?.source_signals).toEqual([
      "actions",
      "risks"
    ]);
    expect(draft.pages.find((page) => page.page_type === "decisions")?.markdown).toContain(
      "试飞权限未确认会阻塞排期"
    );
    expect(draft.pages.find((page) => page.page_type === "resources")?.markdown).toContain(
      "无人机安全规范"
    );
    expect(draft.pages.find((page) => page.page_type === "timeline")?.markdown).toContain(
      "SOP 评审会"
    );
    expect(draft.pages.find((page) => page.page_type === "calendar")?.markdown).toContain(
      "SOP 评审会"
    );
  });
});
