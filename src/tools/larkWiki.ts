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
  description?: string | null;
  runner?: LarkCliRunner;
}): Promise<CreateWikiSpaceResult> {
  const result = await runLarkCli(
    [
      "wiki",
      "spaces",
      "create",
      "--data",
      JSON.stringify({ name: input.name, description: input.description }),
      "--format",
      "json",
      "--yes",
      "--as",
      "user"
    ],
    {
      repos: input.repos,
      config: input.config,
      toolName: "lark.wiki.spaces.create",
      dryRun: false,
      expectJson: true,
      runner: input.runner
    }
  );

  if (result.status === "failed") {
    throw new Error(`lark.wiki.spaces.create failed: ${result.error ?? "unknown error"}`);
  }

  const space = asRecord(asRecord(result.parsed)?.data)?.space;
  const spaceRecord = asRecord(space);
  const spaceId = firstString([spaceRecord?.space_id]);

  if (!spaceId) {
    throw new Error("wiki spaces create succeeded without space_id");
  }

  const wikiUrl = `https://www.feishu.cn/wiki/${spaceId}`;

  return {
    wiki_space_id: spaceId,
    wiki_space_url: wikiUrl,
    homepage_node_token: spaceId,
    homepage_url: wikiUrl,
    dry_run: false,
    cli_run_id: result.id
  };
}
