import { z } from "zod";
import { ConfirmationStatusSchema } from "./confirmation";

export const ConfirmationCardTypeSchema = z.enum([
  "action_confirmation",
  "calendar_confirmation",
  "create_kb_confirmation",
  "generic_confirmation"
]);

export const CardScalarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const CardValueSchema = z.union([CardScalarValueSchema, z.array(CardScalarValueSchema)]);

export const CardFieldInputTypeSchema = z.enum([
  "text",
  "textarea",
  "date",
  "datetime",
  "number",
  "select",
  "multi_text",
  "readonly"
]);

export const CardDisplayFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: CardValueSchema,
  value_text: z.string().min(1).optional()
});

export const CardSectionSchema = z.object({
  title: z.string().min(1),
  fields: z.array(CardDisplayFieldSchema),
  help_text: z.string().min(1).optional()
});

export const CardEditableFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  input_type: CardFieldInputTypeSchema,
  value: CardValueSchema,
  required: z.boolean(),
  options: z.array(z.string()).optional()
});

export const CardActionSchema = z.object({
  key: z.enum([
    "confirm",
    "confirm_with_edits",
    "reject",
    "not_mine",
    "convert_to_task",
    "create_kb",
    "edit_and_create",
    "append_current_only",
    "never_remind_topic",
    "remind_later"
  ]),
  label: z.string().min(1),
  style: z.enum(["primary", "danger", "default"]),
  action_type: z.literal("http_post"),
  endpoint: z.string().min(1),
  payload_template: z.record(z.unknown()).optional()
});

export const DryRunConfirmationCardSchema = z.object({
  card_type: ConfirmationCardTypeSchema,
  request_id: z.string().min(1),
  target_id: z.string().min(1),
  recipient: z.string().nullable(),
  status: ConfirmationStatusSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  sections: z.array(CardSectionSchema),
  editable_fields: z.array(CardEditableFieldSchema),
  actions: z.array(CardActionSchema),
  dry_run: z.literal(true),
  version: z.literal("dry_run_v1")
});

export const CardConfirmationInputSchema = z.object({
  id: z.string().min(1),
  request_type: z.string().min(1).optional(),
  target_id: z.string().min(1),
  recipient: z.string().nullable().default(null),
  status: ConfirmationStatusSchema.default("sent"),
  original_payload: z.unknown(),
  edited_payload: z.unknown().nullable().optional(),
  created_at: z.string().min(1).optional()
});

export type ConfirmationCardType = z.infer<typeof ConfirmationCardTypeSchema>;
export type CardValue = z.infer<typeof CardValueSchema>;
export type CardDisplayField = z.infer<typeof CardDisplayFieldSchema>;
export type CardSection = z.infer<typeof CardSectionSchema>;
export type CardEditableField = z.infer<typeof CardEditableFieldSchema>;
export type CardAction = z.infer<typeof CardActionSchema>;
export type DryRunConfirmationCard = z.infer<typeof DryRunConfirmationCardSchema>;
export type CardConfirmationInput = z.input<typeof CardConfirmationInputSchema>;
