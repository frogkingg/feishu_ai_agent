import { AppConfig, loadConfig } from "../config";
import { DryRunConfirmationCard } from "../schemas";
import { ConfirmationRequestRow, Repositories } from "../services/store/repositories";
import { linkifyMeetingReference } from "../utils/display";
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

export interface SyncCardStatusResult {
  ok: boolean;
  method: "update" | "fallback" | "skipped";
  status: "planned" | "updated" | "sent" | "failed" | "skipped";
  dry_run: boolean;
  update_cli_run_id: string | null;
  fallback_cli_run_id: string | null;
  card_message_id: string | null;
  recipient: string | null;
  chat_id: string | null;
  error: string | null;
}

export interface SyncCardStatusInput {
  repos: Repositories;
  config?: AppConfig;
  confirmation: ConfirmationRequestRow;
  card: DryRunConfirmationCard;
  updateToken?: string | null;
  messageId?: string | null;
  chatId?: string | null;
  recipient?: string | null;
  identity?: LarkImIdentity;
  runner?: LarkCliRunner;
}

interface FeishuText {
  tag: "plain_text" | "lark_md";
  content: string;
}

type FeishuHeaderTemplate = "blue" | "turquoise" | "green" | "orange" | "red" | "grey";

type FeishuButton = {
  tag: "button";
  name: string;
  text: FeishuText;
  type: "primary" | "danger" | "default";
  value?: Record<string, unknown>;
  behaviors?: Array<{
    type: "callback";
    value: Record<string, unknown>;
  }>;
};

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
      tag: "select_person";
      name: string;
      placeholder: FeishuText;
      value?: string;
    }
  | {
      tag: "action";
      actions: FeishuButton[];
    };

