import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

function cleanCalendarMissingFields(draft: {
  end_time: string | null;
  duration_minutes: number | null;
  missing_fields: string[];
}): string[] {
  const filledFields = new Set<string>();
  if (draft.end_time !== null && draft.end_time.trim().length > 0) {
    filledFields.add("end_time");
  }
  if (draft.duration_minutes !== null) {
    filledFields.add("duration_minutes");
    filledFields.add("duration");
  }

  return draft.missing_fields.filter((field) => !filledFields.has(field));
}

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
  .transform((draft) => ({
    ...draft,
    missing_fields: cleanCalendarMissingFields(draft)
  }));

export type CalendarEventDraft = z.infer<typeof CalendarEventDraftSchema>;
