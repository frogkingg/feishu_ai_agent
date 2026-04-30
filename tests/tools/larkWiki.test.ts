import { loadConfig } from "../../src/config";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";
import { createWikiSpace } from "../../src/tools/larkWiki";

describe("larkWiki.createWikiSpace", () => {
  it("returns mock wiki URLs in dry-run mode without executing real CLI writes", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    const result = await createWikiSpace({
      repos,
      config: loadConfig({ feishuDryRun: true }),
      name: "项目知识库",
      description: "项目资料沉淀",
      runner
    });

    expect(result).toMatchObject({
      wiki_space_id: "dry_wiki_项目知识库",
      wiki_space_url: "mock://feishu/wiki/dry_wiki_项目知识库",
      homepage_node_token: "dry_node_dry_wiki_项目知识库",
      homepage_url: "mock://feishu/wiki/dry_wiki_项目知识库/home",
      dry_run: true
    });
    expect(calls).toHaveLength(0);
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.wiki.space.create",
      dry_run: 1,
      status: "planned"
    });
  });

  it("creates a real wiki space and homepage node through lark-cli", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      if (args.includes("spaces")) {
        return {
          stdout: JSON.stringify({
            space: {
              space_id: "spc_real",
              space_url: "https://example.feishu.cn/wiki/space/spc_real"
            }
          }),
          stderr: ""
        };
      }
      return {
        stdout: JSON.stringify({
          node: {
            node_token: "wik_home",
            url: "https://example.feishu.cn/wiki/wik_home"
          }
        }),
        stderr: ""
      };
    };

    const result = await createWikiSpace({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      name: "真实知识库",
      description: "真实写入",
      runner
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "wiki",
      "spaces",
      "create",
      "--data",
      JSON.stringify({ name: "真实知识库", description: "真实写入" })
    ]);
    expect(calls[1]).toEqual([
      "wiki",
      "nodes",
      "create",
      "--params",
      JSON.stringify({ space_id: "spc_real" }),
      "--data",
      JSON.stringify({
        node_type: "origin",
        obj_type: "doc",
        title: "00 首页 / 总览"
      })
    ]);
    expect(result).toMatchObject({
      wiki_space_id: "spc_real",
      wiki_space_url: "https://example.feishu.cn/wiki/space/spc_real",
      homepage_node_token: "wik_home",
      homepage_url: "https://example.feishu.cn/wiki/wik_home",
      dry_run: false
    });
    expect(repos.listCliRuns()).toHaveLength(2);
  });
});