interface FeishuInteractiveCard {
  config: {
    wide_screen_mode: boolean;
    update_multi: boolean;
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
type CardRenderMode = "real" | "dry_run";

interface BuildFeishuInteractiveCardOptions {
  mode?: CardRenderMode;
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

  if (field.input_type === "person") {
    return {
      tag: "select_person",
      name: field.key,
      placeholder,
      value: defaultValue
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
      detailFieldKeys: ["meeting_reference", "suggested_reason", "evidence"]
    };
  }

  if (card.card_type === "calendar_confirmation") {
    return {
      icon: "📅",
      typeLabel: "日程",
      headerTemplate: "orange",
      primaryFieldKeys: ["start_time", "duration_minutes", "participants", "location"],
      detailFieldKeys: ["meeting_reference", "agenda", "evidence"]
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
        "curation_guidance",
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
  if (card.status === "executed") {
    return "green";
  }
  if (card.status === "rejected") {
    return "grey";
  }
  if (card.status === "confirmed") {
    return "blue";
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
  const singleLine = linkifyMeetingReference(humanizeDisplayText(value))
    .replace(/\s+/g, " ")
    .trim();
  if (/\]\(https?:\/\//i.test(singleLine)) {
    return singleLine;
  }

  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}...` : singleLine;
}

function compactSummary(card: DryRunConfirmationCard): string {
  return compactText(card.summary, 72);
}

function fieldBullet(field: DryRunConfirmationCard["sections"][number]["fields"][number]): string {
  return `- **${field.label}**: ${compactText(displayValue(field))}`;
}

function hasMissingValue(field: DryRunConfirmationCard["editable_fields"][number]): boolean {
  const value = field.value;
  if (value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => item === null || String(item).trim() === "");
  }
  return false;
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

function statusIcon(status: DryRunConfirmationCard["status"]): string {
  if (status === "confirmed") {
    return "⏳";
  }
  if (status === "executed") {
    return "✅";
  }
  if (status === "rejected") {
    return "🚫";
  }
  if (status === "failed") {
    return "⚠️";
  }
  return "ℹ️";
}

function buildStatusElement(card: DryRunConfirmationCard): FeishuCardElement | null {
  if (!card.status_text) {
    return null;
  }

  const lines = [`${statusIcon(card.status)} **${card.status_text}**`];
  if (card.status === "failed" && card.error_summary) {
    lines.push(`错误摘要：${compactText(card.error_summary, 120)}`);
  }

  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content: [`**处理状态**`, ...lines].join("\n")
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
      content: `**需补充**\n${fieldNames || "无可补充字段"}`
    }
  };
}

function requiredEditableKeys(card: DryRunConfirmationCard): string[] {
  if (card.card_type === "action_confirmation") {
    return ["owner", "due_date", "priority"];
  }

  if (card.card_type === "calendar_confirmation") {
    return ["start_time"];
  }

  if (card.card_type === "create_kb_confirmation") {
    return ["topic_name"];
  }

  return [];
}

function requiredEditableFields(card: DryRunConfirmationCard) {
  if (card.card_type === "action_confirmation" && hasMissingEditableField(card, "owner")) {
    return [];
  }

  const requiredKeys = new Set(requiredEditableKeys(card));
  return card.editable_fields
    .filter((field) => requiredKeys.has(field.key))
    .filter(hasMissingValue)
    .slice(0, 3);
}

function hasMissingEditableField(card: DryRunConfirmationCard, key: string): boolean {
  const field = card.editable_fields.find((item) => item.key === key);
  return field === undefined ? false : hasMissingValue(field);
}

function preferredActionKeys(card: DryRunConfirmationCard): CardActionKey[] {
  const hasRequiredEdits = requiredEditableFields(card).length > 0;

  if (card.card_type === "action_confirmation") {
    if (hasMissingEditableField(card, "owner")) {
      return ["confirm", "remind_later", "reject"];
    }

    return hasRequiredEdits
      ? ["confirm_with_edits", "remind_later", "reject"]
      : ["confirm", "remind_later", "reject"];
  }

  if (card.card_type === "calendar_confirmation") {
    return hasRequiredEdits
      ? ["confirm_with_edits", "convert_to_task", "reject"]
      : ["confirm", "convert_to_task", "reject"];
  }

  if (card.card_type === "create_kb_confirmation") {
    return hasRequiredEdits
      ? ["edit_and_create", "append_current_only", "reject"]
      : ["create_kb", "append_current_only", "reject"];
  }

  return ["confirm", "reject"];
}

function visibleActions(card: DryRunConfirmationCard) {
  if (["confirmed", "executed", "rejected", "failed"].includes(card.status)) {
    return [];
  }

  const actionByKey = new Map(card.actions.map((action) => [action.key, action]));
  return preferredActionKeys(card)
    .map((key) => actionByKey.get(key))
    .filter((action): action is DryRunConfirmationCard["actions"][number] => Boolean(action));
}

function isEditableRenderStatus(status: DryRunConfirmationCard["status"]): boolean {
  return status === "draft" || status === "sent" || status === "edited";
}

function buttonLabel(
  card: DryRunConfirmationCard,
  key: string,
  fallback: string,
  mode: CardRenderMode
): string {
  const prefix = mode === "dry_run" ? "预览" : "";
  const retryPrefix = card.status === "failed" ? "重试" : "";

  if (key === "confirm_with_edits") {
    if (card.card_type === "action_confirmation") {
      return `${prefix}${retryPrefix}补全后添加待办`;
    }
    if (card.card_type === "calendar_confirmation") {
      return `${prefix}${retryPrefix}补全后添加日程`;
    }
    if (card.card_type === "append_meeting_confirmation") {
      return `${prefix}${retryPrefix}补全后追加到知识库`;
    }
    return `${prefix}${retryPrefix}补全后确认`;
  }

  if (key === "complete_owner") {
    return `${prefix}${retryPrefix}添加到我的待办`;
  }

  if (key === "confirm") {
    if (card.card_type === "action_confirmation") {
      if (hasMissingEditableField(card, "owner")) {
        return `${prefix}${retryPrefix}添加到我的待办`;
      }
      return `${prefix}${retryPrefix}添加待办`;
    }
    if (card.card_type === "calendar_confirmation") {
      return `${prefix}${retryPrefix}添加日程`;
    }
    if (card.card_type === "append_meeting_confirmation") {
      return `${prefix}${retryPrefix}追加到知识库`;
    }
    return `${prefix}${retryPrefix}确认`;
  }
  if (key === "edit_and_create" || key === "create_kb") {
    return `${prefix}${retryPrefix}创建知识库`;
  }
  if (key === "append_current_only") {
    return "仅归档本次";
  }
  if (key === "convert_to_task") {
    return "转待办";
  }
  if (key === "remind_later") {
    return "稍后处理";
  }
  if (key === "reject" || key === "not_mine") {
    return card.card_type === "create_kb_confirmation" ? "不创建" : "不添加";
  }
  return fallback;
}

function buttonValue(
  card: DryRunConfirmationCard,
  action: DryRunConfirmationCard["actions"][number]
) {
  return {
    confirmation_id: card.request_id,
    action: action.key,
    request_id: card.request_id,
    action_key: action.key,
    ...(action.payload_template ?? {})
  };
}

function headerTitle(card: DryRunConfirmationCard, profile: CardVisualProfile): string {
  return `${profile.icon} ${card.title}`;
}

export function buildFeishuInteractiveCard(
  card: DryRunConfirmationCard,
  options: BuildFeishuInteractiveCardOptions = {}
): FeishuInteractiveCard {
  const mode = options.mode ?? "real";
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
    buildDetailElement(card, profile)
  ];

  const statusElement = buildStatusElement(card);
  if (statusElement !== null) {
    elements.push(
      {
        tag: "hr"
      },
      statusElement
    );
  }

  const editableFields = isEditableRenderStatus(card.status) ? requiredEditableFields(card) : [];
  if (editableFields.length > 0) {
    elements.push(
      {
        tag: "hr"
      },
      editableIntro({ ...card, editable_fields: editableFields }),
      ...editableFields.filter((field) => field.input_type !== "readonly").map(buildEditableElement)
    );
  }

  const actions = visibleActions(card);
  if (actions.length > 0) {
    elements.push({
      tag: "action",
      actions: actions.map((action) => {
        const value = buttonValue(card, action);
        return {
          tag: "button",
          name: action.key,
          text: {
            tag: "plain_text",
            content: buttonLabel(card, action.key, action.label, mode)
          },
          type: buttonType(action.style),
          value,
          behaviors: [
            {
              type: "callback",
              value
            }
          ]
        };
      })
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
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

function buildStatusFallbackCard(card: DryRunConfirmationCard): FeishuInteractiveCard {
  return buildFeishuInteractiveCard({
    ...card,
    editable_fields: [],
    actions: []
  });
}

function syncSkipped(input: {
  dryRun: boolean;
  messageId: string | null;
  recipient: string | null;
  chatId: string | null;
  error: string;
}): SyncCardStatusResult {
  return {
    ok: false,
    method: "skipped",
    status: "skipped",
    dry_run: input.dryRun,
    update_cli_run_id: null,
    fallback_cli_run_id: null,
    card_message_id: input.messageId,
    recipient: input.recipient,
    chat_id: input.chatId,
    error: input.error
  };
}

async function sendStatusFallbackCard(input: {
  repos: Repositories;
  config: AppConfig;
  card: DryRunConfirmationCard;
  recipient: string | null;
  chatId: string | null;
  identity: LarkImIdentity;
  runner?: LarkCliRunner;
}): Promise<SyncCardStatusResult> {
  const destinationArgs = buildDestinationArgs({
    chatId: input.chatId,
    recipient: input.recipient
  });
  if (destinationArgs === null) {
    return syncSkipped({
      dryRun: input.config.feishuCardSendDryRun,
      messageId: null,
      recipient: input.recipient,
      chatId: input.chatId,
      error: "card status fallback requires recipient or chat_id"
    });
  }

  const result = await runLarkCli(
    [
      "im",
      "+messages-send",
      ...destinationArgs,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(buildStatusFallbackCard(input.card)),
      "--as",
      input.identity,
      "--idempotency-key",
      `meeting-atlas-card-status-${input.card.request_id}-${input.card.status}`
    ],
    {
      repos: input.repos,
      config: input.config,
      toolName: "lark.im.send_card_status_fallback",
      dryRun: input.config.feishuCardSendDryRun,
      expectJson: true,
      runner: input.runner
    }
  );

  if (result.dryRun || result.status === "planned") {
    return {
      ok: true,
      method: "fallback",
      status: "planned",
      dry_run: true,
      update_cli_run_id: null,
      fallback_cli_run_id: result.id,
      card_message_id: null,
      recipient: input.recipient,
      chat_id: input.chatId,
      error: null
    };
  }

  if (result.status === "success") {
    return {
      ok: true,
      method: "fallback",
      status: "sent",
      dry_run: false,
      update_cli_run_id: null,
      fallback_cli_run_id: result.id,
      card_message_id: messageIdFromParsed(result.parsed),
      recipient: input.recipient,
      chat_id: input.chatId,
      error: null
    };
  }

  return {
    ok: false,
    method: "fallback",
    status: "failed",
    dry_run: false,
    update_cli_run_id: null,
    fallback_cli_run_id: result.id,
    card_message_id: null,
    recipient: input.recipient,
    chat_id: input.chatId,
    error: `lark.im.send_card_status_fallback failed: ${result.error ?? "unknown error"}`
  };
}

export async function syncConfirmationCardStatus(
  input: SyncCardStatusInput
): Promise<SyncCardStatusResult> {
  const config = input.config ?? loadConfig();
  const identity = input.identity ?? "bot";
  const updateToken = trimToNull(input.updateToken);
  const messageId = trimToNull(input.messageId ?? input.confirmation.card_message_id);
  const chatId = trimToNull(input.chatId);
  const recipient = trimToNull(input.recipient ?? input.confirmation.recipient);
  const cardContent = buildFeishuInteractiveCard(input.card);
  const cardJson = JSON.stringify(cardContent);

  if (updateToken !== null) {
    const result = await runLarkCli(
      [
        "api",
        "POST",
        "/open-apis/interactive/v1/card/update",
        "--data",
        JSON.stringify({
          token: updateToken,
          card: cardContent
        }),
        "--as",
        identity
      ],
      {
        repos: input.repos,
        config,
        toolName: "lark.im.update_card",
        dryRun: config.feishuCardSendDryRun,
        expectJson: true,
        runner: input.runner
      }
    );

    if (result.dryRun || result.status === "planned") {
      return {
        ok: true,
        method: "update",
        status: "planned",
        dry_run: true,
        update_cli_run_id: result.id,
        fallback_cli_run_id: null,
        card_message_id: messageId,
        recipient,
        chat_id: chatId,
        error: null
      };
    }

    if (result.status === "success") {
      return {
        ok: true,
        method: "update",
        status: "updated",
        dry_run: false,
        update_cli_run_id: result.id,
        fallback_cli_run_id: null,
        card_message_id: messageId,
        recipient,
        chat_id: chatId,
        error: null
      };
    }
  }

  if (messageId !== null) {
    const result = await runLarkCli(
      [
        "api",
        "PATCH",
        `/open-apis/im/v1/messages/${messageId}`,
        "--data",
        JSON.stringify({ content: cardJson }),
        "--as",
        identity
      ],
      {
        repos: input.repos,
        config,
        toolName: "lark.im.update_card",
        dryRun: config.feishuCardSendDryRun,
        expectJson: true,
        runner: input.runner
      }
    );

    if (result.dryRun || result.status === "planned") {
      return {
        ok: true,
        method: "update",
        status: "planned",
        dry_run: true,
        update_cli_run_id: result.id,
        fallback_cli_run_id: null,
        card_message_id: messageId,
        recipient,
        chat_id: chatId,
        error: null
      };
    }

    if (result.status === "success") {
      return {
        ok: true,
        method: "update",
        status: "updated",
        dry_run: false,
        update_cli_run_id: result.id,
        fallback_cli_run_id: null,
        card_message_id: messageId,
        recipient,
        chat_id: chatId,
        error: null
      };
    }
  }

  return sendStatusFallbackCard({
    repos: input.repos,
    config,
    card: input.card,
    recipient,
    chatId,
    identity,
    runner: input.runner
  });
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

  const cardContent = buildFeishuInteractiveCard(input.card, {
    mode: cardSendDryRun ? "dry_run" : "real"
  });
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
