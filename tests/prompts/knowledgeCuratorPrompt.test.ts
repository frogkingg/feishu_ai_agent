import { readPrompt } from "../../src/utils/prompts";

describe("knowledgeCurator prompt", () => {
  const prompt = readPrompt("knowledgeCurator.md");

  it("documents the reusable curator guide", () => {
    expect(prompt).toContain("像 Claude 自己读完会议");
    expect(prompt).toContain("代码只负责提供会议上下文");
    expect(prompt).toContain("你负责判断会议关系");
    expect(prompt).toContain("PRD 页面结构要求");
    expect(prompt).toContain("00 首页 / 总览");
    expect(prompt).toContain("当前状态");
    expect(prompt).toContain("05 待办与日程索引");
    expect(prompt).toContain("单会总结");
    expect(prompt).toContain("转写引用");
    expect(prompt).toContain("不要把完整 transcript 写进知识库");
    expect(prompt).toContain("KnowledgeBaseDraft schema");
    expect(prompt).toContain("SSOT 校验");
    expect(prompt).toContain("不要用固定行业模板");
    expect(prompt).not.toContain("职场 Offer");
  });
});
