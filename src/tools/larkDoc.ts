import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateDocResult {
  doc_token: string;
  doc_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

const MarkdownChunkSize = 1800;

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

function parseCreatedDoc(parsed: unknown): { docToken: string; docUrl: string | null } | null {
  const root = asRecord(parsed);
  const node = nestedRecord(parsed, ["node"]) ?? nestedRecord(parsed, ["data", "node"]);
  const docToken = firstString([root?.obj_token, root?.doc_token, node?.obj_token]);
  if (docToken === null) {
    return null;
  }

  return {
    docToken,
    docUrl: firstString([root?.doc_url, root?.url, node?.doc_url, node?.url, node?.obj_url])
  };
}

function chunkMarkdown(content: string): string[] {
  if (content.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += MarkdownChunkSize) {
    chunks.push(content.slice(index, index + MarkdownChunkSize));
  }
  return chunks;
}

export async function createDoc(input: {
  repos: Repositories;
  config: AppConfig;
  title: string;
  markdownContent: string;
  parentNodeToken?: string;
  spaceId?: string;
  runner?: LarkCliRunner;
}): Promise<CreateDocResult> {
  const draftId = `dry_doc_${input.title.slice(0, 16)}`;
  const createNodeArgs = [
    "wiki",
    "nodes",
    "create",
    "--params",
    JSON.stringify({ space_id: input.spaceId ?? "" }),
    "--data",
    JSON.stringify({
      node_type: "origin",
      obj_type: "doc",
      parent_node_token: input.parentNodeToken,
      title: input.title
    })
  ];

  const nodeResult = await runLarkCli(createNodeArgs, {
    repos: input.repos,
    config: input.config,
    toolName: "lark.wiki.node.create",
    dryRun: input.config.feishuDryRun,
    expectJson: true,
    runner: input.runner
  });

  if (nodeResult.dryRun || nodeResult.status === "planned") {
    return {
      doc_token: draftId,
      doc_url: `mock://feishu/doc/${draftId}`,
      dry_run: true,
      cli_run_id: nodeResult.id
    };
  }

  if (nodeResult.status === "failed") {
    throw new Error(`lark.wiki.node.create failed: ${nodeResult.error ?? "unknown error"}`);
  }

  const createdDoc = parseCreatedDoc(nodeResult.parsed);
  if (createdDoc === null) {
    throw new Error("lark.wiki.node.create succeeded without obj_token");
  }

  for (const chunk of chunkMarkdown(input.markdownContent)) {
    const appendResult = await runLarkCli(
      [
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        createdDoc.docToken,
        "--markdown",
        chunk,
        "--mode",
        "append"
      ],
      {
        repos: input.repos,
        config: input.config,
        toolName: "lark.doc.content.append",
        dryRun: false,
        expectJson: true,
        runner: input.runner
      }
    );

    if (appendResult.status === "failed") {
      throw new Error(`lark.doc.content.append failed: ${appendResult.error ?? "unknown error"}`);
    }
  }

  return {
    doc_token: createdDoc.docToken,
    doc_url: createdDoc.docUrl ?? `https://www.feishu.cn/doc/${createdDoc.docToken}`,
    dry_run: false,
    cli_run_id: nodeResult.id
  };
}
