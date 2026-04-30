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
  });
});
