import { resolveDateExpression, resolveDateTimeExpression } from "../../src/utils/dates";

describe("relative date helpers", () => {
  const baseIso = "2026-04-29T19:00:00+08:00";

  it("resolves common relative dates from the meeting start date", () => {
    expect(resolveDateExpression({ baseIso, text: "今天下班前同步" })).toBe("2026-04-29");
    expect(resolveDateExpression({ baseIso, text: "明天前完成" })).toBe("2026-04-30");
    expect(resolveDateExpression({ baseIso, text: "后天补齐" })).toBe("2026-05-01");
    expect(resolveDateExpression({ baseIso, text: "本周五前完成" })).toBe("2026-05-01");
    expect(resolveDateExpression({ baseIso, text: "下周五前完成" })).toBe("2026-05-08");
    expect(resolveDateExpression({ baseIso, text: "下周再同步" })).toBe("2026-05-04");
    expect(resolveDateExpression({ baseIso, text: "月底给结论" })).toBe("2026-04-30");
  });

  it("only returns calendar start_time when both date and hour are explicit", () => {
    expect(
      resolveDateTimeExpression({
        baseIso,
        text: "下周五下午 3 点安排评审会"
      })
    ).toMatchObject({
      date: "2026-05-08",
      start_time: "2026-05-08T15:00:00+08:00",
      has_explicit_hour: true
    });
    expect(
      resolveDateTimeExpression({
        baseIso,
        text: "下周五安排评审会，具体几点待定"
      })
    ).toMatchObject({
      date: "2026-05-08",
      start_time: null,
      has_explicit_hour: false
    });
  });
});
