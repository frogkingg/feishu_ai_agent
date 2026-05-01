import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function candidatePromptDirs(): string[] {
  return [
    process.env.MEETINGATLAS_PROMPT_DIR,
    join(process.cwd(), "src/prompts"),
    join(process.cwd(), "prompts"),
    join(__dirname, "../prompts"),
    join(__dirname, "../../../src/prompts")
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function readPrompt(name: string): string {
  const attempted = candidatePromptDirs().map((dir) => join(dir, name));
  const promptPath = attempted.find((path) => existsSync(path));
  if (!promptPath) {
    throw new Error(`Prompt file ${name} not found. Checked: ${attempted.join(", ")}`);
  }

  return readFileSync(promptPath, "utf8");
}
