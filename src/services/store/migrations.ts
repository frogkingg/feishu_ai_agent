export const schemaSql = `
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  external_meeting_id TEXT,
  title TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  organizer TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  minutes_url TEXT,
  transcript_url TEXT,
  transcript_text TEXT NOT NULL,
  summary TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  matched_kb_id TEXT,
  match_score REAL,
  archive_status TEXT NOT NULL DEFAULT 'not_archived',
  action_count INTEGER NOT NULL DEFAULT 0,
  calendar_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  kb_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  collaborators_json TEXT NOT NULL DEFAULT '[]',
  due_date TEXT,
  priority TEXT,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  suggested_reason TEXT NOT NULL,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  confirmation_status TEXT NOT NULL DEFAULT 'draft',
  feishu_task_guid TEXT,
  task_url TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

CREATE TABLE IF NOT EXISTS calendar_drafts (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  kb_id TEXT,
  title TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER,
  participants_json TEXT NOT NULL DEFAULT '[]',
  agenda TEXT,
  location TEXT,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  confirmation_status TEXT NOT NULL DEFAULT 'draft',
  calendar_event_id TEXT,
  event_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT,
  description TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  confidence_origin REAL NOT NULL DEFAULT 0,
  wiki_url TEXT,
  homepage_url TEXT,
  related_keywords_json TEXT NOT NULL DEFAULT '[]',
  created_from_meetings_json TEXT NOT NULL DEFAULT '[]',
  auto_append_policy TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  kb_id TEXT,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  source_url TEXT,
  summary TEXT,
  why_related TEXT,
  archive_section TEXT,
  archive_status TEXT NOT NULL DEFAULT 'candidate',
  confirmation_status TEXT NOT NULL DEFAULT 'candidate',
  permission_status TEXT NOT NULL DEFAULT 'visible',
  added_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id),
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id)
);

CREATE TABLE IF NOT EXISTS confirmation_requests (
  id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  recipient TEXT,
  card_message_id TEXT,
  status TEXT NOT NULL,
  snooze_until TEXT,
  original_payload_json TEXT NOT NULL,
  edited_payload_json TEXT,
  confirmed_at TEXT,
  executed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_updates (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  update_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  before_text TEXT,
  after_text TEXT,
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id)
);

CREATE TABLE IF NOT EXISTS topic_suppressions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_suppressions_user_topic
  ON topic_suppressions(user_id, topic_key);

CREATE TABLE IF NOT EXISTS cli_runs (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  status TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
`;
