import { NormalizedMessageEvent } from "../llm/schemas";

export type MvpCommandName =
  | "project_create_request"
  | "confirm_draft"
  | "meeting_minutes_ingest"
  | "project_brief"
  | "risk_scan"
  | "unknown";

export interface MvpCommand {
  command: MvpCommandName;
  text: string;
  draftId?: string;
  confirmKind?: "project_create" | "plan_confirm" | "meeting_tasks_confirm";
}

const DEFAULT_BOT_NAMES = ["测试项目知识中枢 Agent", "ProjectPilot", "项目领航员", "机器人"];

function botNames() {
  return (process.env.PROJECTPILOT_BOT_NAMES || DEFAULT_BOT_NAMES.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripBotMention(text: string, event?: NormalizedMessageEvent) {
  let stripped = text;
  for (const mention of event?.mentions || []) {
    if (mention.name) {
      stripped = stripped.replace(new RegExp(`@\\s*${escapeRegExp(mention.name)}`, "gi"), "");
    }
  }
  for (const name of botNames()) {
    stripped = stripped.replace(new RegExp(`@\\s*${escapeRegExp(name)}`, "gi"), "");
  }
  return stripped.replace(/<at[^>]*>.*?<\/at>/gi, "").replace(/\s+/g, " ").trim();
}

export function routeMvpCommand(eventOrText: NormalizedMessageEvent | string): MvpCommand {
  const event = typeof eventOrText === "string" ? undefined : eventOrText;
  const text = stripBotMention(typeof eventOrText === "string" ? eventOrText : eventOrText.text, event);

  const confirmMatch = text.match(/^\s*确认\s*(立项|计划|创建任务)\s+(draft_[A-Za-z0-9_]+)/i);
  if (confirmMatch) {
    const kindText = confirmMatch[1];
    const confirmKind =
      kindText === "立项"
        ? "project_create"
        : kindText === "计划"
          ? "plan_confirm"
          : "meeting_tasks_confirm";
    return {
      command: "confirm_draft",
      text,
      draftId: confirmMatch[2],
      confirmKind,
    };
  }

  if (/(创建项目|新建项目|立项|帮我们创建一个项目)/.test(text)) {
    return { command: "project_create_request", text };
  }

  if (/(会议纪要|会后总结|Action Items|会议结论)/i.test(text) && text.length > 50) {
    return { command: "meeting_minutes_ingest", text };
  }

  if (/(项目简报|当前进展|项目状态)/.test(text)) {
    return { command: "project_brief", text };
  }

  if (/(风险扫描|检查风险|有什么风险)/.test(text)) {
    return { command: "risk_scan", text };
  }

  return { command: "unknown", text };
}
