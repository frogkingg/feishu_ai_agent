import { CalendarEventDraft, CalendarEventDraftSchema } from "../schemas";
import { CalendarDraftRow, MeetingRow, Repositories } from "../services/store/repositories";
import { createId } from "../utils/id";

export interface CalendarDraftRecord {
  row: CalendarDraftRow;
  draft: CalendarEventDraft;
  recipient: string | null;
}

export async function runCalendarAgent(input: {
  repos: Repositories;
  meeting: MeetingRow;
  calendarDrafts: CalendarEventDraft[];
}): Promise<CalendarDraftRecord[]> {
  const records: CalendarDraftRecord[] = [];

  for (const item of input.calendarDrafts) {
    const draft = CalendarEventDraftSchema.parse(item);
    const hasTimeOrFillableFields = draft.start_time !== null || draft.missing_fields.length > 0;
    if (draft.confidence < 0.75 || !hasTimeOrFillableFields) {
      continue;
    }

    const row = input.repos.createCalendarDraft({
      id: createId("cal"),
      meeting_id: input.meeting.id,
      kb_id: null,
      title: draft.title,
      start_time: draft.start_time,
      end_time: draft.end_time,
      duration_minutes: draft.duration_minutes,
      participants_json: JSON.stringify(draft.participants),
      agenda: draft.agenda,
      location: draft.location,
      evidence: draft.evidence,
      confidence: draft.confidence,
      missing_fields_json: JSON.stringify(draft.missing_fields),
      confirmation_status: "sent",
      calendar_event_id: null,
      event_url: null
    });

    records.push({
      row,
      draft,
      recipient: input.meeting.organizer
    });
  }

  return records;
}
