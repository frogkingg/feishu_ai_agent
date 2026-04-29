import { AppConfig, loadConfig } from "../config";
import { DryRunConfirmationCard } from "../schemas";
import { ConfirmationRequestRow, Repositories } from "../services/store/repositories";
import { runLarkCli } from "./larkCli";

export type LarkImIdentity = "bot" | "user";

export interface SendCardResult {
  ok: boolean;
  status: "planned" | "sent" | "failed";
  dry_run: boolean;
  cli_run_id: string | null;
  card_message_id: string | null;
  recipient: string | null;
  chat_id: string | null;
  identity: LarkImIdentity;
  error: string | null;
}

export interface SendCardInput {
  repos: Repositories;
  config?: AppConfig;
  confirmation?: ConfirmationRequestRow;
  card: DryRunConfirmationCard;
  recipient?: string | null;
  chatId?: string | null;
  identity?: LarkImIdentity;
}

interface FeishuText {
  tag: "plain_text" | "lark_md";
  content: string;
}

type FeishuCardElement =
  | {
      tag: "markdown";
      content: string;
    }
  | {
      tag: "hr";
    }
  | {
      tag: "div";
      text: FeishuText;
    }
  | {
      tag: "action";
      actions: Array<{
        tag: "button";
        text: FeishuText;
        type: "primary" | "danger" | "default";
        value: Record<string, unknown>;
      }>;
    };

interface FeishuInteractiveCard {
  config: {
    wide_screen_mode: boolean;
  };
  header: {
    template: "blue" | "red" | "grey";
    title: FeishuText;
  };
  elements: FeishuCardElement[];
}

function trimToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringifyCardValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => (item === null ? "未填写" : String(item))).join(", ");
  }

  return value === null || value === undefined ? "未填写" : String(value);
}

function fieldLine(field: DryRunConfirmationCard["sections"][number]["fields"][number]): string {
  return `**${field.label}**: ${field.value_text ?? stringifyCardValue(field.value)}`;
}

function buttonType(
  style: DryRunConfirmationCard["actions"][number]["style"]
): "primary" | "danger" | "default" {
  if (style === "primary") {
    return "primary";
  }
  if (style === "danger") {
    return "danger";
  }
  return "default";
}

function headerTemplate(card: DryRunConfirmationCard): "blue" | "red" | "grey" {
  if (card.status === "failed") {
    return "red";
  }
  if (["executed", "rejected"].includes(card.status)) {
    return "grey";
  }
  return "blue";
}

export function buildFeishuInteractiveCard(card: DryRunConfirmationCard): FeishuInteractiveCard {
  const elements: FeishuCardElement[] = [
    {
      tag: "markdown",
      content: `**${card.summary}**`
    },
    {
      tag: "hr"
    },
    ...card.sections.map((section) => ({
      tag: "div" as const,
      text: {
        tag: "lark_md" as const,
        content: [`**${section.title}**`, ...section.fields.map(fieldLine)]
          .filter(Boolean)
          .join("\n")
      }
    })),
    {
      tag: "hr"
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          "**安全说明**",
          "这只是确认卡片发送；点击确认前不会创建飞书任务、日程、Wiki 或 Doc。"
        ].join("\n")
      }
    }
  ];

  if (card.actions.length > 0) {
    elements.push({
      tag: "action",
      actions: card.actions.map((action) => ({
        tag: "button",
        text: {
          tag: "plain_text",
          content: action.label
        },
        type: buttonType(action.style),
        value: {
          request_id: card.request_id,
          action_key: action.key,
          endpoint: action.endpoint,
          payload_template: action.payload_template ?? {}
        }
      }))
    });
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate(card),
      title: {
        tag: "plain_text",
        content: card.title
      }
    },
    elements
  };
}

function buildDestinationArgs(input: {
  chatId: string | null;
  recipient: string | null;
}): string[] | null {
  if (input.chatId !== null) {
    return ["--chat-id", input.chatId];
  }

  if (input.recipient !== null) {
    return ["--user-id", input.recipient];
  }

  return null;
}

function messageIdFromParsed(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.message_id === "string" && record.message_id.length > 0) {
    return record.message_id;
  }

  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const dataRecord = data as Record<string, unknown>;
    if (typeof dataRecord.message_id === "string" && dataRecord.message_id.length > 0) {
      return dataRecord.message_id;
    }
  }

  return null;
}

function failedResult(input: {
  dryRun: boolean;
  cliRunId?: string | null;
  recipient: string | null;
  chatId: string | null;
  identity: LarkImIdentity;
  error: string;
}): SendCardResult {
  return {
    ok: false,
    status: "failed",
    dry_run: input.dryRun,
    cli_run_id: input.cliRunId ?? null,
    card_message_id: null,
    recipient: input.recipient,
    chat_id: input.chatId,
    identity: input.identity,
    error: input.error
  };
}

export async function sendCard(input: SendCardInput): Promise<SendCardResult> {
  const config = input.config ?? loadConfig();
  const chatId = trimToNull(input.chatId);
  const recipient = trimToNull(input.recipient ?? input.confirmation?.recipient ?? null);
  const identity = input.identity ?? "bot";
  const destinationArgs = buildDestinationArgs({ chatId, recipient });

  if (destinationArgs === null) {
    return failedResult({
      dryRun: config.feishuDryRun,
      recipient,
      chatId,
      identity,
      error: "lark.im.send_card requires recipient or chat_id"
    });
  }

  const cardContent = buildFeishuInteractiveCard(input.card);
  const args = [
    "im",
    "+messages-send",
    ...destinationArgs,
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(cardContent),
    "--as",
    identity,
    "--idempotency-key",
    `meeting-atlas-card-${input.card.request_id}`
  ];

  const result = await runLarkCli(args, {
    repos: input.repos,
    config,
    toolName: "lark.im.send_card",
    dryRun: config.feishuDryRun,
    expectJson: true
  });

  if (result.dryRun || result.status === "planned") {
    return {
      ok: true,
      status: "planned",
      dry_run: true,
      cli_run_id: result.id,
      card_message_id: null,
      recipient,
      chat_id: chatId,
      identity,
      error: null
    };
  }

  if (result.status === "failed") {
    return failedResult({
      dryRun: false,
      cliRunId: result.id,
      recipient,
      chatId,
      identity,
      error: `lark.im.send_card failed: ${result.error ?? "unknown error"}`
    });
  }

  const messageId = messageIdFromParsed(result.parsed);
  if (messageId === null) {
    return failedResult({
      dryRun: false,
      cliRunId: result.id,
      recipient,
      chatId,
      identity,
      error: "lark.im.send_card succeeded without message_id"
    });
  }

  if (input.confirmation) {
    input.repos.updateConfirmationCardMessage({
      id: input.confirmation.id,
      card_message_id: messageId
    });
  }

  return {
    ok: true,
    status: "sent",
    dry_run: false,
    cli_run_id: result.id,
    card_message_id: messageId,
    recipient,
    chat_id: chatId,
    identity,
    error: null
  };
}
