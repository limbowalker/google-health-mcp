/** Civil (wall-clock) date and time helpers. Dates are "YYYY-MM-DD" strings in the user's timezone. */

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function wallClock(timeZone: string, at: Date) {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** UTC offset of `timeZone` at instant `at`, in seconds (e.g. 7200 for CEST). */
export function offsetSeconds(timeZone: string, at: Date): number {
  const w = wallClock(timeZone, at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 1000);
}

/** Protobuf JSON duration, as used for UTC offsets and durations by the API. */
export function durationString(seconds: number): string {
  return `${Math.round(seconds)}s`;
}

export function parseDuration(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Number(m[1]) : undefined;
}

function zonedToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const first = offsetSeconds(timeZone, new Date(guess));
  let result = guess - first * 1000;
  const second = offsetSeconds(timeZone, new Date(result));
  if (second !== first) result = guess - second * 1000;
  return new Date(result);
}

/**
 * Parses a user-supplied time. "YYYY-MM-DDTHH:mm[:ss]" (or a bare date, meaning midnight) is local
 * time in `timeZone`; strings with "Z" or an explicit offset are absolute.
 */
export function parseDateTime(input: string, timeZone: string): Date {
  const s = input.trim();
  if (/T.*([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid timestamp "${input}"`);
    return d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) {
    throw new RangeError(`Invalid date/time "${input}". Use YYYY-MM-DDTHH:mm (local time) or an ISO 8601 timestamp.`);
  }
  return zonedToUtc(
    {
      year: +m[1],
      month: +m[2],
      day: +m[3],
      hour: m[4] ? +m[4] : 0,
      minute: m[5] ? +m[5] : 0,
      second: m[6] ? +m[6] : 0,
    },
    timeZone,
  );
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  return `${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

/** Instant rendered in a fixed UTC offset, e.g. "2026-09-28T07:30:00+02:00". */
export function formatWithOffset(at: Date, offsetSec: number): string {
  const shifted = new Date(Math.floor(at.getTime() / 1000) * 1000 + offsetSec * 1000);
  return shifted.toISOString().slice(0, 19) + formatOffset(offsetSec);
}

export function formatLocal(at: Date, timeZone: string): string {
  return formatWithOffset(at, offsetSeconds(timeZone, at));
}

/** Physical time + API offset string → local ISO timestamp. */
export function localFromPhysical(physical: string | undefined, utcOffset?: string): string | undefined {
  if (!physical) return undefined;
  const at = new Date(physical);
  if (Number.isNaN(at.getTime())) return physical;
  return formatWithOffset(at, parseDuration(utcOffset) ?? 0);
}

export function todayIn(timeZone: string, now = new Date()): string {
  const w = wallClock(timeZone, now);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function assertDate(value: string, name = "date"): string {
  const m = DATE_RE.exec(value);
  if (!m) throw new RangeError(`${name} must be YYYY-MM-DD, got "${value}"`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) throw new RangeError(`${name} is not a real date: "${value}"`);
  return value;
}

export function toCivil(date: string): CivilDate {
  const m = DATE_RE.exec(assertDate(date));
  return { year: +m![1], month: +m![2], day: +m![3] };
}

export function fromCivil(c: { year?: number; month?: number; day?: number } | undefined): string | undefined {
  if (!c?.year) return undefined;
  return `${c.year}-${pad(c.month ?? 1)}-${pad(c.day ?? 1)}`;
}

export function addDays(date: string, days: number): string {
  const c = toCivil(date);
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, endExclusive: string): number {
  const a = toCivil(start);
  const b = toCivil(endExclusive);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function eachDate(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface DateRange {
  start: string;
  /** Inclusive last day. */
  end: string;
  endExclusive: string;
  days: number;
}

/** Resolves optional start/end dates (inclusive) with defaults, enforcing a maximum span. */
export function resolveRange(
  opts: { startDate?: string; endDate?: string },
  timeZone: string,
  defaultDays: number,
  maxDays: number,
): DateRange {
  const end = opts.endDate ? assertDate(opts.endDate, "endDate") : todayIn(timeZone);
  const start = opts.startDate ? assertDate(opts.startDate, "startDate") : addDays(end, -(defaultDays - 1));
  const endExclusive = addDays(end, 1);
  const days = daysBetween(start, endExclusive);
  if (days <= 0) throw new RangeError("startDate must be on or before endDate");
  if (days > maxDays) throw new RangeError(`Date range too long: ${days} days (maximum ${maxDays})`);
  return { start, end, endExclusive, days };
}
