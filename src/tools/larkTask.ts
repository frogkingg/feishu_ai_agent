import { AppConfig } from "../config";
import { ActionItemRow, Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateTaskResult {
  feishu_task_guid: string;
  task_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

export async function createTask(input: {
  repos: Repositories;
  config?: AppConfig;
  draft: ActionItemRow;
  runner?: LarkCliRunner;
}): Promise<CreateTaskResult> {
  const args = [
    "task",
    "create",
    "--title",
    input.draft.title,
    "--description",
    input.draft.description ?? "",
    "--due-date",
    input.draft.due_date ?? "",
    "--owner",
    input.draft.owner ?? ""
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

  const parsed = result.parsed as { task_guid?: string; task_url?: string } | null;
  if (!parsed?.task_guid || !parsed?.task_url) {
    throw new Error("lark.task.create succeeded without task_guid/task_url");
  }

  return {
    feishu_task_guid: parsed.task_guid,
    task_url: parsed.task_url,
    dry_run: false,
    cli_run_id: result.id
  };
}
