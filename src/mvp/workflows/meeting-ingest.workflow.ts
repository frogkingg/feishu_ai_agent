import { NormalizedMessageEvent } from "../../llm/schemas";
import { formatMeetingDraft } from "../agents/comms-agent";
import { meetingAgent } from "../agents/meeting-agent";
import { MvpHandledResult } from "../schemas";
import { createPendingDraft, getActiveProject } from "../store";

export async function handleMeetingIngestWorkflow(event: NormalizedMessageEvent): Promise<MvpHandledResult> {
  if (!event.chatId) {
    return { handled: true, replyText: "我识别到了会议纪要，但缺少 chatId，无法挂到项目上。" };
  }

  const project = getActiveProject(event.chatId);
  if (!project) {
    return { handled: true, replyText: "还没有项目，请先创建项目。比如：创建项目，项目名……目标……负责人……" };
  }

  const extraction = await meetingAgent(event.text, project);
  const draft = createPendingDraft("meeting_tasks_confirm", event.chatId, extraction, project.projectId);

  return {
    handled: true,
    replyText: formatMeetingDraft(draft.draftId, extraction),
  };
}
