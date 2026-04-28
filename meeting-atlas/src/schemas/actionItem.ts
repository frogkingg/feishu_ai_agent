import { z } from "zod";

export const PrioritySchema = z.enum(["P0", "P1", "P2"]);
export const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date");

export const ActionItemDraftSchema = z.object({
  title: z.string().trim().min(1, "title cannot be empty"),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  collaborators: z.array(z.string()),
  due_date: DateOnlySchema.nullable(),
  priority: PrioritySchema.nullable(),
  evidence: z.string().trim().min(1, "evidence cannot be empty"),
  confidence: z.number().min(0).max(1),
  suggested_reason: z.string().min(1),
  missing_fields: z.array(z.string())
});

export type ActionItemDraft = z.infer<typeof ActionItemDraftSchema>;
