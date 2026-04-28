import { NormalizedMessageEvent } from "../llm/schemas";
import { routeMvpCommand } from "./command-router";
import { MvpHandledResult } from "./schemas";
import { handleBriefingWorkflow, handleRiskScanWorkflow } from "./workflows/briefing.workflow";
import { handleConfirmationWorkflow } from "./workflows/confirmation.workflow";
import { handleMeetingIngestWorkflow } from "./workflows/meeting-ingest.workflow";
import { handleProjectCreateWorkflow } from "./workflows/project-create.workflow";

export async function handleMvpMessage(event: NormalizedMessageEvent): Promise<MvpHandledResult> {
  const route = routeMvpCommand(event);

  try {
    if (route.command === "project_create_request") {
      return handleProjectCreateWorkflow(event);
    }

    if (route.command === "confirm_draft" && route.draftId) {
      return handleConfirmationWorkflow(route.draftId);
    }

    if (route.command === "meeting_minutes_ingest") {
      return handleMeetingIngestWorkflow(event);
    }

    if (route.command === "project_brief") {
      return handleBriefingWorkflow(event);
    }

    if (route.command === "risk_scan") {
      return handleRiskScanWorkflow(event);
    }

    return { handled: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      replyText: `MVP 主链路处理失败：${message}`,
    };
  }
}
