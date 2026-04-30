import { loadConfig } from "../../src/config";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { runLarkCli } from "../../src/tools/larkCli";

describe("runLarkCli", () => {
  it("records dry-run without executing the lark binary", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await runLarkCli(["task", "create", "--token", "secret-token"], {
      repos,
      config: loadConfig({
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark"
      }),
      toolName: "lark.task.create",
      expectJson: true
    });

    expect(result.status).toBe("planned");
    expect(result.dryRun).toBe(true);
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0].args_json).toContain("[REDACTED]");
  });

  it("parses raw stdout while storing redacted stdout", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await runLarkCli(["wiki", "+node-create"], {
      repos,
      config: loadConfig({
        feishuDryRun: false,
        larkCliBin: "fake-lark"
      }),
      toolName: "lark.wiki.node_create",
      expectJson: true,
      runner: async () => ({
        stdout: JSON.stringify({ data: { obj_token: "doc_secret" } }),
        stderr: ""
      })
    });

    expect(result.parsed).toEqual({ data: { obj_token: "doc_secret" } });
    expect(result.stdout).toContain("[REDACTED]");
    expect(repos.listCliRuns()[0].stdout).toContain("[REDACTED]");
  });
});
