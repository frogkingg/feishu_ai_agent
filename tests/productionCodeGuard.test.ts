import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? listFiles(path) : [path];
  });
}

describe("production code guardrails", () => {
  it("does not contain personal-name or domain-specific challenge hardcoding in src", () => {
    const blockedTerms = [
      "Henry",
      "比赛",
      "校园",
      "飞书 AI",
      "复赛",
      "决赛",
      "路演",
      "GitHub public",
      "阶段成果",
      "豆包",
      "Openclaw",
      "评分标准",
      "参赛"
    ];
    const files = listFiles(join(process.cwd(), "src")).filter((path) =>
      /\.(ts|tsx|js|jsx|md)$/.test(path)
    );
    const violations = files.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return blockedTerms
        .filter((term) => source.includes(term))
        .map((term) => `${relative(process.cwd(), path)} contains ${term}`);
    });

    expect(violations).toEqual([]);
  });
});
