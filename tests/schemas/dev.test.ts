import { ManualMeetingInputSchema } from "../../src/schemas";

describe("ManualMeetingInputSchema", () => {
  it("accepts optional minutes and transcript urls", () => {
    const parsed = ManualMeetingInputSchema.parse({
      title: "无人机操作方案风险评审",
      participants: ["张三"],
      organizer: "张三",
      started_at: "2026-05-03T10:00:00+08:00",
      ended_at: "2026-05-03T11:00:00+08:00",
      minutes_url: "https://example.feishu.cn/minutes/min_003",
      transcript_url: "https://example.feishu.cn/minutes/transcript_003",
      transcript_text: "会议确认继续沉淀风险控制。"
    });

    expect(parsed.minutes_url).toBe("https://example.feishu.cn/minutes/min_003");
    expect(parsed.transcript_url).toBe("https://example.feishu.cn/minutes/transcript_003");
    expect(parsed.transcript_text).toContain("https://example.feishu.cn/minutes/min_003");
  });

  it("builds compact transcript_text from structured minutes fields", () => {
    const parsed = ManualMeetingInputSchema.parse({
      title: "项目复盘会",
      participants: ["张三"],
      organizer: "张三",
      started_at: "2026-05-03T10:00:00+08:00",
      ended_at: "2026-05-03T11:00:00+08:00",
      minutes_url: "https://example.feishu.cn/minutes/min_004",
      summary: "本次会议总结发布风险和后续动作。",
      todos: [{ text: "李四整理风险清单。" }],
      chapters: [{ title: "发布风险", summary: "聚焦阻塞项。" }],
      transcript_text: "逐字稿全文不应成为主输入。".repeat(600)
    });

    expect(parsed.transcript_text).toContain("MeetingAtlas minutes digest input");
    expect(parsed.transcript_text).toContain("本次会议总结发布风险");
    expect(parsed.transcript_text).toContain("李四整理风险清单");
    expect(parsed.transcript_text).toContain("full_transcript: omitted_by_design");
    expect(parsed.transcript_text.length).toBeLessThanOrEqual(7000);
  });
});
