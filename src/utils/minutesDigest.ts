export const DefaultMinutesDigestMaxChars = 7000;
export const DefaultTranscriptSnippetChars = 900;
export const DefaultRawTranscriptCompactThreshold = 12000;

const UrlPattern = /https?:\/\/[^\s"'<>）)]+/g;
const SummaryKeys = ["summary", "summaries", "abstract", "overview"];
const TodoKeys = ["todos", "todo", "tasks", "action_items", "actions"];
const ChapterKeys = ["chapters", "chapter", "outline", "outlines", "sections"];
const KeyPointKeys = ["key_points", "keypoints", "highlights", "highlight", "keywords"];
const TranscriptKeys = ["transcript", "transcript_text", "text", "content"];
const LinkKeys = [
  "minutes_url",
  "minute_url",
  "transcript_url",
  "source_url",
  "url",
  "link",
  "href"
];

export interface MinutesDigestInput {
  title?: string | null;
  externalMeetingId?: string | null;
  minuteToken?: string | null;
  minutesUrl?: string | null;
  transcriptUrl?: string | null;
  sourceLinks?: string[];
  summary?: unknown;
  todos?: unknown;
  chapters?: unknown;
  keyPoints?: unknown;
  transcriptText?: string | null;
  maxChars?: number;
}

export interface MinutesDigestArtifacts {
  title: string | null;
  externalMeetingId: string | null;
  minuteToken: string | null;
  sourceLinks: string[];
  summary: string[];
  todos: string[];
  chapters: string[];
  keyPoints: string[];
  transcriptText: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimToNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactLine(value: string, maxChars = 420): string {
  const normalized = normalizeText(value);
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizeText(value);
    if (normalized.length === 0 || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function recordLine(record: Record<string, unknown>): string | null {
  const fields = [
    trimToNull(record.title),
    trimToNull(record.name),
    trimToNull(record.text),
    trimToNull(record.content),
    trimToNull(record.summary),
    trimToNull(record.description),
    trimToNull(record.task),
    trimToNull(record.owner) ? `owner: ${trimToNull(record.owner)}` : null,
    trimToNull(record.due_time) ?? trimToNull(record.due_date)
  ].filter((value): value is string => value !== null);

  return fields.length > 0 ? fields.join(" | ") : null;
}

function collectStrings(value: unknown, maxItems = 24): string[] {
  const results: string[] = [];

  function visit(current: unknown): void {
    if (results.length >= maxItems) {
      return;
    }

    const stringValue = trimToNull(current);
    if (stringValue !== null) {
      results.push(compactLine(stringValue));
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
        if (results.length >= maxItems) {
          return;
        }
      }
      return;
    }

    const record = asRecord(current);
    if (record === null) {
      return;
    }

    const line = recordLine(record);
    if (line !== null) {
      results.push(compactLine(line));
      return;
    }

    for (const nested of Object.values(record)) {
      visit(nested);
      if (results.length >= maxItems) {
        return;
      }
    }
  }

  visit(value);
  return uniqueStrings(results);
}

function candidateRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  function visit(current: unknown): void {
    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    const record = asRecord(current);
    if (record !== null) {
      records.push(record);
      for (const nested of Object.values(record)) {
        if (Array.isArray(nested)) {
          nested.slice(0, 5).forEach(visit);
        } else if (asRecord(nested) !== null) {
          visit(nested);
        }
      }
      return;
    }

    if (Array.isArray(current)) {
      current.slice(0, 5).forEach(visit);
    }
  }

  visit(value);
  return records;
}

function valuesForKeys(records: Record<string, unknown>[], keys: string[]): unknown[] {
  const values: unknown[] = [];
  for (const record of records) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        values.push(record[key]);
      }
    }
  }
  return values;
}

function collectByKeys(records: Record<string, unknown>[], keys: string[]): string[] {
  return uniqueStrings(valuesForKeys(records, keys).flatMap((value) => collectStrings(value)));
}

function firstStringByKeys(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const value of valuesForKeys(records, keys)) {
    const text = trimToNull(value);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function linksFromUnknown(value: unknown): string[] {
  const directLinks = collectStrings(value)
    .flatMap((line) => line.match(UrlPattern) ?? [])
    .map((url) => url.trim());

  const jsonLinks =
    typeof value === "string"
      ? (value.match(UrlPattern) ?? [])
      : (JSON.stringify(value).match(UrlPattern) ?? []);

  return uniqueStrings([...directLinks, ...jsonLinks]);
}

function collectSourceLinks(records: Record<string, unknown>[], parsed: unknown): string[] {
  return uniqueStrings([
    ...valuesForKeys(records, LinkKeys).flatMap((value) => collectStrings(value)),
    ...linksFromUnknown(parsed)
  ]).filter((value) => value.startsWith("http://") || value.startsWith("https://"));
}

function transcriptSnippets(text: string | null): string[] {
  if (text === null) {
    return [];
  }

  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return [];
  }

  if (normalized.length <= DefaultTranscriptSnippetChars) {
    return [normalized];
  }

  const head = normalized.slice(0, DefaultTranscriptSnippetChars);
  const tailStart = Math.max(
    DefaultTranscriptSnippetChars,
    normalized.length - DefaultTranscriptSnippetChars
  );
  const tail = normalized.slice(tailStart);
  return uniqueStrings([`${head}...`, `...${tail}`]);
}

