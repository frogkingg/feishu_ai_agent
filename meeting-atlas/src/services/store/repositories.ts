import { nowIso } from "../../utils/dates";
import { MeetingAtlasDb } from "./db";

export interface MeetingRow {
  id: string;
  external_meeting_id: string | null;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  organizer: string | null;
  participants_json: string;
  minutes_url: string | null;
  transcript_url: string | null;
  transcript_text: string;
  summary: string | null;
  keywords_json: string;
  matched_kb_id: string | null;
  match_score: number | null;
  archive_status: string;
  action_count: number;
  calendar_count: number;
  created_at: string;
  updated_at: string;
}

export interface ActionItemRow {
  id: string;
  meeting_id: string;
  kb_id: string | null;
  title: string;
  description: string | null;
  owner: string | null;
  collaborators_json: string;
  due_date: string | null;
  priority: "P0" | "P1" | "P2" | null;
  evidence: string;
  confidence: number;
  suggested_reason: string;
  missing_fields_json: string;
  confirmation_status: string;
  feishu_task_guid: string | null;
  task_url: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarDraftRow {
  id: string;
  meeting_id: string;
  kb_id: string | null;
  title: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  participants_json: string;
  agenda: string | null;
  location: string | null;
  evidence: string;
  confidence: number;
  missing_fields_json: string;
  confirmation_status: string;
  calendar_event_id: string | null;
  event_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseRow {
  id: string;
  name: string;
  goal: string | null;
  description: string | null;
  owner: string | null;
  status: string;
  confidence_origin: number;
  wiki_url: string | null;
  homepage_url: string | null;
  related_keywords_json: string;
  created_from_meetings_json: string;
  auto_append_policy: string;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  kb_id: string | null;
  source_type: string;
  title: string;
  source_url: string | null;
  summary: string | null;
  why_related: string | null;
  archive_section: string | null;
  confirmation_status: string;
  permission_status: string;
  added_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConfirmationRequestRow {
  id: string;
  request_type: "action" | "calendar" | "create_kb" | "append_meeting" | "archive_source";
  target_id: string;
  recipient: string | null;
  card_message_id: string | null;
  status: "draft" | "sent" | "edited" | "confirmed" | "rejected" | "executed" | "failed";
  original_payload_json: string;
  edited_payload_json: string | null;
  confirmed_at: string | null;
  executed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeUpdateRow {
  id: string;
  kb_id: string;
  update_type: string;
  summary: string;
  source_ids_json: string;
  before_text: string | null;
  after_text: string | null;
  created_by: "agent" | "user";
  confirmed_by: string | null;
  created_at: string;
}

export interface CliRunRow {
  id: string;
  tool: string;
  args_json: string;
  dry_run: 0 | 1;
  status: "planned" | "success" | "failed";
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  created_at: string;
}

type NewRow<T extends { created_at: string }> = Omit<T, "created_at" | "updated_at"> &
  Partial<Pick<T, Extract<keyof T, "created_at" | "updated_at">>>;

type NewKnowledgeUpdateRow = Omit<KnowledgeUpdateRow, "created_at"> & Partial<Pick<KnowledgeUpdateRow, "created_at">>;
type NewCliRunRow = Omit<CliRunRow, "created_at"> & Partial<Pick<CliRunRow, "created_at">>;

function withTimestamps<T extends { created_at?: string; updated_at?: string }>(row: T): T & { created_at: string; updated_at: string } {
  const now = nowIso();
  return {
    ...row,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now
  };
}

function asRow<T>(value: unknown): T | null {
  return (value as T | undefined) ?? null;
}

function allRows<T>(value: unknown[]): T[] {
  return value as T[];
}

export function createRepositories(db: MeetingAtlasDb) {
  return {
    createMeeting(input: NewRow<MeetingRow>): MeetingRow {
      const row = withTimestamps(input);
      db.prepare(
        `INSERT INTO meetings (
          id, external_meeting_id, title, started_at, ended_at, organizer, participants_json,
          minutes_url, transcript_url, transcript_text, summary, keywords_json, matched_kb_id,
          match_score, archive_status, action_count, calendar_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.external_meeting_id,
        row.title,
        row.started_at,
        row.ended_at,
        row.organizer,
        row.participants_json,
        row.minutes_url,
        row.transcript_url,
        row.transcript_text,
        row.summary,
        row.keywords_json,
        row.matched_kb_id,
        row.match_score,
        row.archive_status,
        row.action_count,
        row.calendar_count,
        row.created_at,
        row.updated_at
      );
      return row;
    },

    getMeeting(id: string): MeetingRow | null {
      return asRow<MeetingRow>(db.prepare("SELECT * FROM meetings WHERE id = ?").get(id));
    },

    listMeetings(): MeetingRow[] {
      return allRows<MeetingRow>(db.prepare("SELECT * FROM meetings ORDER BY created_at ASC").all());
    },

    updateMeetingExtraction(input: {
      id: string;
      summary: string;
      keywords_json: string;
      action_count: number;
      calendar_count: number;
    }): void {
      db.prepare(
        `UPDATE meetings
        SET summary = ?, keywords_json = ?, action_count = ?, calendar_count = ?, updated_at = ?
        WHERE id = ?`
      ).run(input.summary, input.keywords_json, input.action_count, input.calendar_count, nowIso(), input.id);
    },

    updateMeetingTopic(input: {
      id: string;
      matched_kb_id: string | null;
      match_score: number;
      archive_status: string;
    }): void {
      db.prepare(
        `UPDATE meetings
        SET matched_kb_id = ?, match_score = ?, archive_status = ?, updated_at = ?
        WHERE id = ?`
      ).run(input.matched_kb_id, input.match_score, input.archive_status, nowIso(), input.id);
    },

    createActionItem(input: NewRow<ActionItemRow>): ActionItemRow {
      const row = withTimestamps(input);
      db.prepare(
        `INSERT INTO action_items (
          id, meeting_id, kb_id, title, description, owner, collaborators_json, due_date,
          priority, evidence, confidence, suggested_reason, missing_fields_json, confirmation_status,
          feishu_task_guid, task_url, rejection_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.meeting_id,
        row.kb_id,
        row.title,
        row.description,
        row.owner,
        row.collaborators_json,
        row.due_date,
        row.priority,
        row.evidence,
        row.confidence,
        row.suggested_reason,
        row.missing_fields_json,
        row.confirmation_status,
        row.feishu_task_guid,
        row.task_url,
        row.rejection_reason,
        row.created_at,
        row.updated_at
      );
      return row;
    },

    getActionItem(id: string): ActionItemRow | null {
      return asRow<ActionItemRow>(db.prepare("SELECT * FROM action_items WHERE id = ?").get(id));
    },

    updateActionItemAfterCreate(input: {
      id: string;
      confirmation_status: string;
      feishu_task_guid: string | null;
      task_url: string | null;
    }): void {
      db.prepare(
        `UPDATE action_items
        SET confirmation_status = ?, feishu_task_guid = ?, task_url = ?, updated_at = ?
        WHERE id = ?`
      ).run(input.confirmation_status, input.feishu_task_guid, input.task_url, nowIso(), input.id);
    },

    updateActionItemRejection(input: { id: string; rejection_reason: string | null }): void {
      db.prepare(
        `UPDATE action_items
        SET confirmation_status = 'rejected', rejection_reason = ?, updated_at = ?
        WHERE id = ?`
      ).run(input.rejection_reason, nowIso(), input.id);
    },

    listActionItems(): ActionItemRow[] {
      return allRows<ActionItemRow>(db.prepare("SELECT * FROM action_items ORDER BY created_at ASC").all());
    },

    createCalendarDraft(input: NewRow<CalendarDraftRow>): CalendarDraftRow {
      const row = withTimestamps(input);
      db.prepare(
        `INSERT INTO calendar_drafts (
          id, meeting_id, kb_id, title, start_time, end_time, duration_minutes, participants_json,
          agenda, location, evidence, confidence, missing_fields_json, confirmation_status,
          calendar_event_id, event_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.meeting_id,
        row.kb_id,
        row.title,
        row.start_time,
        row.end_time,
        row.duration_minutes,
        row.participants_json,
        row.agenda,
        row.location,
        row.evidence,
        row.confidence,
        row.missing_fields_json,
        row.confirmation_status,
        row.calendar_event_id,
        row.event_url,
        row.created_at,
        row.updated_at
      );
      return row;
    },

    listCalendarDrafts(): CalendarDraftRow[] {
      return allRows<CalendarDraftRow>(db.prepare("SELECT * FROM calendar_drafts ORDER BY created_at ASC").all());
    },

    getCalendarDraft(id: string): CalendarDraftRow | null {
      return asRow<CalendarDraftRow>(db.prepare("SELECT * FROM calendar_drafts WHERE id = ?").get(id));
    },

    updateCalendarDraftAfterCreate(input: {
      id: string;
      confirmation_status: string;
      calendar_event_id: string | null;
      event_url: string | null;
    }): void {
      db.prepare(
        `UPDATE calendar_drafts
        SET confirmation_status = ?, calendar_event_id = ?, event_url = ?, updated_at = ?
        WHERE id = ?`
      ).run(input.confirmation_status, input.calendar_event_id, input.event_url, nowIso(), input.id);
    },

    updateCalendarDraftRejection(id: string): void {
      db.prepare(
        `UPDATE calendar_drafts
        SET confirmation_status = 'rejected', updated_at = ?
        WHERE id = ?`
      ).run(nowIso(), id);
    },

    createKnowledgeBase(input: NewRow<KnowledgeBaseRow>): KnowledgeBaseRow {
      const row = withTimestamps(input);
      db.prepare(
        `INSERT INTO knowledge_bases (
          id, name, goal, description, owner, status, confidence_origin, wiki_url, homepage_url,
          related_keywords_json, created_from_meetings_json, auto_append_policy, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.name,
        row.goal,
        row.description,
        row.owner,
        row.status,
        row.confidence_origin,
        row.wiki_url,
        row.homepage_url,
        row.related_keywords_json,
        row.created_from_meetings_json,
        row.auto_append_policy,
        row.created_at,
        row.updated_at
      );
      return row;
    },

    getKnowledgeBase(id: string): KnowledgeBaseRow | null {
      return asRow<KnowledgeBaseRow>(db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id));
    },

    listKnowledgeBases(): KnowledgeBaseRow[] {
      return allRows<KnowledgeBaseRow>(db.prepare("SELECT * FROM knowledge_bases ORDER BY created_at ASC").all());
    },

    createSource(input: NewRow<SourceRow>): SourceRow {
      const row = withTimestamps(input);
      db.prepare(
        `INSERT INTO sources (
          id, kb_id, source_type, title, source_url, summary, why_related, archive_section,
          confirmation_status, permission_status, added_from, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.kb_id,
        row.source_type,
        row.title,
        row.source_url,
        row.summary,
        row.why_related,
        row.archive_section,
        row.confirmation_status,
        row.permission_status,
        row.added_from,
        row.created_at,
        row.updated_at
      );
      return row;
    },

    createConfirmationRequest(input: NewRow<ConfirmationRequestRow>): ConfirmationRequestRow {
      const row = withTimestamps(input);
      db.prepare(
        `INSERT INTO confirmation_requests (
          id, request_type, target_id, recipient, card_message_id, status, original_payload_json,
          edited_payload_json, confirmed_at, executed_at, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.request_type,
        row.target_id,
        row.recipient,
        row.card_message_id,
        row.status,
        row.original_payload_json,
        row.edited_payload_json,
        row.confirmed_at,
        row.executed_at,
        row.error,
        row.created_at,
        row.updated_at
      );
      return row;
    },

    getConfirmationRequest(id: string): ConfirmationRequestRow | null {
      return asRow<ConfirmationRequestRow>(db.prepare("SELECT * FROM confirmation_requests WHERE id = ?").get(id));
    },

    updateConfirmationRequest(input: {
      id: string;
      status: ConfirmationRequestRow["status"];
      edited_payload_json?: string | null;
      confirmed_at?: string | null;
      executed_at?: string | null;
      error?: string | null;
    }): void {
      db.prepare(
        `UPDATE confirmation_requests
        SET status = ?,
            edited_payload_json = COALESCE(?, edited_payload_json),
            confirmed_at = COALESCE(?, confirmed_at),
            executed_at = COALESCE(?, executed_at),
            error = ?,
            updated_at = ?
        WHERE id = ?`
      ).run(
        input.status,
        input.edited_payload_json ?? null,
        input.confirmed_at ?? null,
        input.executed_at ?? null,
        input.error ?? null,
        nowIso(),
        input.id
      );
    },

    listConfirmationRequests(): ConfirmationRequestRow[] {
      return allRows<ConfirmationRequestRow>(
        db.prepare("SELECT * FROM confirmation_requests ORDER BY created_at ASC").all()
      );
    },

    createKnowledgeUpdate(input: NewKnowledgeUpdateRow): KnowledgeUpdateRow {
      const row = {
        ...input,
        created_at: input.created_at ?? nowIso()
      };
      db.prepare(
        `INSERT INTO knowledge_updates (
          id, kb_id, update_type, summary, source_ids_json, before_text, after_text, created_by, confirmed_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.kb_id,
        row.update_type,
        row.summary,
        row.source_ids_json,
        row.before_text,
        row.after_text,
        row.created_by,
        row.confirmed_by,
        row.created_at
      );
      return row;
    },

    listKnowledgeUpdates(): KnowledgeUpdateRow[] {
      return allRows<KnowledgeUpdateRow>(db.prepare("SELECT * FROM knowledge_updates ORDER BY created_at ASC").all());
    },

    createCliRun(input: NewCliRunRow): CliRunRow {
      const row = {
        ...input,
        created_at: input.created_at ?? nowIso()
      };
      db.prepare(
        `INSERT INTO cli_runs (id, tool, args_json, dry_run, status, stdout, stderr, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.tool,
        row.args_json,
        row.dry_run,
        row.status,
        row.stdout,
        row.stderr,
        row.error,
        row.created_at
      );
      return row;
    },

    listCliRuns(): CliRunRow[] {
      return allRows<CliRunRow>(db.prepare("SELECT * FROM cli_runs ORDER BY created_at ASC").all());
    },

    getStateSummary() {
      return {
        meetings: this.listMeetings(),
        action_items: this.listActionItems(),
        calendar_drafts: this.listCalendarDrafts(),
        knowledge_bases: this.listKnowledgeBases(),
        knowledge_updates: this.listKnowledgeUpdates(),
        confirmation_requests: this.listConfirmationRequests(),
        cli_runs: this.listCliRuns()
      };
    }
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
