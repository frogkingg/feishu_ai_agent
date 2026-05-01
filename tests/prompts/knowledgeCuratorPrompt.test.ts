import { readPrompt } from "../../src/utils/prompts";

describe("knowledgeCurator prompt", () => {
  const prompt = readPrompt("knowledgeCurator.md");

  it("documents the reusable curator guide", () => {
    expect(prompt).toContain("会使用 Skill 的策展人");
    expect(prompt).toContain("代码只提供摘要、行动项、日程和来源引用");
    expect(prompt).toContain("你负责判断会议关系");
    expect(prompt).toContain("自由决定");
    expect(prompt).toContain("Dashboard / Overview");
    expect(prompt).toContain("Archive");
    expect(prompt).toContain("不要把完整 transcript 写进知识库");
    expect(prompt).toContain("KnowledgeBaseDraft schema");
    expect(prompt).toContain("SSOT 校验");
    expect(prompt).toContain("不要硬编码");
    expect(prompt).not.toContain("职场 Offer");
  });
});
