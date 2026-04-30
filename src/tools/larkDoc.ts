import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateDocResult {
  doc_token: string;
  doc_url: string;
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

export async function createDoc(input: {
  repos: Repositories;
  config?: AppConfig;
  title: string;
  content?: string;
  spaceId?: string | null;
  parentNodeToken?: string | null;
  runner?: LarkCliRunner;
}): Promise<CreateDocResult> {
  const createArgs = [
    "wiki",
    "+node-create",
    "--space-id",
    input.spaceId ?? "my_library",
    "--title",
    input.title,
    "--obj-type",
    "docx",
    "--as",
    "user"
  ];

  if (input.parentNodeToken) {
    createArgs.push("--parent-node-token", input.parentNodeToken);
  }

  const result = await runLarkCli(createArgs, {
    repos: input.repos,
    config: input.config,
    toolName: "lark.doc.create",
    dryRun: input.config?.feishuDryRun,
    expectJson: true,
    runner: input.runner
  });

  if (result.dryRun || result.status === "planned") {
    const nodeToken = `dry_doc_${input.title.slice(0, 16)}`;
    return {
      doc_token: nodeToken,
      doc_url: `mock://feishu/wiki/${nodeToken}`,
      dry_run: true,
      cli_run_id: result.id
    };
  }

  if (result.status === "failed") {
    throw new Error(`lark.doc.create failed: ${result.error ?? "unknown error"}`);
  }

  const data = asRecord(asRecord(result.parsed)?.data);
  const nodeToken = firstString([data?.node_token]);
  const url = firstString([data?.url]);

  if (nodeToken === null) {
    throw new Error("lark.doc.create succeeded without node_token");
  }

  // TODO: write input.content into the created docx node once the CLI exposes a supported path.
  void input.content;

  return {
    doc_token: nodeToken,
    doc_url: url ?? `mock://feishu/wiki/${nodeToken}`,
    dry_run: false,
    cli_run_id: result.id
  };
}
