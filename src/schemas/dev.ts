import { z } from "zod";
import { IsoDateTimeSchema } from "./calendarDraft";
import { personalWorkspaceName } from "../utils/personalWorkspace";

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

export const ProcessMeetingTextInputSchema = z
  .object({
    external_meeting_id: z.string().trim().min(1).nullable().optional(),
    title: z.string().trim().min(1),
    participants: z.array(z.string()).default([]),
    organizer: z.string().nullable().default(null),
    started_at: IsoDateTimeSchema.nullable().default(null),
    ended_at: IsoDateTimeSchema.nullable().default(null),
    meeting_url: z.string().trim().min(1).nullable().optional(),
    minutes_url: z.string().trim().min(1).nullable().optional(),
    transcript_url: z.string().trim().min(1).nullable().optional(),
    transcript_text: z.string().trim().min(1),
    personal_workspace_name: z.string().trim().min(1).default(personalWorkspaceName())
  })
  .transform((payload) => ({
    meeting: {
      external_meeting_id: payload.external_meeting_id ?? null,
      title: payload.title,
      participants: payload.participants,
      organizer: payload.organizer,
      started_at: payload.started_at,
      ended_at: payload.ended_at,
      minutes_url: payload.minutes_url ?? payload.meeting_url ?? null,
      transcript_url: payload.transcript_url ?? null,
      transcript_text: payload.transcript_text
    },
    personal_workspace_name: payload.personal_workspace_name
  }));

export type ManualMeetingInput = z.infer<typeof ManualMeetingInputSchema>;
export type ProcessMeetingTextInput = z.infer<typeof ProcessMeetingTextInputSchema>;
