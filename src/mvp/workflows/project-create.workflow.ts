import { NormalizedMessageEvent } from "../../llm/schemas";
import { intakeAgent } from "../agents/intake-agent";
import { plannerAgent } from "../agents/planner-agent";
import { formatProjectCreateDraft } from "../agents/comms-agent";
import { MvpHandledResult } from "../schemas";
import { createPendingDraft } from "../store";

export async function handleProjectCreateWorkflow(event: NormalizedMessageEvent): Promise<MvpHandledResult> {
  if (!event.chatId) {
    return { handled: true, replyText: "我识别到了立项请求，但缺少 chatId，先不生成项目草案。" };
  }

  const spec = await intakeAgent(event.text);
  const plan = await plannerAgent(spec);
  const draft = createPendingDraft("project_create", event.chatId, { spec, plan }, spec.projectId);

  return {
    handled: true,
    replyText: formatProjectCreateDraft(draft.draftId, spec, plan),
  };
}
