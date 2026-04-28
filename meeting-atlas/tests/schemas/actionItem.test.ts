import { ActionItemDraftSchema } from "../../src/schemas";

describe("ActionItemDraftSchema", () => {
  it("accepts a valid action item draft", () => {
    const parsed = ActionItemDraftSchema.parse({
      title: "整理现有操作流程",
      description: "输出一页流程图",
      owner: "张三",
      collaborators: [],
      due_date: "2026-05-01",
      priority: "P1",
      evidence: "张三整理现有操作流程，周五前给大家看",
      confidence: 0.86,
      suggested_reason: "会议中明确点名张三负责",
      missing_fields: []
    });

    expect(parsed.due_date).toBe("2026-05-01");
  });

  it("rejects empty title, empty evidence, invalid confidence, and loose date format", () => {
    expect(() =>
      ActionItemDraftSchema.parse({
        title: "",
        description: null,
        owner: null,
        collaborators: [],
        due_date: "next Friday",
        priority: null,
        evidence: "",
        confidence: 1.2,
        suggested_reason: "bad sample",
        missing_fields: ["owner", "due_date"]
      })
    ).toThrow();
  });
});
