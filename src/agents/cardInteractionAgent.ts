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
  return {
    payload,
    draft: Object.keys(draft).length > 0 ? draft : payload
  };
}

function buildCard(card: DryRunConfirmationCard): DryRunConfirmationCard {
  return DryRunConfirmationCardSchema.parse(sanitizeForCard(card));
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
  const summary = [
    draft.owner ? `负责人：${draft.owner}` : "负责人待补充",
    draft.due_date ? `截止：${draft.due_date}` : "截止时间待补充",
    draft.priority ? `优先级：${draft.priority}` : "优先级待补充"
  ]
    .filter((item): item is string => item !== null)
    .join("；");

  return buildCard({
    card_type: "action_confirmation",
    request_id: parsed.id,
    target_id: parsed.target_id,
    recipient: parsed.recipient,
    status: parsed.status,
    title: `确认待办：${draft.title}`,
    summary: summary || "请确认是否创建该待办。",
    sections: [
      section({
        title: "待办确认",
        fields: [
          displayField("title", "任务标题", draft.title),
          displayField("recommended_owner", "负责人", draft.owner),
          displayField("due_date", "截止时间", draft.due_date),
          displayField("priority", "优先级", draft.priority)
        ]
      }),
      section({
        title: "会议依据",
        fields: [displayField("evidence", "依据", draft.evidence)]
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
      editableField({ key: "owner", label: "负责人", inputType: "text", value: draft.owner }),
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
    ],
    actions: actionConfirmationActions(parsed.id),
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
    card_type: "calendar_confirmation",
    request_id: parsed.id,
    target_id: parsed.target_id,
    recipient: parsed.recipient,
    status: parsed.status,
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
        fields: [displayField("evidence", "依据", draft.evidence)]
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
    actions: calendarConfirmationActions(parsed.id),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildCreateKbConfirmationCard(
  input: CardConfirmationInput
): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const payload = asObject(parsed.original_payload);
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
  const reason = firstString([payload.reason], "检测到相关会议，建议创建主题知识库。");
  const candidateMeetings =
    candidateMeetingRefs.length > 0 ? candidateMeetingRefs : candidateMeetingIds;
  const summary = [
    `主题：${topicName}`,
    `关联会议数：${candidateMeetings.length}`,
    `建议：${reason}`
  ].join("；");

  return buildCard({
    card_type: "create_kb_confirmation",
    request_id: parsed.id,
    target_id: parsed.target_id,
    recipient: parsed.recipient,
    status: parsed.status,
    title: `确认创建知识库：${topicName}`,
    summary,
    sections: [
      section({
        title: "建库建议",
        fields: [
          displayField("topic_name", "主题名称", topicName),
          displayField("meeting_count", "关联会议数", candidateMeetings.length),
          displayField("suggested_goal", "建议目标", suggestedGoal),
          displayField("reason", "为什么建议建", reason)
        ]
      }),
      section({
        title: "关联会议",
        fields: [displayField("candidate_meetings", "会议", candidateMeetings)]
      }),
      section({
        title: "结构预览",
        fields: [displayField("default_structure", "目录", defaultStructure)]
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
        key: "default_structure",
        label: "默认目录",
        inputType: "multi_text",
        value: defaultStructure
      })
    ],
    actions: createKbConfirmationActions(parsed.id),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildAppendMeetingConfirmationCard(
  input: CardConfirmationInput
): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const payload = asObject(parsed.original_payload);
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
    card_type: "append_meeting_confirmation",
    request_id: parsed.id,
    target_id: parsed.target_id,
    recipient: parsed.recipient,
    status: parsed.status,
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
    actions: basicActions(parsed.id, "确认追加"),
    dry_run: true,
    version: "dry_run_v1"
  });
}

export function buildGenericConfirmationCard(input: CardConfirmationInput): DryRunConfirmationCard {
  const parsed = CardConfirmationInputSchema.parse(input);
  const requestType = parsed.request_type ?? "confirmation";
  const payloadPreview = JSON.stringify(withoutCardPreview(parsed.original_payload), null, 2);

  return buildCard({
    card_type: "generic_confirmation",
    request_id: parsed.id,
    target_id: parsed.target_id,
    recipient: parsed.recipient,
    status: parsed.status,
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
    actions: basicActions(parsed.id, "确认执行"),
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
    created_at: request.created_at
  };

  return buildConfirmationCard(input);
}
