import { runLarkCli } from "../../lark/cli";
import { appendProjectArtifacts, appendToolRun } from "../store";
import {
  MeetingExtraction,
  MvpProjectState,
  ProjectPlan,
  ProjectSpec,
  ProjectTaskDraft,
  ProjectWorkspace,
  LarkWriteMode,
  nowIso,
} from "../schemas";
import {
  appendMeetingSummary as appendLocalMeetingSummary,
  writeMockMessage,
  writeProjectCreateArtifacts,
  writeProjectOverview as writeLocalProjectOverview,
  writeTaskPool as writeLocalTaskPool,
} from "./local-artifact-writer";

export interface LarkAdapterResult {
  ok: boolean;
  mode: LarkWriteMode;
  artifactPaths: string[];
  larkUrl: string | null;
  warning: string | null;
  raw?: unknown;
}

function getWriteMode(): LarkWriteMode {
  const raw = process.env.PROJECTPILOT_LARK_WRITE_MODE;
  return raw === "mock" || raw === "cli" || raw === "hybrid" ? raw : "hybrid";
}

function fallbackWarning(reason: string) {
  return `已使用本地模拟写入，缺少真实飞书写入权限/命令未打通：${reason}`;
}

function result(
  mode: LarkWriteMode,
  artifactPaths: string[],
  warning: string | null,
  raw?: unknown,
): LarkAdapterResult {
  return {
    ok: true,
    mode,
    artifactPaths,
    larkUrl: null,
    warning,
    raw,
  };
}

async function runWithFallback(
  operation: string,
  mockAction: () => string[],
  cliAction?: () => Promise<unknown>,
): Promise<LarkAdapterResult> {
  const mode = getWriteMode();
  if (mode === "mock") {
    const artifactPaths = mockAction();
    appendToolRun({ operation, mode, ok: true, artifactPaths });
    return result("mock", artifactPaths, null);
  }

  if (cliAction) {
    try {
      const raw = await cliAction();
      appendToolRun({ operation, mode: "cli", ok: true, raw });
      return result("cli", [], null, raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mode === "cli") {
        const artifactPaths = mockAction();
        const warning = fallbackWarning(message);
        appendToolRun({ operation, mode: "cli", ok: false, fallback: "mock", warning, artifactPaths });
        return result("mock", artifactPaths, warning);
      }
      const artifactPaths = mockAction();
      const warning = fallbackWarning(message);
      appendToolRun({ operation, mode: "hybrid", ok: false, fallback: "mock", warning, artifactPaths });
      return result("mock", artifactPaths, warning);
    }
  }

  const artifactPaths = mockAction();
  const warning = fallbackWarning(`${operation} 的真实 CLI 写入命令尚未打通`);
  appendToolRun({ operation, mode, ok: false, fallback: "mock", warning, artifactPaths });
  return result("mock", artifactPaths, warning);
}

export class LarkAdapter {
  async createProjectWorkspace(spec: ProjectSpec, plan: ProjectPlan): Promise<ProjectWorkspace> {
    const writeResult = await runWithFallback("createProjectWorkspace", () => writeProjectCreateArtifacts(spec, plan));
    return {
      projectId: spec.projectId,
      mode: writeResult.mode,
      artifactPaths: writeResult.artifactPaths,
      larkUrl: writeResult.larkUrl,
      warning: writeResult.warning,
      createdAt: nowIso(),
    };
  }

  async writeProjectOverview(project: MvpProjectState): Promise<LarkAdapterResult> {
    const writeResult = await runWithFallback("writeProjectOverview", () => [writeLocalProjectOverview(project)]);
    appendProjectArtifacts(project.projectId, writeResult.artifactPaths);
    return writeResult;
  }

  async writeTaskPool(projectId: string, tasks: ProjectTaskDraft[]): Promise<LarkAdapterResult> {
    const writeResult = await runWithFallback("writeTaskPool", () => [writeLocalTaskPool(projectId, tasks)]);
    appendProjectArtifacts(projectId, writeResult.artifactPaths);
    return writeResult;
  }

  async createFeishuTasks(projectId: string, tasks: ProjectTaskDraft[]): Promise<LarkAdapterResult> {
    return runWithFallback("createFeishuTasks", () => [
      writeLocalTaskPool(
        `${projectId}_feishu_task_mock`,
        tasks.map((task) => ({
          ...task,
          evidence: `${task.evidence}\n(mock feishu task write)`,
        })),
      ),
    ]);
  }

  async appendMeetingSummary(projectId: string, extraction: MeetingExtraction): Promise<LarkAdapterResult> {
    const writeResult = await runWithFallback("appendMeetingSummary", () => [
      appendLocalMeetingSummary(projectId, extraction),
    ]);
    appendProjectArtifacts(projectId, writeResult.artifactPaths);
    return writeResult;
  }

  async sendTextMessage(chatId: string, text: string): Promise<LarkAdapterResult> {
    return runWithFallback(
      "sendTextMessage",
      () => [writeMockMessage(chatId, text)],
      () => runLarkCli(["im", "+messages-send", "--chat-id", chatId, "--text", text], "bot"),
    );
  }
}
