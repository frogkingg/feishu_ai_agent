const CHINA_OFFSET = "+08:00";

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  const date = new Date(iso);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString().replace(".000Z", "Z");
}

export function chineseWeekdayToDate(baseIso: string | null, weekdayText: string): string | null {
  if (!baseIso) {
    return null;
  }

  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) {
    return null;
  }

  const weekdayMap: Record<string, number> = {
    周日: 0,
    周一: 1,
    周二: 2,
    周三: 3,
    周四: 4,
    周五: 5,
    周六: 6
  };
  const target = weekdayMap[weekdayText];
  if (target === undefined) {
    return null;
  }

  const current = base.getDay();
  let days = target - current;
  if (days <= 0) {
    days += 7;
  }

  const next = new Date(base);
  next.setDate(base.getDate() + days);
  return `${next.toISOString().slice(0, 10)}T00:00:00${CHINA_OFFSET}`;
}

export function withChinaTime(dateIsoDay: string, hour: number, minute = 0): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${dateIsoDay.slice(0, 10)}T${hh}:${mm}:00${CHINA_OFFSET}`;
}
