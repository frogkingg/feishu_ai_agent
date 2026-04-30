import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateWikiSpaceResult {
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
      return value;
    }
  }

  return null;
}

export async function createWikiSpace(input: {
  repos: Repositories;
  config?: AppConfig;
  name: string;
  runner?: LarkCliRunner;
}): Promise<CreateWikiSpaceResult> {
  const result = await runLarkCli(
    [
      "wiki",
      "+node-create",
      "--space-id",
      "my_library",
      "--title",
      input.name,
      "--obj-type",
      "docx",
      "--as",
      "user"
    ],
    {
      repos: input.repos,
      config: input.config,
      toolName: "lark.wiki.node_create",
      dryRun: input.config?.feishuDryRun,
      expectJson: true,
      runner: input.runner
    }
  );

  if (result.dryRun || result.status === "planned") {
    const nodeToken = `dry_node_${input.name.slice(0, 16)}`;
    return {
      wiki_space_id: `wiki_${input.name.slice(0, 16)}`,
      wiki_space_url: `mock://feishu/wiki/${nodeToken}`,
      homepage_node_token: nodeToken,
      homepage_url: `mock://feishu/wiki/${nodeToken}`,
      dry_run: true,
      cli_run_id: result.id
    };
  }

  if (result.status === "failed") {
    throw new Error(`lark.wiki.node_create failed: ${result.error ?? "unknown error"}`);
  }

  const data = asRecord(asRecord(result.parsed)?.data);
  const nodeToken = firstString([data?.node_token]);
  const url = firstString([data?.url]);
  const spaceId = firstString([data?.space_id, data?.resolved_space_id]);

  if (nodeToken === null) {
    throw new Error("lark.wiki.node_create succeeded without node_token");
  }

  return {
    wiki_space_id: spaceId ?? `wiki_${input.name.slice(0, 16)}`,
    wiki_space_url: url ?? `mock://feishu/wiki/${nodeToken}`,
    homepage_node_token: nodeToken,
    homepage_url: url ?? `mock://feishu/wiki/${nodeToken}`,
    dry_run: false,
    cli_run_id: result.id
  };
}
