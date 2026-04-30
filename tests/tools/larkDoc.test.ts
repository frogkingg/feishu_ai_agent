import { loadConfig } from "../../src/config";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { createDoc } from "../../src/tools/larkDoc";
import { type LarkCliRunner } from "../../src/tools/larkCli";

describe("larkDoc.createDoc", () => {
  it("returns a mock doc URL in dry-run mode", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    const result = await createDoc({
      repos,
      config: loadConfig({ feishuDryRun: true }),
      title: "00 首页 / 总览",
      markdownContent: "# 首页",
      spaceId: "spc_dry",
      parentNodeToken: "wik_dry",
      runner
    });

    expect(result).toMatchObject({
      doc_token: "dry_doc_00 首页 / 总览",
      doc_url: "mock://feishu/doc/dry_doc_00 首页 / 总览",
      dry_run: true
    });
    expect(calls).toHaveLength(0);
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.wiki.node.create",
      dry_run: 1,
      status: "planned"
    });
  });

  it("creates a doc node and appends markdown in chunks no larger than 1800 characters", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      if (args[0] === "wiki") {
        return {
          stdout: JSON.stringify({
            node: {
              obj_token: "doc_real",
              url: "https://example.feishu.cn/doc/doc_real"
            }
          }),
          stderr: ""
        };
      }
      return {
        stdout: JSON.stringify({ ok: true }),
        stderr: ""
      };
    };
    const markdownContent = `${"a".repeat(1800)}${"b".repeat(50)}`;

    const result = await createDoc({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      title: "详细页面",
      markdownContent,
      spaceId: "spc_real",
      parentNodeToken: "wik_parent",
      runner
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      "wiki",
      "nodes",
      "create",
      "--params",
      JSON.stringify({ space_id: "spc_real" }),
      "--data",
      JSON.stringify({
        node_type: "origin",
        obj_type: "doc",
        parent_node_token: "wik_parent",
        title: "详细页面"
      })
    ]);
    expect(calls[1]).toEqual([
      "docs",
      "+update",
      "--api-version",
      "v2",
      "--doc",
      "doc_real",
      "--markdown",
      "a".repeat(1800),
      "--mode",
      "append"
    ]);
    expect(calls[2]).toEqual([
      "docs",
      "+update",
      "--api-version",
      "v2",
      "--doc",
      "doc_real",
      "--markdown",
      "b".repeat(50),
      "--mode",
      "append"
    ]);
    expect(result).toMatchObject({
      doc_token: "doc_real",
      doc_url: "https://example.feishu.cn/doc/doc_real",
      dry_run: false
    });
    expect(repos.listCliRuns()).toHaveLength(3);
  });
});
