import { AppConfig, loadConfig } from "../config";
import { DryRunConfirmationCard } from "../schemas";
import { ConfirmationRequestRow, Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

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
  runner?: LarkCliRunner;
}

interface FeishuText {
  tag: "plain_text" | "lark_md";
  content: string;
}

type FeishuHeaderTemplate = "blue" | "turquoise" | "green" | "orange" | "red" | "grey";

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
      tag: "input" | "textarea";
      name: string;
      placeholder: FeishuText;
      default_value?: string;
    }
  | {
      tag: "date_picker" | "picker_datetime";
      name: string;
      placeholder: FeishuText;
      initial_date?: string;
      initial_datetime?: string;
    }
  | {
      tag: "select_static";
      name: string;
      placeholder: FeishuText;
      options: Array<{
        text: FeishuText;
        value: string;
      }>;
      initial_option?: string;
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
    template: FeishuHeaderTemplate;
    title: FeishuText;
  };
  elements: FeishuCardElement[];
}

interface CardVisualProfile {
  icon: string;
  typeLabel: string;
  headerTemplate: FeishuHeaderTemplate;
  primaryFieldKeys: string[];
  detailFieldKeys: string[];
}

type CardActionKey = DryRunConfirmationCard["actions"][number]["key"];

function trimToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringifyCardValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item === null ? "未填写" : humanizeDisplayText(String(item))))
      .join(", ");
  }

  return value === null || value === undefined ? "未填写" : humanizeDisplayText(String(value));
}

function displayValue(field: DryRunConfirmationCard["sections"][number]["fields"][number]): string {
  return humanizeDisplayText(field.value_text ?? stringifyCardValue(field.value));
}

function plainText(content: string): FeishuText {
  return {
    tag: "plain_text",
    content
  };
}

function scalarDefaultValue(value: DryRunConfirmationCard["editable_fields"][number]["value"]) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null).join(", ");
  }

  return value === null ? undefined : String(value);
}

function buildEditableElement(
  field: DryRunConfirmationCard["editable_fields"][number]
): FeishuCardElement {
  const placeholder = plainText(field.label);
  const defaultValue = scalarDefaultValue(field.value);

  if (field.input_type === "textarea" || field.input_type === "multi_text") {
    return {
      tag: "input",
      name: field.key,
      placeholder,
      default_value: defaultValue
    };
  }

  if (field.input_type === "date") {
    return {
      tag: "date_picker",
      name: field.key,
      placeholder,
      initial_date: defaultValue
    };
  }

  if (field.input_type === "datetime") {
    return {
      tag: "picker_datetime",
      name: field.key,
      placeholder,
      initial_datetime: defaultValue
    };
  }

  if (field.input_type === "select") {
    const options = (field.options ?? []).map((option) => ({
      text: plainText(option),
      value: option
    }));
    return {
      tag: "select_static",
      name: field.key,
      placeholder,
      options,
      initial_option: defaultValue
    };
  }

  return {
    tag: "input",
    name: field.key,
    placeholder,
    default_value: defaultValue
  };
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

function visualProfile(card: DryRunConfirmationCard): CardVisualProfile {
  if (card.card_type === "action_confirmation") {
    return {
      icon: "📌",
      typeLabel: "待办",
      headerTemplate: "turquoise",
      primaryFieldKeys: ["recommended_owner", "due_date", "priority"],
      detailFieldKeys: ["suggested_reason", "evidence"]
    };
  }

  if (card.card_type === "calendar_confirmation") {
    return {
      icon: "📅",
      typeLabel: "日程",
      headerTemplate: "orange",
      primaryFieldKeys: ["start_time", "duration_minutes", "participants", "location"],
      detailFieldKeys: ["agenda", "evidence"]
    };
  }

  if (
    card.card_type === "create_kb_confirmation" ||
    card.card_type === "append_meeting_confirmation"
  ) {
    return {
      icon: "📚",
      typeLabel: "知识库",
      headerTemplate: "green",
      primaryFieldKeys: ["topic_name", "kb_name", "meeting_reference", "candidate_meetings"],
      detailFieldKeys: [
        "suggested_goal",
        "default_structure",
        "reason",
        "meeting_summary",
        "key_decisions",
        "risks"
      ]
    };
  }

  return {
    icon: "✓",
    typeLabel: "确认",
    headerTemplate: "blue",
    primaryFieldKeys: ["request_type"],
    detailFieldKeys: ["payload"]
  };
}

function headerTemplate(card: DryRunConfirmationCard): FeishuHeaderTemplate {
  if (card.status === "failed") {
    return "red";
  }
  if (["executed", "rejected"].includes(card.status)) {
    return "grey";
  }
  return visualProfile(card).headerTemplate;
}

function allFields(card: DryRunConfirmationCard) {
  return card.sections.flatMap((section) => section.fields);
}

function fieldsByKeys(card: DryRunConfirmationCard, keys: string[]) {
  const fields = allFields(card);
  return keys
    .map((key) => fields.find((field) => field.key === key))
    .filter((field): field is DryRunConfirmationCard["sections"][number]["fields"][number] =>
      Boolean(field)
    );
}

function formatIsoDateTime(value: string): string | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match) {
    return null;
  }

  return `${Number(match[2])}月${Number(match[3])}日 ${match[4]}:${match[5]}`;
}

