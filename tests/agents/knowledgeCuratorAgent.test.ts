import {
  renderKnowledgeBaseMarkdown,
  runKnowledgeCuratorAgent
} from "../../src/agents/knowledgeCuratorAgent";
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
  it("creates a dashboard, core content, merged FAQ, and archive even with sparse signals", () => {
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
      "index",
      "analysis",
      "sources",
      "board",
      "timeline"
    ]);
    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 README / Dashboard",
      "01 Core Content / 主题模块",
      "02 Merged FAQ / 问题合并",
      "03 Archive / 来源追溯",
      "04 Project Board / 行动与风险",
      "05 Timeline / 时间轴与日程"
    ]);
    expect(draft.pages[0].markdown).toContain("## Dashboard / Overview");
    expect(draft.pages[0].markdown).toContain("## 核心目标");
    expect(draft.pages[0].markdown).toContain("## 会议关系诊断");
    expect(draft.pages[0].markdown).toContain("## 核心资产导航");
    expect(draft.pages[0].markdown).toContain("## 主题目录");
    expect(draft.pages[0].markdown).toContain("## FAQ / Archive 入口");
    expect(draft.pages[0].markdown).toContain("## SSOT 校验");
    expect(draft.pages[0].markdown).toContain("## 关键链接 / 来源");
    expect(draft.pages[0].markdown).toContain("## 会议范围");
    expect(draft.pages[0].markdown).toContain("风险/待验证：0 条");
    expect(draft.pages[0].markdown).toContain("关联资料：0 条");
  });

  it("keeps project board, timeline, action index, risks, sources, and calendar pages", () => {
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
      "index",
      "analysis",
      "sources",
      "board",
      "timeline",
      "calendar"
    ]);
    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 README / Dashboard",
      "01 Core Content / 主题模块",
      "02 Merged FAQ / 问题合并",
      "03 Archive / 来源追溯",
      "04 Project Board / 行动与风险",
      "05 Timeline / 时间轴与日程",
      "06 Calendar / 日程索引"
    ]);
    expect(draft.pages.find((page) => page.page_type === "board")?.source_signals).toEqual(
      expect.arrayContaining(["actions", "risks"])
    );
    expect(draft.pages.find((page) => page.page_type === "board")?.markdown).toContain(
      "试飞权限未确认会阻塞排期"
    );
    expect(draft.pages.find((page) => page.page_type === "sources")?.markdown).toContain(
      "无人机安全规范"
    );
    expect(draft.pages.find((page) => page.page_type === "timeline")?.markdown).toContain(
      "SOP 评审会"
    );
    expect(draft.pages.find((page) => page.page_type === "calendar")?.markdown).toContain(
      "SOP 评审会"
    );
  });

  it("reorganizes complementary series meetings into participant-oriented theme modules", () => {
    const draft = runKnowledgeCuratorAgent({
      topicName: "飞书 AI 校园挑战赛主题知识库",
      owner: null,
      meetings: [
        meeting({
          id: "mtg_challenge_1",
          title: "飞书 AI 校园挑战赛说明会",
          summary: "本场说明活动定位、报名、赛程节点、队伍规则、作品提交、技术资源与开发环境。",
          transcript_text: [
            "主持人：本场说明活动定位、报名入口、赛程节点、队伍规则和作品提交要求。",
            "学生问：怎么报名？",
            "老师答：报名入口在活动主页，队伍可以先组好再提交作品。",
            "技术同学：开发环境建议准备 API、SDK、CLI、MCP 和权限申请，参考平台文档。"
          ].join("\n"),
          keywords_json: JSON.stringify(["AI 挑战", "技术资源", "产品设计"])
        }),
        meeting({
          id: "mtg_challenge_2",
          title: "飞书 AI 校园挑战赛导师答疑",
          summary:
            "导师围绕产品设计方法、Demo 验证、技术资源、职场分享、实习岗位和 Offer 准备答疑。",
          transcript_text: [
            "导师：产品设计需要从用户场景、需求、痛点、原型和 Demo 验证开始。",
            "嘉宾：职场分享会讨论实习、岗位、简历、面试和 Offer 准备。",
            "学生问：技术环境需要准备什么？",
            "导师答：先跑通开发工具、模型服务和部署流程。",
            "活动回顾：今天补充了答疑、技术资源和职业信息。"
          ].join("\n"),
          keywords_json: JSON.stringify(["产品方法", "职场 Offer", "活动回顾"])
        })
      ],
      actions: [],
      calendars: [],
      confidenceOrigin: 0.91
    });

    const markdown = renderKnowledgeBaseMarkdown(draft);

    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 README / Dashboard",
      "01 Core Content / 主题模块",
      "02 Merged FAQ / 问题合并",
      "03 Archive / 来源追溯"
    ]);
    expect(markdown).toContain("互补/系列型");
    expect(markdown).toContain("赛事总览与核心指南");
    expect(markdown).toContain("技术资源与开发环境");
    expect(markdown).toContain("产品设计与实战方法论");
    expect(markdown).toContain("职场与 Offer 指南");
    expect(markdown).toContain("Merged FAQ");
    expect(markdown).toContain("怎么报名");
    expect(markdown).toContain("活动回顾");
    expect(markdown).toContain("Archive");
  });
});
