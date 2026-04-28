import { NormalizedMessageEvent } from "../../llm/schemas";
import { formatProjectBrief, formatRiskScan } from "../agents/comms-agent";
import { riskAgent } from "../agents/risk-agent";
import { MvpHandledResult } from "../schemas";
import { buildProjectBrief, getActiveProject } from "../store";

export async function handleBriefingWorkflow(event: NormalizedMessageEvent): Promise<MvpHandledResult> {
  if (!event.chatId) {
    return { handled: true, replyText: "缺少 chatId，无法读取当前项目简报。" };
  }

  const project = getActiveProject(event.chatId);
  if (!project) {
    return { handled: true, replyText: "当前群聊还没有 MVP 项目状态。先发“创建项目 ……”完成立项草案。" };
  }

  const brief = buildProjectBrief(project.projectId);
  const riskScan = riskAgent(project);
  return {
    handled: true,
    replyText: formatProjectBrief(project, brief, riskScan),
  };
}

export async function handleRiskScanWorkflow(event: NormalizedMessageEvent): Promise<MvpHandledResult> {
  if (!event.chatId) {
    return { handled: true, replyText: "缺少 chatId，无法读取当前项目风险。" };
  }

  const project = getActiveProject(event.chatId);
  if (!project) {
    return { handled: true, replyText: "当前群聊还没有 MVP 项目状态。先创建项目后我再做风险扫描。" };
  }

  return {
    handled: true,
    replyText: formatRiskScan(project, riskAgent(project)),
  };
}
