import { z } from "zod";
import { IsoDateTimeSchema } from "./calendarDraft";

export const ManualMeetingInputSchema = z.object({
  external_meeting_id: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1),
  participants: z.array(z.string()),
  organizer: z.string().nullable(),
  started_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
  minutes_url: z.string().trim().min(1).nullable().optional(),
  transcript_url: z.string().trim().min(1).nullable().optional(),
  send_to_chat_id: z.string().trim().min(1).optional(),
  transcript_text: z.string().trim().min(1)
});

export type ManualMeetingInput = z.infer<typeof ManualMeetingInputSchema>;
