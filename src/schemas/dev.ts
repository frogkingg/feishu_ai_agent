import { z } from "zod";
import { IsoDateTimeSchema } from "./calendarDraft";
import { personalWorkspaceName } from "../utils/personalWorkspace";
import {
  buildMinutesDigestTranscriptText,
  hasMinutesDigestEvidenceContent,
  hasStructuredMinutesContent,
  shouldCompactRawTranscript
} from "../utils/minutesDigest";

const MinutesDigestFieldsSchema = {
  summary: z.unknown().optional(),
  todos: z.unknown().optional(),
  chapters: z.unknown().optional(),
  key_points: z.unknown().optional(),
  keyPoints: z.unknown().optional(),
  source_links: z.array(z.string().trim().min(1)).optional()
};

function digestInputFromPayload(payload: {
  title: string;
  external_meeting_id?: string | null;
  minutes_url?: string | null;
  meeting_url?: string | null;
  transcript_url?: string | null;
  transcript_text?: string;
  summary?: unknown;
  todos?: unknown;
  chapters?: unknown;
  key_points?: unknown;
  keyPoints?: unknown;
  source_links?: string[];
}) {
  return {
    title: payload.title,
    externalMeetingId: payload.external_meeting_id ?? null,
    minutesUrl: payload.minutes_url ?? payload.meeting_url ?? null,
    transcriptUrl: payload.transcript_url ?? null,
    sourceLinks: payload.source_links,
    summary: payload.summary,
    todos: payload.todos,
    chapters: payload.chapters,
    keyPoints: payload.key_points ?? payload.keyPoints,
    transcriptText: payload.transcript_text ?? null
  };
}

function transcriptTextFromPayload(payload: Parameters<typeof digestInputFromPayload>[0]): string {
  const digestInput = digestInputFromPayload(payload);
  if (
    hasStructuredMinutesContent(digestInput) ||
    shouldCompactRawTranscript(payload.transcript_text)
  ) {
    return buildMinutesDigestTranscriptText(digestInput);
  }

  return payload.transcript_text?.trim() ?? buildMinutesDigestTranscriptText(digestInput);
}

export const ManualMeetingInputSchema = z
  .object({
    external_meeting_id: z.string().trim().min(1).nullable().optional(),
    title: z.string().trim().min(1),
    participants: z.array(z.string()),
    organizer: z.string().nullable(),
    started_at: IsoDateTimeSchema.nullable(),
    ended_at: IsoDateTimeSchema.nullable(),
    minutes_url: z.string().trim().min(1).nullable().optional(),
    transcript_url: z.string().trim().min(1).nullable().optional(),
    send_to_chat_id: z.string().trim().min(1).optional(),
    transcript_text: z.string().trim().min(1).optional(),
    ...MinutesDigestFieldsSchema
  })
  .superRefine((payload, context) => {
    const digestInput = digestInputFromPayload(payload);
    if (!hasMinutesDigestEvidenceContent(digestInput)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transcript_text"],
        message: "transcript_text or minutes digest fields are required"
      });
    }
  })
  .transform((payload) => ({
    external_meeting_id: payload.external_meeting_id ?? null,
    title: payload.title,
    participants: payload.participants,
    organizer: payload.organizer,
    started_at: payload.started_at,
    ended_at: payload.ended_at,
    minutes_url: payload.minutes_url ?? null,
    transcript_url: payload.transcript_url ?? null,
    send_to_chat_id: payload.send_to_chat_id,
    transcript_text: transcriptTextFromPayload(payload)
  }));

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
    transcript_text: z.string().trim().min(1).optional(),
    personal_workspace_name: z.string().trim().min(1).default(personalWorkspaceName()),
    ...MinutesDigestFieldsSchema
  })
  .superRefine((payload, context) => {
    const digestInput = digestInputFromPayload(payload);
    if (!hasMinutesDigestEvidenceContent(digestInput)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transcript_text"],
        message: "transcript_text or minutes digest fields are required"
      });
    }
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
      transcript_text: transcriptTextFromPayload(payload)
    },
    personal_workspace_name: payload.personal_workspace_name
  }));

export interface ManualMeetingInput {
  external_meeting_id?: string | null;
  title: string;
  participants: string[];
  organizer: string | null;
  started_at: string | null;
  ended_at: string | null;
  minutes_url?: string | null;
  transcript_url?: string | null;
  send_to_chat_id?: string;
  transcript_text: string;
}

export interface ProcessMeetingTextInput {
  meeting: ManualMeetingInput;
  personal_workspace_name: string;
}
