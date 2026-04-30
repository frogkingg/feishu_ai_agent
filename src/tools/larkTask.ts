import { AppConfig } from "../config";
import { ActionItemRow, Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateTaskResult {
  feishu_task_guid: string;
  task_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function taskFromParsed(parsed: unknown): Record<string, unknown> | null {
  const root = asRecord(parsed);
  return asRecord(asRecord(root?.data)?.task) ?? asRecord(root?.task);
}

export async function createTask(input: {
  repos: Repositories;
  config?: AppConfig;
  draft: ActionItemRow;
  runner?: LarkCliRunner;
}): Promise<CreateTaskResult> {
  const args = [
    "task",
    "+create",
    "--summary",
    input.draft.title,
    "--description",
    input.draft.description ?? "",
    "--due",
    input.draft.due_date ?? "",
    "--assignee",
    input.draft.owner ?? "",
    "--as",
    "user"
  ];

  const result = await runLarkCli(args, {
    repos: input.repos,
    config: input.config,
    toolName: "lark.task.create",
    dryRun: input.config?.feishuDryRun,
    expectJson: true,
    runner: input.runner
  });

  if (result.dryRun || result.status === "planned") {
    return {
      feishu_task_guid: `dry_task_${input.draft.id}`,
      task_url: `mock://feishu/task/${input.draft.id}`,
      dry_run: true,
      cli_run_id: result.id
    };
  }

  if (result.status === "failed") {
    throw new Error(`lark.task.create failed: ${result.error ?? "unknown error"}`);
  }

  const task = taskFromParsed(result.parsed);
  const guid = task?.guid;
  const applink = task?.applink;
  if (
    typeof guid !== "string" ||
    guid.length === 0 ||
    typeof applink !== "string" ||
    applink.length === 0
  ) {
    throw new Error("lark.task.create succeeded without task guid/applink");
  }

  return {
    feishu_task_guid: guid,
    task_url: applink,
    dry_run: false,
    cli_run_id: result.id
  };
}
