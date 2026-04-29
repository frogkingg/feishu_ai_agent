import { z } from "zod";

export const ConfirmationRequestTypeSchema = z.enum([
  "action",
  "calendar",
  "create_kb",
  "append_meeting",
  "archive_source"
]);
export const ConfirmationStatusSchema = z.enum([
  "draft",
  "sent",
  "edited",
  "confirmed",
  "rejected",
  "executed",
  "failed"
]);

export const ConfirmationRequestSchema = z.object({
  id: z.string().min(1),
  request_type: ConfirmationRequestTypeSchema,
  target_id: z.string().min(1),
  recipient: z.string().nullable(),
  status: ConfirmationStatusSchema,
  original_payload: z.unknown(),
  edited_payload: z.unknown().nullable(),
  created_at: z.string().min(1)
});

export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;
export type ConfirmationRequestType = z.infer<typeof ConfirmationRequestTypeSchema>;
