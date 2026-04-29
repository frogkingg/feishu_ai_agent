import { z } from "zod";

const CalendarIntentWords = ["会议", "访谈", "评审", "同步", "沟通"];
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const CalendarEventDraftSchema = z
  .object({
    title: z.string().trim().min(1, "title cannot be empty"),
    start_time: IsoDateTimeSchema.nullable(),
    end_time: IsoDateTimeSchema.nullable(),
    duration_minutes: z.number().int().positive().nullable(),
    participants: z.array(z.string()),
    agenda: z.string().nullable(),
    location: z.string().nullable(),
    evidence: z.string().trim().min(1, "evidence cannot be empty"),
    confidence: z.number().min(0).max(1),
    missing_fields: z.array(z.string())
  })
  .superRefine((draft, ctx) => {
    const haystack = [draft.title, draft.agenda ?? "", draft.evidence].join(" ");
    const hasCalendarIntent = CalendarIntentWords.some((word) => haystack.includes(word));
    if (!hasCalendarIntent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "calendar draft requires explicit meeting/interview/review/sync/communication intent",
        path: ["title"]
      });
    }

    if (draft.start_time === null && !draft.missing_fields.includes("start_time")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing_fields must include start_time when start_time is null",
        path: ["missing_fields"]
      });
    }
  });

export type CalendarEventDraft = z.infer<typeof CalendarEventDraftSchema>;
