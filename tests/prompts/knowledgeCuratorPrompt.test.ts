import { readPrompt } from "../../src/utils/prompts";

describe("knowledgeCurator prompt", () => {
  const prompt = readPrompt("knowledgeCurator.md");

  it("documents the reusable curator guide", () => {
    expect(prompt).toContain("会议关系诊断");
    expect(prompt).toContain("递进/项目型");
    expect(prompt).toContain("互补/系列型");
    expect(prompt).toContain("周期/例会型");
    expect(prompt).toContain("Dashboard / Overview");
    expect(prompt).toContain("Core Content");
    expect(prompt).toContain("Merged FAQ");
    expect(prompt).toContain("Archive");
    expect(prompt).toContain("SSOT 校验");
  });
});
