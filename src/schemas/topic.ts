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
    candidate_meeting_ids: z.array(z.string())
  })
  .superRefine((result, ctx) => {
    const action = result.suggested_action;
    if (result.score < 0.6 && action !== "no_action") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "score < 0.60 requires no_action",
        path: ["suggested_action"]
      });
    }
    if (result.score >= 0.6 && result.score < 0.78 && action !== "observe") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "0.60 <= score < 0.78 requires observe",
        path: ["suggested_action"]
      });
    }
    if (
      result.score >= 0.78 &&
      result.score < 0.9 &&
      action !== "ask_append" &&
      action !== "ask_create"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "0.78 <= score < 0.90 requires ask_append or ask_create",
        path: ["suggested_action"]
      });
    }
    if (result.score >= 0.9 && action !== "ask_append" && action !== "ask_create") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "score >= 0.90 requires ask_append or ask_create",
        path: ["suggested_action"]
      });
    }
    if (action === "ask_create" && result.candidate_meeting_ids.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ask_create requires at least one candidate meeting",
        path: ["candidate_meeting_ids"]
      });
    }
  });

export type TopicMatchResult = z.infer<typeof TopicMatchResultSchema>;
