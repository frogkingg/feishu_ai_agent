import { z } from "zod";

export const TopicSuggestedActionSchema = z.enum([
  "no_action",
  "observe",
  "ask_append",
  "ask_create"
]);

export const TopicMatchResultSchema = z
  .object({
    current_meeting_id: z.string().min(1),
    matched_kb_id: z.string().nullable(),
    matched_kb_name: z.string().nullable(),
    score: z.number().min(0).max(1),
    match_reasons: z.array(z.string()),
    suggested_action: TopicSuggestedActionSchema,
    candidate_meeting_ids: z.array(z.string().min(1))
  });

export type TopicMatchResult = z.infer<typeof TopicMatchResultSchema>;