function appendBullets(lines: string[], label: string, values: string[]): void {
  lines.push(`${label}:`);
  if (values.length === 0) {
    lines.push("- not provided");
    return;
  }

  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function truncateDigest(lines: string[], maxChars: number): string {
  const output: string[] = [];
  let used = 0;

  for (const line of lines) {
    const nextLength = used + line.length + 1;
    if (nextLength > maxChars) {
      const remaining = maxChars - used - 1;
      if (remaining > 24) {
        output.push(`${line.slice(0, remaining - 3)}...`);
      }
      output.push("- digest_truncated: true");
      break;
    }
    output.push(line);
    used = nextLength;
  }

  return output.join("\n").trim();
}

export function buildMinutesDigestTranscriptText(input: MinutesDigestInput): string {
  const maxChars = input.maxChars ?? DefaultMinutesDigestMaxChars;
  const sourceLinks = uniqueStrings([
    ...(input.minutesUrl ? [input.minutesUrl] : []),
    ...(input.transcriptUrl ? [input.transcriptUrl] : []),
    ...(input.sourceLinks ?? [])
  ]);
  const summary = collectStrings(input.summary, 6);
  const todos = collectStrings(input.todos, 12);
  const chapters = collectStrings(input.chapters, 12);
  const keyPoints = collectStrings(input.keyPoints, 12);
  const snippets = transcriptSnippets(input.transcriptText ?? null);
  const lines = [
    "MeetingAtlas minutes digest input",
    `title: ${input.title?.trim() || "unknown"}`,
    `external_meeting_id: ${input.externalMeetingId?.trim() || "unknown"}`,
    `minute_token: ${input.minuteToken?.trim() || "unknown"}`
  ];

  appendBullets(lines, "source_links", sourceLinks);
  appendBullets(lines, "summary", summary);
  appendBullets(lines, "todos", todos);
  appendBullets(lines, "chapters", chapters);
  appendBullets(lines, "key_points", keyPoints);
  appendBullets(lines, "transcript_evidence_snippets", snippets);
  lines.push("full_transcript: omitted_by_design");

  return truncateDigest(lines, maxChars);
}

export function hasStructuredMinutesContent(input: MinutesDigestInput): boolean {
  return (
    collectStrings(input.summary, 1).length > 0 ||
    collectStrings(input.todos, 1).length > 0 ||
    collectStrings(input.chapters, 1).length > 0 ||
    collectStrings(input.keyPoints, 1).length > 0 ||
    (input.sourceLinks ?? []).length > 0 ||
    Boolean(input.minutesUrl) ||
    Boolean(input.transcriptUrl)
  );
}

export function hasMinutesDigestEvidenceContent(input: MinutesDigestInput): boolean {
  return (
    collectStrings(input.summary, 1).length > 0 ||
    collectStrings(input.todos, 1).length > 0 ||
    collectStrings(input.chapters, 1).length > 0 ||
    collectStrings(input.keyPoints, 1).length > 0 ||
    trimToNull(input.transcriptText) !== null
  );
}

export function shouldCompactRawTranscript(transcriptText: string | null | undefined): boolean {
  return (transcriptText?.length ?? 0) > DefaultRawTranscriptCompactThreshold;
}

export function extractMinutesDigestArtifacts(parsed: unknown): MinutesDigestArtifacts {
  const records = candidateRecords(parsed);
  const transcriptText = firstStringByKeys(records, TranscriptKeys);
  const title = firstStringByKeys(records, ["title", "topic", "meeting_title", "name"]);
  const externalMeetingId = firstStringByKeys(records, ["meeting_id", "external_meeting_id"]);
  const minuteToken = firstStringByKeys(records, ["minute_token", "minuteToken"]);

  return {
    title,
    externalMeetingId,
    minuteToken,
    sourceLinks: collectSourceLinks(records, parsed),
    summary: collectByKeys(records, SummaryKeys),
    todos: collectByKeys(records, TodoKeys),
    chapters: collectByKeys(records, ChapterKeys),
    keyPoints: collectByKeys(records, KeyPointKeys),
    transcriptText
  };
}