function humanizeDisplayText(value: string): string {
  return value.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
    (candidate) => formatIsoDateTime(candidate) ?? candidate
  );
}

function compactText(value: string, maxLength = 72): string {
  const singleLine = humanizeDisplayText(value).replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}...` : singleLine;
}

function compactSummary(card: DryRunConfirmationCard): string {
  return compactText(card.summary, 72);
}

function fieldBullet(field: DryRunConfirmationCard["sections"][number]["fields"][number]): string {
  return `- **${field.label}**: ${compactText(displayValue(field))}`;
}

function buildKeyInfoElement(card: DryRunConfirmationCard, profile: CardVisualProfile) {
  const keyFields = fieldsByKeys(card, profile.primaryFieldKeys).slice(0, 4);
  const lines =
    keyFields.length > 0
      ? keyFields.map(fieldBullet)
      : [`- **状态**: ${card.status}`, `- **目标**: ${card.target_id}`];

  return {
    tag: "div" as const,
    text: {
      tag: "lark_md" as const,
      content: [`**${profile.typeLabel}确认**`, ...lines].join("\n")
    }
  };
}

function buildDetailElement(card: DryRunConfirmationCard, profile: CardVisualProfile) {
  const detailFields = fieldsByKeys(card, profile.detailFieldKeys)
    .filter((field) => displayValue(field) !== "无" && displayValue(field) !== "未填写")
    .slice(0, 6);

  const lines =
    detailFields.length > 0
      ? detailFields.map(fieldBullet)
      : card.sections
          .flatMap((section) => section.fields)
          .filter((field) => !profile.primaryFieldKeys.includes(field.key))
          .slice(0, 4)
          .map(fieldBullet);

  return {
    tag: "div" as const,
    text: {
      tag: "lark_md" as const,
      content: [`**详情依据**`, ...lines].join("\n")
    }
  };
}

function editableIntro(card: DryRunConfirmationCard): FeishuCardElement {
  const fieldNames = card.editable_fields
    .filter((field) => field.input_type !== "readonly")
    .map((field) => field.label)
    .slice(0, 5)
    .join("、");

  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**可修改信息**\n${fieldNames || "无可修改字段"}`
    }
  };
}

