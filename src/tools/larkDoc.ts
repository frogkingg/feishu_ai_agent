import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateDocResult {
  doc_token: string;
  doc_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

const MaxMarkdownChunkLength = 12000;

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

function chunkMarkdown(markdown: string): string[] {
  const trimmed = markdown.trim();
  if (trimmed.length <= MaxMarkdownChunkLength) {
    return trimmed.length > 0 ? [trimmed] : [];
  }

  const chunks: string[] = [];
  const blocks = trimmed.split(/\n{2,}/);
  let current = "";

  for (const block of blocks) {
    const next = current.length === 0 ? block : `${current}\n\n${block}`;
    if (next.length <= MaxMarkdownChunkLength) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }

    for (let index = 0; index < block.length; index += MaxMarkdownChunkLength) {
      chunks.push(block.slice(index, index + MaxMarkdownChunkLength));
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export async function createDoc(input: {
  repos: Repositories;
  config?: AppConfig;
  title: string;
  content?: string;
  markdownContent?: string;
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
    dryRun: input.config?.feishuKnowledgeWriteDryRun,
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
  const docToken = firstString([data?.obj_token]);
  const url = firstString([data?.url]);

  if (docToken === null) {
    throw new Error("lark.doc.create succeeded without obj_token");
  }

  const markdownContent = input.markdownContent ?? input.content ?? "";
  if (markdownContent.trim().length > 0) {
    const chunks = chunkMarkdown(markdownContent);
    for (const chunk of chunks) {
      const updateResult = await runLarkCli(
        [
          "docs",
          "+update",
          "--api-version",
          "v2",
          "--doc",
          docToken,
          "--command",
          "append",
          "--content",
          chunk,
          "--doc-format",
          "markdown",
          "--as",
          "user"
        ],
        {
          repos: input.repos,
          config: input.config,
          toolName: "lark.docs.update",
          dryRun: input.config?.feishuKnowledgeWriteDryRun,
          expectJson: true,
          runner: input.runner
        }
      );

      if (updateResult.status === "failed") {
        throw new Error(`lark.docs.update failed: ${updateResult.error ?? "unknown error"}`);
      }
    }
  }

  return {
    doc_token: docToken,
    doc_url: url ?? `mock://feishu/wiki/${nodeToken ?? docToken}`,
    dry_run: false,
    cli_run_id: result.id
  };
}
