import {
  ActionItemDraft,
  ActionItemDraftSchema,
  CalendarEventDraft,
  CalendarEventDraftSchema,
  CardAction,
  CardConfirmationInput,
  CardConfirmationInputSchema,
  CardDisplayField,
  CardEditableField,
  CardSection,
  CardValue,
  DryRunConfirmationCard,
  DryRunConfirmationCardSchema
} from "../schemas";
import { ConfirmationRequestRow } from "../services/store/repositories";
import { formatOpenIdsInText } from "../utils/display";

type CardInput = ReturnType<typeof CardConfirmationInputSchema.parse>;

function sanitizeText(value: string): string {
  const redacted = value
    .replace(/Authorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;\n]+/gi, "[REDACTED]")
    .replace(
      /\b[A-Z0-9_]*(?:API[_\s-]?KEY|APP_SECRET|TOKEN|SECRET)\b\s*[:=]\s*[^\s,;\n]+/gi,
      "[REDACTED]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/API\s*Key/gi, "[REDACTED]")
    .replace(/Authorization/gi, "[REDACTED]")
    .replace(/\.env\b/gi, "[REDACTED]");

  return formatOpenIdsInText(redacted);
}

function sanitizeForCard<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForCard(item)) as T;
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeForCard(item)])
    ) as T;
  }

  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseJsonOrNull(value: string | null): unknown | null {
  return value === null ? null : parseJson(value);
}

function compactStatusText(value: string, maxLength = 140): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}...` : singleLine;
}

function withoutCardPreview(value: unknown): unknown {
  const payload = asObject(value);
  if (Object.keys(payload).length === 0) {
    return value;
  }

  const { card_preview: _cardPreview, ...rest } = payload;
  return rest;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parseStringArray(parsed);
      }
    } catch {
      return [trimmed];
    }

    return [trimmed];
  }

  return [];
}

function parseTextArray(value: unknown, objectKey: string): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }

        return asString(asObject(item)[objectKey]) ?? "";
      })
      .filter(Boolean);
  }

  return parseStringArray(value);
}

function firstString(values: unknown[], fallback: string): string {
  for (const value of values) {
    const text = asString(value);
    if (text !== null) {
      return text;
    }
  }

  return fallback;
}

function nullableString(value: unknown): string | null {
  return asString(value);
}

function priority(value: unknown): ActionItemDraft["priority"] {
  return value === "P0" || value === "P1" || value === "P2" ? value : null;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "无";
}

function meetingReferenceFromPayload(payload: Record<string, unknown>): string | null {
  const meetingReference = firstString(
    [
      payload.meeting_reference,
      payload.minutes_url,
      payload.transcript_url,
      payload.meeting_url,
      payload.external_meeting_id
    ],
    ""
  );

  return meetingReference.length > 0 ? meetingReference : null;
}

function formatNullable(value: string | number | boolean | null): string {
  return value === null ? "未填写" : String(value);
}

function scalarValue(value: unknown): string | number | boolean | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

function cardValue(value: unknown): CardValue {
  if (Array.isArray(value)) {
    return value.map(scalarValue);
  }

  return scalarValue(value);
}

function displayField(key: string, label: string, value: unknown): CardDisplayField {
  const normalized = cardValue(value);
  const valueText = Array.isArray(normalized)
    ? formatList(normalized.map((item) => formatNullable(item === null ? null : String(item))))
    : formatNullable(normalized === null ? null : normalized);

  return {
    key,
    label,
    value: normalized,
    value_text: valueText
  };
}

function publicTargetId(targetId: string): string {
  return targetId.startsWith("mtg_") ? "current_meeting" : targetId;
}

function editableField(input: {
  key: string;
  label: string;
  inputType: CardEditableField["input_type"];
  value: unknown;
  required?: boolean;
  options?: string[];
}): CardEditableField {
  return {
    key: input.key,
    label: input.label,
    input_type: input.inputType,
    value: cardValue(input.value),
    required: input.required ?? false,
    options: input.options
  };
}

function section(input: {
  title: string;
  fields: CardDisplayField[];
  helpText?: string;
}): CardSection {
  return {
    title: input.title,
    fields: input.fields,
    help_text: input.helpText
  };
}

function basicActions(requestId: string, confirmLabel: string): CardAction[] {
  return [
    {
      key: "confirm",
      label: confirmLabel,
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {
        edited_payload: "$editable_fields"
      }
    },
    {
      key: "reject",
      label: "拒绝",
      style: "danger",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "$reason"
      }
    }
  ];
}

function actionConfirmationActions(requestId: string): CardAction[] {
  return [
    {
      key: "confirm",
      label: "添加待办",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {}
    },
    {
      key: "confirm_with_edits",
      label: "确认修改后创建",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {
        edited_payload: "$editable_fields"
      }
    },
    {
      key: "reject",
      label: "不添加",
      style: "danger",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "$reason"
      }
    },
    {
      key: "not_mine",
      label: "不是我的",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "not_mine"
      }
    },
    {
      key: "remind_later",
      label: "稍后处理",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/remind-later`,
      payload_template: {
        reminder: "$remind_later"
      }
    }
  ];
}

