const OpenIdPattern = /\bou_[A-Za-z0-9_-]{3,}\b/g;

export type MeetingLinkPreference = "minutes" | "transcript";

export interface MeetingDisplayInput {
  id: string;
  title: string;
  external_meeting_id?: string | null;
  minutes_url?: string | null;
  transcript_url?: string | null;
}

export function isFeishuOpenId(value: string): boolean {
  return /^ou_[A-Za-z0-9_-]{3,}$/.test(value.trim());
}

function openIdTail(openId: string): string {
  const withoutPrefix = openId.trim().replace(/^ou_/, "");
  return (withoutPrefix || openId).slice(-6);
}

export function formatUserForDisplay(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return formatOpenIdsInText(trimmed);
}

export function formatOpenIdsInText(value: string): string {
  return value.replace(OpenIdPattern, (openId) => `@用户(${openIdTail(openId)})`);
}

export function formatUserListForDisplay(values: string[]): string[] {
  return values
    .map((value) => formatUserForDisplay(value))
    .filter((value): value is string => {
      return value !== null;
    });
}

function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function urlFromExternalMeetingId(value: string | null | undefined): string | null {
  const trimmed = trimToNull(value);
  return trimmed !== null && /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function preferredMeetingLink(
  meeting: MeetingDisplayInput,
  preference: MeetingLinkPreference
): { label: string; url: string } | null {
  const minutesUrl = trimToNull(meeting.minutes_url);
  const transcriptUrl = trimToNull(meeting.transcript_url);
  const externalUrl = urlFromExternalMeetingId(meeting.external_meeting_id);
  const candidates =
    preference === "transcript"
      ? [
          transcriptUrl ? { label: "转写记录", url: transcriptUrl } : null,
          minutesUrl ? { label: "会议纪要", url: minutesUrl } : null,
          externalUrl ? { label: "会议链接", url: externalUrl } : null
        ]
      : [
          minutesUrl ? { label: "会议纪要", url: minutesUrl } : null,
          transcriptUrl ? { label: "转写记录", url: transcriptUrl } : null,
          externalUrl ? { label: "会议链接", url: externalUrl } : null
        ];

  return (
    candidates.find((candidate): candidate is { label: string; url: string } => {
      return candidate !== null;
    }) ?? null
  );
}

export function formatMeetingReference(
  meeting: MeetingDisplayInput,
  options: { preferredLink?: MeetingLinkPreference; hideInternalId?: boolean } = {}
): string {
  const link = preferredMeetingLink(meeting, options.preferredLink ?? "minutes");
  if (link !== null) {
    return `${meeting.title}（${link.label}：${link.url}）`;
  }

  if (options.hideInternalId) {
    return meeting.title;
  }

  return `会议 ${meeting.id}：${meeting.title}`;
}

export function linkifyMeetingReference(value: string): string {
  const linkedLabeledUrls = value.replace(
    /(会议纪要|转写记录|会议链接)：(https?:\/\/[^\s）)]+)/g,
    (_match, label: string, url: string) => `[${label}](${url})`
  );

  return linkedLabeledUrls.replace(/(?<!\]\()https?:\/\/[^\s）)]+/g, (url) => `[会议链接](${url})`);
}
