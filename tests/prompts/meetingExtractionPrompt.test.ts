import { readPrompt } from "../../src/utils/prompts";

describe("meetingExtraction prompt", () => {
  const prompt = readPrompt("meetingExtraction.md");

  it("documents ambiguous interface alignment as a calendar draft instead of an action item", () => {
    expect(prompt).toContain("下周找个时间做一次接口对齐沟通");
    expect(prompt).toContain('"title": "接口对齐沟通"');
    expect(prompt).toContain('"start_time": null');
    expect(prompt).toContain(
      '"missing_fields": ["start_time", "end_time", "duration_minutes", "participants", "location"]'
    );
    expect(prompt).toContain("不是 action item");
  });

  it("documents unowned SOP consensus as a decision instead of an action item", () => {
    expect(prompt).toContain("“建立 SOP”这类团队共识");
    expect(prompt).toContain("需要建立统一 SOP");
    expect(prompt).toContain("作为 key_decisions");
    expect(prompt).toContain("不要生成 action item");
  });
});
