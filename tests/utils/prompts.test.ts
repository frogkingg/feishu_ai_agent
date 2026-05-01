import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrompt } from "../../src/utils/prompts";

describe("readPrompt", () => {
  it("reads prompts when the runtime cwd is not the repository root", () => {
    const originalCwd = process.cwd();
    const runtimeCwd = mkdtempSync(join(tmpdir(), "meeting-atlas-runtime-"));

    try {
      process.chdir(runtimeCwd);
      expect(readPrompt("meetingExtraction.md")).toContain("会议纪要分析 Agent");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
