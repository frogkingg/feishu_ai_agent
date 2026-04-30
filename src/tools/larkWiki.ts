import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateWikiResult {
  wiki_space_id: string;
  wiki_space_url: string;
  homepage_node_token: string;
  homepage_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function nestedRecord(root: unknown, keys: string[]): Record<string, unknown> | null {
  let current: unknown = root;
  for (const key of keys) {
    const record = asRecord(current);
    if (record === null) {
      return null;
    }
    current = record[key];
  }
  return asRecord(current);
}

function parseSpace(parsed: unknown): { spaceId: string; spaceUrl: string | null } | null {
  const root = asRecord(parsed);
  const space = nestedRecord(parsed, ["space"]) ?? nestedRecord(parsed, ["data", "space"]);
  const spaceId = firstString([root?.space_id, space?.space_id]);
  if (spaceId === null) {
    return null;
  }

  return {
    spaceId,
    spaceUrl: firstString([
      root?.wiki_space_url,
      root?.space_url,
      root?.url,
      space?.wiki_space_url,
      space?.space_url,
      space?.url
    ])
  };
}

function parseNode(parsed: unknown): { nodeToken: string; homepageUrl: string | null } | null {
  const root = asRecord(parsed);
  const node = nestedRecord(parsed, ["node"]) ?? nestedRecord(parsed, ["data", "node"]);
  const nodeToken = firstString([root?.node_token, node?.node_token]);
  if (nodeToken === null) {
    return null;
  }

  return {
    nodeToken,
    homepageUrl: firstString([
      root?.homepage_url,
      root?.url,
      node?.homepage_url,
      node?.url,
      node?.node_url
    ])
  };
}

export async function createWikiSpace(input: {
  repos: Repositories;
  config: AppConfig;
  name: string;
  description: string;
  runner?: LarkCliRunner;
}): Promise<CreateWikiResult> {
  const createSpaceArgs = [
    "wiki",
    "spaces",
    "create",
    "--data",
    JSON.stringify({
      name: input.name,
      description: input.description
    })
  ];

  const spaceResult = await runLarkCli(createSpaceArgs, {
    repos: input.repos,
    config: input.config,
    toolName: "lark.wiki.space.create",
    dryRun: input.config.feishuDryRun,
    expectJson: true,
    runner: input.runner
  });

  if (spaceResult.dryRun || spaceResult.status === "planned") {
    const draftId = `dry_wiki_${input.name.slice(0, 16)}`;
    return {
      wiki_space_id: draftId,
      wiki_space_url: `mock://feishu/wiki/${draftId}`,
      homepage_node_token: `dry_node_${draftId}`,
      homepage_url: `mock://feishu/wiki/${draftId}/home`,
      dry_run: true,
      cli_run_id: spaceResult.id
    };
  }

  if (spaceResult.status === "failed") {
    throw new Error(`lark.wiki.space.create failed: ${spaceResult.error ?? "unknown error"}`);
  }

  const space = parseSpace(spaceResult.parsed);
  if (space === null) {
    throw new Error("lark.wiki.space.create succeeded without space_id");
  }

  const nodeResult = await runLarkCli(
    [
      "wiki",
      "nodes",
      "create",
      "--params",
      JSON.stringify({ space_id: space.spaceId }),
      "--data",
      JSON.stringify({
        node_type: "origin",
        obj_type: "doc",
        title: "00 首页 / 总览"
      })
    ],
    {
      repos: input.repos,
      config: input.config,
      toolName: "lark.wiki.node.create",
      dryRun: false,
      expectJson: true,
      runner: input.runner
    }
  );

  if (nodeResult.status === "failed") {
    throw new Error(`lark.wiki.node.create failed: ${nodeResult.error ?? "unknown error"}`);
  }

  const node = parseNode(nodeResult.parsed);
  if (node === null) {
    throw new Error("lark.wiki.node.create succeeded without node_token");
  }

  return {
    wiki_space_id: space.spaceId,
    wiki_space_url: space.spaceUrl ?? `https://www.feishu.cn/wiki/space/${space.spaceId}`,
    homepage_node_token: node.nodeToken,
    homepage_url: node.homepageUrl ?? `https://www.feishu.cn/wiki/${node.nodeToken}`,
    dry_run: false,
    cli_run_id: spaceResult.id
  };
}