function personalTodoFallbackActions(requestId: string): CardAction[] {
  return [
    {
      key: "confirm",
      label: "添加到我的待办",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {}
    },
    {
      key: "remind_later",
      label: "稍后处理",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/remind-later`,
      payload_template: {
        reminder: "$remind_later"
      }
    },
    {
      key: "reject",
      label: "不添加",
      style: "danger",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "$reason"
      }
    }
  ];
}

function calendarConfirmationActions(requestId: string): CardAction[] {
  return [
    {
      key: "confirm",
      label: "确认",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {}
    },
    {
      key: "confirm_with_edits",
      label: "确认修改后创建",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {
        edited_payload: "$editable_fields"
      }
    },
    {
      key: "reject",
      label: "拒绝",
      style: "danger",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "$reason"
      }
    },
    {
      key: "convert_to_task",
      label: "转成待办",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/convert-to-task`,
      payload_template: {
        draft: "$editable_fields"
      }
    },
    {
      key: "remind_later",
      label: "稍后提醒",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/remind-later`,
      payload_template: {
        reminder: "$remind_later"
      }
    }
  ];
}

function createKbConfirmationActions(requestId: string): CardAction[] {
  return [
    {
      key: "create_kb",
      label: "创建知识库",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {}
    },
    {
      key: "edit_and_create",
      label: "修改后创建",
      style: "primary",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/confirm`,
      payload_template: {
        edited_payload: "$editable_fields"
      }
    },
    {
      key: "append_current_only",
      label: "仅归档当前会议",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/append-current-only`,
      payload_template: {
        mode: "append_current_only"
      }
    },
    {
      key: "reject",
      label: "拒绝",
      style: "danger",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "$reason"
      }
    },
    {
      key: "never_remind_topic",
      label: "不再提醒此主题",
      style: "default",
      action_type: "http_post",
      endpoint: `/dev/confirmations/${requestId}/reject`,
      payload_template: {
        reason: "never_remind_topic"
      }
    }
  ];
}

function payloadAndDraft(input: CardInput): {
  payload: Record<string, unknown>;
  draft: Record<string, unknown>;
} {
  const payload = asObject(input.original_payload);
  const draft = asObject(payload.draft);
  const editedPayload = asObject(input.edited_payload);
  const editedDraft = asObject(editedPayload.draft);
  const edited =
    Object.keys(editedDraft).length > 0
      ? {
          ...editedPayload,
          ...editedDraft
        }
      : editedPayload;
  const baseDraft = Object.keys(draft).length > 0 ? draft : payload;
  return {
    payload,
    draft: {
      ...baseDraft,
      ...edited
    }
  };
}

function buildCard(card: DryRunConfirmationCard): DryRunConfirmationCard {
  return DryRunConfirmationCardSchema.parse(sanitizeForCard(card));
}

function executedStatusText(cardType: DryRunConfirmationCard["card_type"]): string {
  if (cardType === "action_confirmation") {
    return "已添加待办";
  }

  if (cardType === "calendar_confirmation") {
    return "已添加日程";
  }

  if (cardType === "create_kb_confirmation") {
    return "已创建知识库";
  }

  if (cardType === "append_meeting_confirmation") {
    return "已追加到知识库";
  }

  return "已完成";
}

function statusText(input: {
  status: CardInput["status"];
  cardType: DryRunConfirmationCard["card_type"];
}): string | undefined {
  if (input.status === "edited") {
    if (input.cardType === "action_confirmation") {
      return "已更新确认信息，可继续添加待办";
    }
    if (input.cardType === "calendar_confirmation") {
      return "已进入时间补全流程，补全后请再次确认添加日程";
    }
    return "已补全，待再次确认";
  }

  if (input.status === "confirmed") {
    return "正在添加到飞书...";
  }

  if (input.status === "executed") {
    return executedStatusText(input.cardType);
  }

  if (input.status === "rejected") {
    return input.cardType === "create_kb_confirmation" ? "已拒绝" : "已不添加";
  }

  if (input.status === "failed") {
    return "添加失败";
  }

  return undefined;
}

function actionsForStatus(input: {
  status: CardInput["status"];
  actions: CardAction[];
}): CardAction[] {
  if (input.status === "sent" || input.status === "draft" || input.status === "edited") {
    return input.actions;
  }

  return [];
}

function statusFields(input: CardInput): {
  error_summary?: string;
} {
  const error = asString(input.error);
  return {
    error_summary:
      input.status === "failed" && error !== null ? compactStatusText(error) : undefined
  };
}

function normalizeActionDraft(input: CardInput): ActionItemDraft {
  const { draft } = payloadAndDraft(input);
  return ActionItemDraftSchema.parse({
    title: firstString([draft.title], "未命名待办"),
    description: nullableString(draft.description),
    owner: nullableString(draft.owner),
    collaborators: parseStringArray(draft.collaborators ?? draft.collaborators_json),
    due_date: nullableString(draft.due_date),
    priority: priority(draft.priority),
    evidence: firstString([draft.evidence], "无会议证据"),
    confidence: asNumber(draft.confidence) ?? 0,
    suggested_reason: firstString([draft.suggested_reason], "请用户确认后再创建待办。"),
    missing_fields: parseStringArray(draft.missing_fields ?? draft.missing_fields_json)
  });
}

function normalizeCalendarDraft(input: CardInput): CalendarEventDraft {
  const { draft } = payloadAndDraft(input);
  return CalendarEventDraftSchema.parse({
    title: firstString([draft.title], "后续会议"),
    start_time: nullableString(draft.start_time),
    end_time: nullableString(draft.end_time),
    duration_minutes: asNumber(draft.duration_minutes),
    participants: parseStringArray(draft.participants ?? draft.participants_json),
    agenda: nullableString(draft.agenda),
    location: nullableString(draft.location),
    evidence: firstString([draft.evidence], "无会议证据"),
    confidence: asNumber(draft.confidence) ?? 0,
    missing_fields: parseStringArray(draft.missing_fields ?? draft.missing_fields_json)
  });
}

export function buildActionConfirmationCard(input: CardConfirmationInput): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const { payload } = payloadAndDraft(parsed);
  const draft = normalizeActionDraft(parsed);
  const meetingReference = meetingReferenceFromPayload(payload);
  const cardType = "action_confirmation" as const;
  const ownerMissing = draft.owner === null || draft.missing_fields.includes("owner");
  const actions = ownerMissing
    ? personalTodoFallbackActions(parsed.id)
    : actionConfirmationActions(parsed.id);
  const ownerText = ownerMissing ? "我的个人待办" : (draft.owner ?? "待确认");
  const ownerLabel = ownerMissing ? "添加到" : "建议负责人";
  const summary = ownerMissing
    ? [
        "会议未识别明确负责人",
        "点击后会添加到我的个人待办",
        draft.due_date ? `截止：${draft.due_date}` : "截止时间待补充",
        draft.priority ? `优先级：${draft.priority}` : "优先级待补充"
      ].join("；")
    : [
        `建议负责人：${ownerText}`,
        draft.due_date ? `截止：${draft.due_date}` : "截止时间待补充",
        draft.priority ? `优先级：${draft.priority}` : "优先级待补充"
      ]
        .filter((item): item is string => item !== null)
        .join("；");
  const editableFields = [
    editableField({
      key: "title",
      label: "标题",
      inputType: "text",
      value: draft.title,
      required: true
    }),
    editableField({
      key: "owner",
      label: ownerLabel,
      inputType: ownerMissing ? "readonly" : "text",
      value: draft.owner
    }),
    editableField({
      key: "due_date",
      label: "截止日期",
      inputType: "date",
      value: draft.due_date
    }),
    editableField({
      key: "priority",
      label: "优先级",
      inputType: "select",
      value: draft.priority,
      options: ["P0", "P1", "P2"]
    }),
    editableField({
      key: "collaborators",
      label: "协作人",
      inputType: "multi_text",
      value: draft.collaborators
    })
  ];

  return buildCard({
    card_type: cardType,
    request_id: parsed.id,
    target_id: publicTargetId(parsed.target_id),
    recipient: parsed.recipient,
    status: parsed.status,
    status_text:
      ownerMissing && (parsed.status === "sent" || parsed.status === "edited")
        ? "会议未识别明确负责人，可添加到我的个人待办"
        : statusText({ status: parsed.status, cardType }),
    ...statusFields(parsed),
    title: `确认待办：${draft.title}`,
    summary: summary || "请确认是否创建该待办。",
    sections: [
      section({
        title: "待办确认",
        fields: [
          displayField("title", "任务标题", draft.title),
          displayField("recommended_owner", ownerLabel, ownerText),
          displayField("due_date", "截止时间", draft.due_date),
          displayField("priority", "优先级", draft.priority)
        ]
      }),
      section({
        title: "会议依据",
        fields: [
          ...(meetingReference !== null
            ? [displayField("meeting_reference", "会议", meetingReference)]
            : []),
          displayField("evidence", "依据", draft.evidence)
        ]
      }),
      ...(ownerMissing
        ? [
            section({
              title: "个人待办",
              helpText:
                "当前会议未识别明确负责人。点击添加后，会创建到当前卡片接收人或操作用户的个人待办。",
              fields: [displayField("personal_task_fallback", "添加方式", "添加到我的个人待办")]
            })
          ]
        : [])
    ],
    editable_fields: editableFields,
    actions: actionsForStatus({ status: parsed.status, actions }),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildCalendarConfirmationCard(
  input: CardConfirmationInput
): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const { payload } = payloadAndDraft(parsed);
  const draft = normalizeCalendarDraft(parsed);
  const meetingReference = meetingReferenceFromPayload(payload);
  const cardType = "calendar_confirmation" as const;
  const actions = calendarConfirmationActions(parsed.id);
  const summary = [
    draft.start_time ? `开始：${draft.start_time}` : "开始时间待补充",
    draft.end_time ? `结束：${draft.end_time}` : null,
    draft.duration_minutes ? `时长：${draft.duration_minutes} 分钟` : null,
    draft.participants.length > 0 ? `参会人：${formatList(draft.participants)}` : "参会人待补充",
    draft.location ? `地点：${draft.location}` : "地点待补充"
  ]
    .filter((item): item is string => item !== null)
    .join("；");

  return buildCard({
    card_type: cardType,
    request_id: parsed.id,
    target_id: publicTargetId(parsed.target_id),
    recipient: parsed.recipient,
    status: parsed.status,
    status_text: statusText({ status: parsed.status, cardType }),
    ...statusFields(parsed),
    title: `确认日程：${draft.title}`,
    summary: summary || "请确认是否创建该日程。",
    sections: [
      section({
        title: "日程确认",
        fields: [
          displayField("title", "日程标题", draft.title),
          displayField("start_time", "开始时间", draft.start_time),
          displayField("end_time", "结束时间", draft.end_time),
          displayField("duration_minutes", "时长", draft.duration_minutes),
          displayField("participants", "参会人", draft.participants),
          displayField("location", "地点", draft.location),
          displayField("agenda", "议程", draft.agenda)
        ]
      }),
      section({
        title: "会议依据",
        fields: [
          ...(meetingReference !== null
            ? [displayField("meeting_reference", "会议", meetingReference)]
            : []),
          displayField("evidence", "依据", draft.evidence)
        ]
      })
    ],
    editable_fields: [
      editableField({
        key: "title",
        label: "标题",
        inputType: "text",
        value: draft.title,
        required: true
      }),
      editableField({
        key: "start_time",
        label: "开始时间",
        inputType: "datetime",
        value: draft.start_time
      }),
      editableField({
        key: "end_time",
        label: "结束时间",
        inputType: "datetime",
        value: draft.end_time
      }),
      editableField({
        key: "duration_minutes",
        label: "时长分钟",
        inputType: "number",
        value: draft.duration_minutes
      }),
      editableField({
        key: "participants",
        label: "参会人",
        inputType: "multi_text",
        value: draft.participants
      }),
      editableField({ key: "location", label: "地点", inputType: "text", value: draft.location }),
      editableField({ key: "agenda", label: "议程", inputType: "textarea", value: draft.agenda })
    ],
    actions: actionsForStatus({ status: parsed.status, actions }),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildCreateKbConfirmationCard(
  input: CardConfirmationInput
): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const payload = asObject(parsed.original_payload);
  const cardType = "create_kb_confirmation" as const;
  const actions = createKbConfirmationActions(parsed.id);
  const topicName = firstString([payload.topic_name, payload.name], "新主题知识库");
  const suggestedGoal = firstString(
    [payload.suggested_goal, payload.goal],
    "沉淀相关会议结论、行动项、日程与资料来源。"
  );
  const candidateMeetingIds = parseStringArray(
    payload.candidate_meeting_ids ?? payload.meeting_ids
  );
  const candidateMeetingRefs = parseStringArray(payload.candidate_meeting_refs);
  const defaultStructure = parseStringArray(payload.default_structure);
  const curationGuidance = parseStringArray(payload.curation_guidance);
  const structurePreview = curationGuidance.length > 0 ? curationGuidance : defaultStructure;
  const reason = firstString([payload.reason], "检测到相关会议，建议创建主题知识库。");
  const meetingCount =
    candidateMeetingRefs.length > 0 ? candidateMeetingRefs.length : candidateMeetingIds.length;
  const candidateMeetings = candidateMeetingRefs;
  const summary = [`主题：${topicName}`, `关联会议数：${meetingCount}`, `建议：${reason}`].join(
    "；"
  );

  return buildCard({
    card_type: cardType,
    request_id: parsed.id,
    target_id: publicTargetId(parsed.target_id),
    recipient: parsed.recipient,
    status: parsed.status,
    status_text: statusText({ status: parsed.status, cardType }),
    ...statusFields(parsed),
    title: `确认创建知识库：${topicName}`,
    summary,
    sections: [
      section({
        title: "建库建议",
        fields: [
          displayField("topic_name", "主题名称", topicName),
          displayField("meeting_count", "关联会议数", meetingCount),
          displayField("suggested_goal", "建议目标", suggestedGoal),
          displayField("reason", "为什么建议建", reason)
        ]
      }),
      ...(candidateMeetings.length > 0
        ? [
            section({
              title: "关联会议",
              fields: [displayField("candidate_meetings", "会议", candidateMeetings)]
            })
          ]
        : []),
      section({
        title: curationGuidance.length > 0 ? "策展方式" : "结构预览",
        fields: [
          displayField(
            curationGuidance.length > 0 ? "curation_guidance" : "default_structure",
            curationGuidance.length > 0 ? "指南" : "目录",
            structurePreview
          )
        ]
      })
    ],
    editable_fields: [
      editableField({
        key: "topic_name",
        label: "主题名称",
        inputType: "text",
        value: topicName,
        required: true
      }),
      editableField({
        key: "suggested_goal",
        label: "知识库目标",
        inputType: "textarea",
        value: suggestedGoal
      }),
      editableField({
        key: curationGuidance.length > 0 ? "curation_guidance" : "default_structure",
        label: curationGuidance.length > 0 ? "策展指南" : "默认目录",
        inputType: "multi_text",
        value: structurePreview
      })
    ],
    actions: actionsForStatus({ status: parsed.status, actions }),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildAppendMeetingConfirmationCard(
  input: CardConfirmationInput
): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const payload = asObject(parsed.original_payload);
  const cardType = "append_meeting_confirmation" as const;
  const actions = basicActions(parsed.id, "确认追加");
  const kbName = firstString([payload.kb_name], "现有知识库");
  const meetingReference = firstString(
    [
      payload.meeting_reference,
      payload.transcript_url,
      payload.minutes_url,
      payload.meeting_title,
      payload.meeting_id
    ],
    "当前会议"
  );
  const meetingSummary = firstString([payload.meeting_summary], "暂无摘要");
  const keyDecisions = parseTextArray(payload.key_decisions, "decision");
  const risks = parseTextArray(payload.risks, "risk");
  const summary = [`知识库：${kbName}`, `会议：${meetingReference}`].join("；");

  return buildCard({
    card_type: cardType,
    request_id: parsed.id,
    target_id: publicTargetId(parsed.target_id),
    recipient: parsed.recipient,
    status: parsed.status,
    status_text: statusText({ status: parsed.status, cardType }),
    ...statusFields(parsed),
    title: `确认追加会议：${kbName}`,
    summary,
    sections: [
      section({
        title: "追加位置",
        fields: [
          displayField("kb_name", "加入知识库", kbName),
          displayField("meeting_reference", "会议链接", meetingReference)
        ]
      }),
      section({
        title: "会议摘要",
        fields: [
          displayField("meeting_summary", "摘要", meetingSummary),
          displayField("key_decisions", "关键结论", keyDecisions),
          displayField("risks", "风险", risks)
        ]
      })
    ],
    editable_fields: [],
    actions: actionsForStatus({ status: parsed.status, actions }),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildGenericConfirmationCard(input: CardConfirmationInput): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const requestType = parsed.request_type ?? "confirmation";
  const cardType = "generic_confirmation" as const;
  const actions = basicActions(parsed.id, "确认执行");
  const payloadPreview = JSON.stringify(withoutCardPreview(parsed.original_payload), null, 2);

  return buildCard({
    card_type: cardType,
    request_id: parsed.id,
    target_id: publicTargetId(parsed.target_id),
    recipient: parsed.recipient,
    status: parsed.status,
    status_text: statusText({ status: parsed.status, cardType }),
    ...statusFields(parsed),
    title: `确认请求：${requestType}`,
    summary: "请确认是否执行该请求。",
    sections: [
      section({
        title: "请求内容",
        fields: [
          displayField("request_type", "类型", requestType),
          displayField("payload", "原始 payload", payloadPreview)
        ]
      })
    ],
    editable_fields: [],
    actions: actionsForStatus({ status: parsed.status, actions }),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildConfirmationCard(input: CardConfirmationInput): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse({
    ...input,
    original_payload: withoutCardPreview(input.original_payload)
  });

  if (parsed.request_type === "action") {
    return buildActionConfirmationCard(parsed);
  }

  if (parsed.request_type === "calendar") {
    return buildCalendarConfirmationCard(parsed);
  }

  if (parsed.request_type === "create_kb") {
    return buildCreateKbConfirmationCard(parsed);
  }

  if (parsed.request_type === "append_meeting") {
    return buildAppendMeetingConfirmationCard(parsed);
  }

  return buildGenericConfirmationCard(parsed);
}

export function buildConfirmationCardFromRequest(
  request: ConfirmationRequestRow
): DryRunConfirmationCard {
  const input: CardConfirmationInput = {
    id: request.id,
    request_type: request.request_type,
    target_id: request.target_id,
    recipient: request.recipient,
    status: request.status,
    original_payload: withoutCardPreview(parseJson(request.original_payload_json)),
    edited_payload: parseJsonOrNull(request.edited_payload_json),
    error: request.error,
    created_at: request.created_at
  };

  return buildConfirmationCard(input);
}
