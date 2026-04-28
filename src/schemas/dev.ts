import { z } from "zod";
import { IsoDateTimeSchema } from "./calendarDraft";

export const ManualMeetingInputSchema = z.object({
  title: z.string().trim().min(1),
  participants: z.array(z.string()),
  organizer: z.string().nullable(),
  started_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
  transcript_text: z.string().trim().min(1)
});

export type ManualMeetingInput = z.infer<typeof ManualMeetingInputSchema>;
