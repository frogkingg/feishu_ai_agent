import {
  renderKnowledgeBaseMarkdown,
  runKnowledgeCuratorAgent
} from "../../src/agents/knowledgeCuratorAgent";
import { GenerateJsonInput, LlmClient } from "../../src/services/llm/llmClient";
import { ActionItemRow, CalendarDraftRow, MeetingRow } from "../../src/services/store/repositories";

const Now = "2026-04-30T10:00:00+08:00";

class QueueLlmClient implements LlmClient {
  readonly calls: GenerateJsonInput[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    this.calls.push(input);
    const output = this.outputs.shift();
    if (output === undefined) {
      throw new Error("QueueLlmClient exhausted");
    }
    return output as T;
  }
}

function meeting(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: "mtg_1",
    external_meeting_id: null,
    title: "项目同步",
    started_at: Now,
    ended_at: "2026-04-30T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三"]),
    minutes_url: "https://example.feishu.cn/minutes/min_001",
    transcript_url: "https://example.feishu.cn/minutes/transcript_001",
    transcript_text: "这是一段完整转写，不应该进入 curator prompt。",
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
  it("asks the LLM to curate from compact digest instead of transcript rules", async () => {
    const llm = new QueueLlmClient([
      {
        name: "LLM 策展知识库",
        goal: "帮助读者快速理解项目背景和下一步。",
        description: "由 LLM 自适应生成。",
        owner: null,
        confidence_origin: 0.93,
        related_keywords: ["项目背景", "读者任务"],
        pages: [
          {
            title: "00 Dashboard",
            page_type: "home",
            source_signals: ["always"],
            markdown: "# 00 Dashboard\n\n## Dashboard / Overview\nLLM 自行选择首页结构。"
          },
          {
            title: "01 Reader Tasks",
            page_type: "index",
            source_signals: ["actions"],
            markdown: "# 01 Reader Tasks\n\n## 读者任务\n- 先理解项目背景\n- 再确认 SOP 草案"
          },
          {
            title: "02 Archive",
            page_type: "sources",
            source_signals: ["sources"],
            markdown: "# 02 Archive\n\n## 来源\n- https://example.feishu.cn/minutes/min_001"
          }
        ]
      }
    ]);

    const draft = await runKnowledgeCuratorAgent({
      topicName: "项目背景主题知识库",
      owner: null,
      meetings: [meeting()],
      actions: [action()],
      calendars: [],
      confidenceOrigin: 0.7,
      llm
    });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].schemaName).toBe("KnowledgeBaseDraft");
    expect(llm.calls[0].systemPrompt).toContain("像一个会使用 Skill 的策展人");
    expect(llm.calls[0].userPrompt).toContain("本次会议同步项目背景");
    expect(llm.calls[0].userPrompt).toContain("https://example.feishu.cn/minutes/min_001");
    expect(llm.calls[0].userPrompt).not.toContain("这是一段完整转写");
    expect(draft).toMatchObject({
      name: "LLM 策展知识库",
      status: "active",
      created_from_meetings: ["mtg_1"]
    });
    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 Dashboard",
      "01 Reader Tasks",
      "02 Archive"
    ]);
    expect(renderKnowledgeBaseMarkdown(draft)).toContain("LLM 自行选择首页结构");
  });

  it("keeps a thin deterministic fallback for mock or exhausted LLM paths", async () => {
    const draft = await runKnowledgeCuratorAgent({
      topicName: "无人机 SOP 主题知识库",
      owner: "张三",
      meetings: [
        meeting({
          title: "无人机 SOP 评审",
          summary: "本次会议明确需要建立统一 SOP，并指出试飞权限未确认会影响排期。",
          transcript_text: "完整转写仍然不应进入知识库正文。",
          keywords_json: JSON.stringify(["无人机", "SOP"])
        })
      ],
      actions: [action()],
      calendars: [calendar()],
      confidenceOrigin: 0.88,
      llm: new QueueLlmClient([])
    });

    const markdown = renderKnowledgeBaseMarkdown(draft);

    expect(draft.pages.map((page) => page.page_type)).toEqual([
      "home",
      "index",
      "analysis",
      "sources",
      "board",
      "timeline",
      "calendar"
    ]);
    expect(markdown).toContain("deterministic fallback");
    expect(markdown).toContain("不做代码分类");
    expect(markdown).toContain("https://example.feishu.cn/minutes/min_001");
    expect(markdown).toContain("https://example.feishu.cn/minutes/transcript_001");
    expect(markdown).toContain("整理 SOP 草案");
    expect(markdown).toContain("SOP 评审会");
    expect(markdown).not.toContain("完整转写仍然不应进入知识库正文");
  });
});
