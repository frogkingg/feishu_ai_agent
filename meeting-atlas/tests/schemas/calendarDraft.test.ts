import { CalendarEventDraftSchema } from "../../src/schemas";

describe("CalendarEventDraftSchema", () => {
  it("accepts a valid review meeting draft", () => {
    const parsed = CalendarEventDraftSchema.parse({
      title: "无人机风险评审会",
      start_time: "2026-04-28T10:00:00+08:00",
      end_time: "2026-04-28T11:00:00+08:00",
      duration_minutes: 60,
      participants: ["张三", "李四"],
      agenda: "评审试飞权限和风险控制",
      location: null,
      evidence: "下周二上午 10 点再做一次风险评审",
      confidence: 0.82,
      missing_fields: []
    });

    expect(parsed.title).toBe("无人机风险评审会");
  });

  it("requires start_time in missing_fields when the time is unclear", () => {
    expect(() =>
      CalendarEventDraftSchema.parse({
        title: "无人机操作员访谈",
        start_time: null,
        end_time: null,
        duration_minutes: null,
        participants: ["张三"],
        agenda: null,
        location: null,
        evidence: "下周找操作员访谈一下",
        confidence: 0.62,
        missing_fields: []
      })
    ).toThrow(/start_time/);
  });

  it("rejects task due-date language as a calendar draft", () => {
    expect(() =>
      CalendarEventDraftSchema.parse({
        title: "周五前完成方案",
        start_time: null,
        end_time: null,
        duration_minutes: null,
        participants: [],
        agenda: null,
        location: null,
        evidence: "周五前完成方案",
        confidence: 0.8,
        missing_fields: ["start_time"]
      })
    ).toThrow(/calendar draft requires/);
  });
});
