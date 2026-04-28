import { z } from "zod";

export const SourceTypeSchema = z.enum(["doc", "wiki", "im", "mail", "excel", "base", "minutes", "task"]);
export const PermissionStatusSchema = z.enum(["visible", "limited", "denied"]);

export const SourceMentionSchema = z.object({
  type: SourceTypeSchema,
  name_or_keyword: z.string().min(1),
  reason: z.string().min(1)
});

export type SourceMention = z.infer<typeof SourceMentionSchema>;
