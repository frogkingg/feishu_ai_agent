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
  it("asks the LLM to curate from rich bounded digest instead of transcript rules", async () => {
    const longSummary = [
      "本次会议同步项目背景、目标读者、SOP 草案和待确认风险。",
      "会议进一步说明当前状态是资料已收集但统一口径待确认。",
      "后续要把行动项、评审日程和来源资料组织成可继续深化的知识库。"
    ].join("");
    const longTranscript = [
      "摘录开头：张三说明 SOP 草案需要和风险清单一起沉淀。",
      "过程记录。".repeat(260),
      "完整转写尾部不应进入 curator prompt。"
    ].join("");
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
            title: "00 首页 / 总览",
            page_type: "home",
            source_signals: ["always"],
            markdown:
              "# 00 首页 / 总览\n\n## 当前状态\nLLM 自行判断当前状态。\n\n## 下一步\n- 确认 SOP\n\n## 关键结论\n- 需要沉淀项目背景\n\n## 未解决问题\n- 风险待确认"
          },
          {
            title: "01 整体目标",
            page_type: "goal",
            source_signals: ["actions"],
            markdown: "# 01 整体目标\n\n## 目标\n帮助读者理解项目背景。"
          },
          {
            title: "02 来源与转写引用",
            page_type: "sources",
            source_signals: ["sources"],
            markdown:
              "# 02 来源与转写引用\n\n## 来源\n- https://example.feishu.cn/minutes/min_001\n\n## 转写引用\n- https://example.feishu.cn/minutes/transcript_001"
          }
        ]
      }
    ]);

    const draft = await runKnowledgeCuratorAgent({
      topicName: "项目背景主题知识库",
      owner: null,
      meetings: [
        meeting({
          summary: longSummary,
          transcript_text: longTranscript
        })
      ],
      actions: [action()],
      calendars: [calendar()],
      confidenceOrigin: 0.7,
      llm
    });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].schemaName).toBe("KnowledgeBaseDraft");
    expect(llm.calls[0].systemPrompt).toContain("像 Claude 自己读完会议");
    expect(llm.calls[0].systemPrompt).toContain("00 首页 / 总览");
    expect(llm.calls[0].systemPrompt).toContain("当前状态");
    expect(llm.calls[0].userPrompt).toContain("会议进一步说明当前状态");
    expect(llm.calls[0].userPrompt).toContain("transcript_excerpt");
    expect(llm.calls[0].userPrompt).toContain("摘录开头：张三说明 SOP 草案");
    expect(llm.calls[0].userPrompt).not.toContain("完整转写尾部不应进入 curator prompt");
    expect(llm.calls[0].userPrompt).toContain("张三负责整理 SOP 草案");
    expect(llm.calls[0].userPrompt).toContain("SOP 评审会");
    expect(llm.calls[0].userPrompt).toContain("source_mapping");
    expect(llm.calls[0].userPrompt).toContain("prd_page_structure");
    expect(llm.calls[0].userPrompt).toContain("https://example.feishu.cn/minutes/min_001");
    expect(draft).toMatchObject({
      name: "LLM 策展知识库",
      status: "active",
      created_from_meetings: ["mtg_1"]
    });
    expect(draft.pages.map((page) => page.title)).toEqual([
      "00 首页 / 总览",
      "01 整体目标",
      "02 来源与转写引用"
    ]);
    expect(renderKnowledgeBaseMarkdown(draft)).toContain("LLM 自行判断当前状态");
  });

  it("repairs an invalid LLM draft once before using the final result", async () => {
    const llm = new QueueLlmClient([
      {
        name: "空页面草案",
        pages: []
      },
      {
        name: "修复后的知识库",
        goal: "帮助团队理解单会结论和下一步。",
        description: "已修复为可写入的知识库草案。",
        owner: null,
        confidence_origin: 0.91,
        related_keywords: ["SOP"],
        pages: [
          {
            title: "00 首页 / 总览",
            page_type: "home",
            source_signals: ["always"],
            markdown:
              "# 00 首页 / 总览\n\n## 当前状态\n已形成可用首页。\n\n## 下一步\n- 继续确认 SOP\n\n## 关键结论\n- 单会材料可以先沉淀\n\n## 未解决问题\n- 风险待补充"
          }
        ]
      }
    ]);

    const draft = await runKnowledgeCuratorAgent({
      topicName: "无人机 SOP 主题知识库",
      owner: "张三",
      meetings: [meeting()],
      actions: [action()],
      calendars: [calendar()],
      confidenceOrigin: 0.88,
      llm
    });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].schemaName).toBe("KnowledgeBaseDraft");
    expect(llm.calls[1].userPrompt).toContain("schema repair");
    expect(llm.calls[1].userPrompt).toContain("Knowledge curator LLM returned no pages");
    expect(draft).toMatchObject({
      name: "修复后的知识库",
      status: "active",
      created_from_meetings: ["mtg_1"]
    });
    expect(renderKnowledgeBaseMarkdown(draft)).toContain("单会材料可以先沉淀");
  });

  it("keeps a polished fallback for mock or exhausted LLM paths", async () => {
    const longTranscript = [
      "必要摘录：会议明确需要建立统一 SOP。",
      "详细逐字稿内容。".repeat(260),
      "完整转写仍然不应进入知识库正文。"
    ].join("");
    const draft = await runKnowledgeCuratorAgent({
      topicName: "无人机 SOP 主题知识库",
      owner: "张三",
      meetings: [
        meeting({
          title: "无人机 SOP 评审",
          summary: "本次会议明确需要建立统一 SOP，并指出试飞权限未确认会影响排期。",
          transcript_text: longTranscript,
          keywords_json: JSON.stringify(["无人机", "SOP"])
        })
      ],
      actions: [action()],
      calendars: [calendar()],
      confidenceOrigin: 0.88,
      llm: new QueueLlmClient([])
    });

    const markdown = renderKnowledgeBaseMarkdown(draft);

    expect(draft.pages.map((page) => page.page_type)).toEqual(
      expect.arrayContaining([
        "home",
        "goal",
        "analysis",
        "progress",
        "decisions",
        "board",
        "meetings",
        "meeting_summary",
        "transcript",
        "resources",
        "risks",
        "changelog"
      ])
    );
    expect(markdown).not.toMatch(/fallback|等待 LLM|正式结构由 LLM/u);
    expect(JSON.stringify(draft)).not.toMatch(/fallback|等待 LLM|正式结构由 LLM/u);
    expect(markdown).toContain("## 当前状态");
    expect(markdown).toContain("## 下一步");
    expect(markdown).toContain("## 关键结论");
    expect(markdown).toContain("## 未解决问题");
    expect(markdown).toContain("https://example.feishu.cn/minutes/min_001");
    expect(markdown).toContain("https://example.feishu.cn/minutes/transcript_001");
    expect(markdown).toContain("整理 SOP 草案");
    expect(markdown).toContain("SOP 评审会");
    expect(markdown).toContain("必要摘录：会议明确需要建立统一 SOP");
    expect(markdown).not.toContain("完整转写仍然不应进入知识库正文");
  });
});
