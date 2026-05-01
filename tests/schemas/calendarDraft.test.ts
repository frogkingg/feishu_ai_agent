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

  it("accepts a draft with missing start_time as structure-only validation", () => {
    const parsed = CalendarEventDraftSchema.parse({
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
    });

    expect(parsed.start_time).toBeNull();
  });

  it("does not classify task due-date language in the schema", () => {
    const parsed = CalendarEventDraftSchema.parse({
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
    });

    expect(parsed.title).toBe("周五前完成方案");
  });

  it("removes filled end_time and duration from missing fields", () => {
    const parsed = CalendarEventDraftSchema.parse({
      title: "客户访谈复盘会",
      start_time: "2026-05-08T15:00:00+08:00",
      end_time: "2026-05-08T16:00:00+08:00",
      duration_minutes: 60,
      participants: ["张三"],
      agenda: "复盘客户访谈结论",
      location: null,
      evidence: "周五 15 点开客户访谈复盘会，预计 1 小时。",
      confidence: 0.86,
      missing_fields: ["end_time", "duration_minutes", "duration", "location"]
    });

    expect(parsed.missing_fields).toEqual(["location"]);
  });
});
