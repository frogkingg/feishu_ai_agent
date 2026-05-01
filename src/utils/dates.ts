const CHINA_OFFSET = "+08:00";
const MsPerDay = 24 * 60 * 60 * 1000;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface TimeParts {
  hour: number;
  minute: number;
}

export interface RelativeDateTimeResolution {
  date: string | null;
  start_time: string | null;
  has_explicit_hour: boolean;
}

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

function parseBaseDate(baseIso: string | null): DateParts | null {
  if (baseIso === null) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(baseIso);
  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function datePartsToEpochDay(parts: DateParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MsPerDay);
}

function epochDayToDateParts(epochDay: number): DateParts {
  const date = new Date(epochDay * MsPerDay);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function formatDateParts(parts: DateParts): string {
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToParts(parts: DateParts, days: number): DateParts {
  return epochDayToDateParts(datePartsToEpochDay(parts) + days);
}

function weekdayOfParts(parts: DateParts): number {
  return new Date(datePartsToEpochDay(parts) * MsPerDay).getUTCDay();
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeMonthDay(input: { base: DateParts; month: number; day: number }): DateParts {
  let year = input.base.year;
  const candidate = {
    year,
    month: input.month,
    day: input.day
  };
  if (datePartsToEpochDay(candidate) < datePartsToEpochDay(input.base)) {
    year += 1;
  }

  return {
    year,
    month: input.month,
    day: input.day
  };
}

function chineseNumber(value: string): number | null {
  const normalized = value.trim().replace(/两/g, "二");
  if (/^\d{1,2}$/.test(normalized)) {
    return Number(normalized);
  }

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if (Object.prototype.hasOwnProperty.call(digits, normalized)) {
    return digits[normalized];
  }

  if (normalized === "十") {
    return 10;
  }

  const teen = /^十([一二三四五六七八九])$/.exec(normalized);
  if (teen) {
    return 10 + digits[teen[1]];
  }

  const tens = /^([一二三])十([一二三四五六七八九])?$/.exec(normalized);
  if (tens) {
    return digits[tens[1]] * 10 + (tens[2] ? digits[tens[2]] : 0);
  }

  return null;
}

function parseNumericOrChinese(value: string): number | null {
  return chineseNumber(value);
}

function resolveWeekday(input: { base: DateParts; prefix: string | undefined; weekday: string }) {
  const weekdayMap: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 0,
    天: 0
  };
  const target = weekdayMap[input.weekday];
  if (target === undefined) {
    return null;
  }

  const baseWeekday = weekdayOfParts(input.base);
  const mondayOffset = baseWeekday === 0 ? -6 : 1 - baseWeekday;
  const currentMonday = addDaysToParts(input.base, mondayOffset);
  const targetOffset = target === 0 ? 6 : target - 1;
  const prefix = input.prefix?.trim();

  if (prefix === "下" || prefix === "下个") {
    return addDaysToParts(currentMonday, 7 + targetOffset);
  }

  const thisWeekTarget = addDaysToParts(currentMonday, targetOffset);
  if (prefix === "本" || prefix === "这") {
    return thisWeekTarget;
  }

  return datePartsToEpochDay(thisWeekTarget) < datePartsToEpochDay(input.base)
    ? addDaysToParts(thisWeekTarget, 7)
    : thisWeekTarget;
}

function resolveRelativeDateParts(base: DateParts, text: string): DateParts | null {
  const fullDate = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})(?:日|号)?/.exec(text);
  if (fullDate) {
    return {
      year: Number(fullDate[1]),
      month: Number(fullDate[2]),
      day: Number(fullDate[3])
    };
  }

  const isoDate = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (isoDate) {
    return {
      year: Number(isoDate[1]),
      month: Number(isoDate[2]),
      day: Number(isoDate[3])
    };
  }

  if (/(后天)/.test(text)) {
    return addDaysToParts(base, 2);
  }

  if (/(明天|明日|明早|明晚)/.test(text)) {
    return addDaysToParts(base, 1);
  }

  if (/(今天|今日|今晚|当天)/.test(text)) {
    return base;
  }

  const week = /(?:(本|这|下|下个)\s*)?(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (week) {
    return resolveWeekday({
      base,
      prefix: week[1],
      weekday: week[2]
    });
  }

  const nextWeek = /下(?:个)?(?:周|星期|礼拜)(?!\s*[一二三四五六日天])/.exec(text);
  if (nextWeek) {
    const baseWeekday = weekdayOfParts(base);
    const mondayOffset = baseWeekday === 0 ? -6 : 1 - baseWeekday;
    return addDaysToParts(base, mondayOffset + 7);
  }

  const monthEnd = /(下)?(?:个)?月底/.exec(text);
  if (monthEnd) {
    const nextMonth = monthEnd[1] ? base.month + 1 : base.month;
    const year = base.year + Math.floor((nextMonth - 1) / 12);
    const month = ((nextMonth - 1) % 12) + 1;
    return {
      year,
      month,
      day: lastDayOfMonth(year, month)
    };
  }

  const monthDay =
    /([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*月\s*([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:日|号)?/.exec(
      text
    );
  if (monthDay) {
    const month = parseNumericOrChinese(monthDay[1]);
    const day = parseNumericOrChinese(monthDay[2]);
    if (month !== null && day !== null) {
      return normalizeMonthDay({ base, month, day });
    }
  }

  const slashMonthDay = /(?:^|[^\d])(\d{1,2})[/-](\d{1,2})(?:[^\d]|$)/.exec(text);
  if (slashMonthDay) {
    return normalizeMonthDay({
      base,
      month: Number(slashMonthDay[1]),
      day: Number(slashMonthDay[2])
    });
  }

  return null;
}

function parseMinute(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return 0;
  }
  if (value === "半") {
    return 30;
  }
  if (value === "一刻") {
    return 15;
  }
  if (value === "三刻") {
    return 45;
  }
  return Number(value);
}

function adjustHourByPeriod(hour: number, period: string | undefined): number {
  if (!period) {
    return hour;
  }
  if (/(下午|晚上|傍晚|今晚|明晚)/.test(period) && hour < 12) {
    return hour + 12;
  }
  if (/中午/.test(period) && hour < 11) {
    return hour + 12;
  }
  if (/凌晨/.test(period) && hour === 12) {
    return 0;
  }
  return hour;
}

function parseTimeExpression(text: string): TimeParts | null {
  const colon =
    /(凌晨|早上|上午|中午|下午|晚上|傍晚|今晚|明早|明晚)?\s*([01]?\d|2[0-3])[:：]([0-5]\d)(?:[^\d]|$)/.exec(
      text
    );
  if (colon) {
    return {
      hour: adjustHourByPeriod(Number(colon[2]), colon[1]),
      minute: Number(colon[3])
    };
  }

  const point =
    /(凌晨|早上|上午|中午|下午|晚上|傍晚|今晚|明早|明晚)?\s*([0-2]?\d|[一二两三四五六七八九十]{1,3})\s*点\s*([0-5]?\d|半|一刻|三刻)?/.exec(
      text
    );
  if (!point) {
    return null;
  }

  const parsedHour = parseNumericOrChinese(point[2]);
  if (parsedHour === null || parsedHour > 23) {
    return null;
  }

  return {
    hour: adjustHourByPeriod(parsedHour, point[1]),
    minute: parseMinute(point[3])
  };
}

export function resolveDateExpression(input: {
  baseIso: string | null;
  text: string;
}): string | null {
  const base = parseBaseDate(input.baseIso);
  if (base === null) {
    return null;
  }

  const resolved = resolveRelativeDateParts(base, input.text);
  return resolved === null ? null : formatDateParts(resolved);
}

export function resolveDateTimeExpression(input: {
  baseIso: string | null;
  text: string;
}): RelativeDateTimeResolution {
  const date = resolveDateExpression(input);
  const time = parseTimeExpression(input.text);

  return {
    date,
    start_time: date !== null && time !== null ? withChinaTime(date, time.hour, time.minute) : null,
    has_explicit_hour: time !== null
  };
}

export function isIsoDateOnly(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export function isIsoDateTimeWithHour(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim()) && toIsoDate(value) !== null;
}

export function addMinutesWithChinaOffset(iso: string, minutes: number): string | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      iso
    );
  if (!match) {
    return null;
  }

  const utcMs =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0)
    ) -
    8 * 60 * 60 * 1000 +
    minutes * 60 * 1000;
  const china = new Date(utcMs + 8 * 60 * 60 * 1000);
  const day = formatDateParts({
    year: china.getUTCFullYear(),
    month: china.getUTCMonth() + 1,
    day: china.getUTCDate()
  });
  return withChinaTime(day, china.getUTCHours(), china.getUTCMinutes());
}