function preferredActionKeys(card: DryRunConfirmationCard): CardActionKey[] {
  if (card.card_type === "action_confirmation") {
    return card.editable_fields.length > 0
      ? ["confirm_with_edits", "remind_later", "reject"]
      : ["confirm", "remind_later", "reject"];
  }

  if (card.card_type === "calendar_confirmation") {
    return card.editable_fields.length > 0
      ? ["confirm_with_edits", "convert_to_task", "reject"]
      : ["confirm", "convert_to_task", "reject"];
  }

  if (card.card_type === "create_kb_confirmation") {
    return card.editable_fields.length > 0
      ? ["edit_and_create", "append_current_only", "reject"]
      : ["create_kb", "append_current_only", "reject"];
  }

  return ["confirm", "reject"];
}

function visibleActions(card: DryRunConfirmationCard) {
  const actionByKey = new Map(card.actions.map((action) => [action.key, action]));
  return preferredActionKeys(card)
    .map((key) => actionByKey.get(key))
    .filter((action): action is DryRunConfirmationCard["actions"][number] => Boolean(action));
}

function buttonLabel(card: DryRunConfirmationCard, key: string, fallback: string): string {
  if (key === "confirm_with_edits") {
    return card.card_type === "calendar_confirmation" ? "确认日程" : "确认创建";
  }
  if (key === "edit_and_create" || key === "create_kb") {
    return "确认创建";
  }
  if (key === "append_current_only") {
    return "仅归档本次";
  }
  if (key === "convert_to_task") {
    return "转待办";
  }
  return fallback;
}

function headerTitle(card: DryRunConfirmationCard, profile: CardVisualProfile): string {
  return `${profile.icon} ${card.title}`;
}

export function buildFeishuInteractiveCard(card: DryRunConfirmationCard): FeishuInteractiveCard {
  const profile = visualProfile(card);
  const elements: FeishuCardElement[] = [
    {
      tag: "markdown",
      content: `**${profile.icon} ${profile.typeLabel} | ${compactSummary(card)}**`
    },
    {
      tag: "hr"
    },
    buildKeyInfoElement(card, profile),
    buildDetailElement(card, profile),
    {
      tag: "hr"
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "**安全说明**：确认前不会创建/更新飞书内容。"
      }
    }
  ];

  if (card.editable_fields.length > 0) {
    elements.push(
      {
        tag: "hr"
      },
      editableIntro(card),
      ...card.editable_fields
        .filter((field) => field.input_type !== "readonly")
        .map(buildEditableElement)
    );
  }

  const actions = visibleActions(card);
  if (actions.length > 0) {
    elements.push({
      tag: "action",
      actions: actions.map((action) => ({
        tag: "button",
        text: {
          tag: "plain_text",
          content: buttonLabel(card, action.key, action.label)
        },
        type: buttonType(action.style),
        value: {
          confirmation_id: card.request_id,
          action: action.key,
          request_id: card.request_id,
          action_key: action.key,
          endpoint: action.endpoint,
          ...(action.payload_template ?? {}),
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
        content: headerTitle(card, profile)
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
  const cardSendDryRun = config.feishuCardSendDryRun;
  const chatId = trimToNull(input.chatId);
  const recipient = trimToNull(input.recipient ?? input.confirmation?.recipient ?? null);
  const identity = input.identity ?? "bot";
  const destinationArgs = buildDestinationArgs({ chatId, recipient });

  if (destinationArgs === null) {
    return failedResult({
      dryRun: cardSendDryRun,
      recipient,
      chatId,
      identity,
      error: "lark.im.send_card requires recipient or chat_id"
    });
  }

  const cardContent = buildFeishuInteractiveCard(input.card);
  const cardJson = JSON.stringify(cardContent);
  const args = [
    "im",
    "+messages-send",
    ...destinationArgs,
    "--msg-type",
    "interactive",
    "--content",
    cardJson,
    "--as",
    identity,
    "--idempotency-key",
    `meeting-atlas-card-${input.card.request_id}`
  ];

  const result = await runLarkCli(args, {
    repos: input.repos,
    config,
    toolName: "lark.im.send_card",
    dryRun: cardSendDryRun,
    expectJson: true,
    runner: input.runner
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
