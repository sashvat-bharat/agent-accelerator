/**
 * Pure time maths for scheduled actions. Every function takes `now` (or a
 * date) explicitly and uses only the machine's own local clock: no timezone,
 * no DST logic, no `Intl`. `DD:HH:MM` strings are relative (days, hours,
 * minutes) and are resolved to local `YYYY-MM-DDTHH:mm:ss` strings for storage.
 */
import { ValidationError } from "../types/errors.ts";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DDHHMM = /^(\d{2,}):(\d{2}):(\d{2})$/;
const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

/** Parses `DD:HH:MM` (DD >= 2 digits, MM < 60). HH is range-checked by the caller. */
export function parseDDHHMM(value: unknown, field: string, example = "00:07:00"): { dd: number; hh: number; mm: number } {
  const m = typeof value === "string" ? DDHHMM.exec(value) : null;
  if (!m || Number(m[3]) > 59) {
    throw new ValidationError(
      `${field}: expected "DD:HH:MM" (DD days with at least two digits, MM 00-59), e.g. "${example}"; got ${show(value)}.`
    );
  }
  return { dd: Number(m[1]), hh: Number(m[2]), mm: Number(m[3]) };
}

/** Elapsed ms of a `DD:HH:MM` duration (HH 00-23): `startCookingInAdvance`, `repeatEvery`. */
export function durationMs(value: unknown, field: string): number {
  const { dd, hh, mm } = parseDDHHMM(value, field, "00:00:10");
  if (hh > 23) {
    throw new ValidationError(
      `${field}: as a duration HH must be 00-23 (e.g. "00:00:10" = 10 minutes, "01:00:00" = 1 day); got ${show(value)}.`
    );
  }
  return ((dd * 24 + hh) * 60 + mm) * 60_000;
}

/** Local `Monday, 26 October, 03:55:31 PM, 2026` (no timezone name on purpose). */
export function formatDatetime(d: Date): string {
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? "AM" : "PM";
  const month = MONTHS[d.getMonth()]!;
  return (
    `${DAYS[d.getDay()]}, ${d.getDate()} ${month[0]!.toUpperCase()}${month.slice(1)}, ` +
    `${pad2(h12)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ampm}, ${d.getFullYear()}`
  );
}

/**
 * Resolves `timeToDeliver` (`DD` days from today, `HH:MM` on a 12-hour clock)
 * to a local date. Throws when the result is not in the future.
 */
export function resolveDelivery(now: Date, timeToDeliver: unknown, meridiem: unknown): Date {
  // Report a bad time AND a bad meridiem together so one retry can fix both.
  const issues: string[] = [];
  let parts: { dd: number; hh: number; mm: number } | undefined;
  try {
    parts = parseDDHHMM(timeToDeliver, "scheduled_action.timeToDeliver");
    if (parts.hh < 1 || parts.hh > 12) {
      throw new ValidationError(
        `scheduled_action.timeToDeliver: HH is a 12-hour clock hour 01-12 (the AM/PM goes in meridiem), e.g. "00:07:00" + "AM" = today 7:00 AM; got ${show(timeToDeliver)}.`
      );
    }
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }
  if (meridiem !== "AM" && meridiem !== "PM") {
    issues.push(`scheduled_action.meridiem: must be "AM" or "PM"; got ${show(meridiem)}.`);
  }
  if (!parts || issues.length > 0) throw new ValidationError(issues.join(" "));
  const { dd, hh, mm } = parts;
  const d = new Date(now);
  d.setDate(d.getDate() + dd);
  d.setHours((hh % 12) + (meridiem === "PM" ? 12 : 0), mm, 0, 0);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`scheduled_action.timeToDeliver: ${show(timeToDeliver)} is too far in the future.`);
  }
  if (d.getTime() <= now.getTime()) {
    throw new ValidationError(
      `scheduled_action.timeToDeliver: ${show(timeToDeliver)} ${meridiem} resolves to ${formatDatetime(d)}, which is already in the past ` +
        `(now: ${formatDatetime(now)}). Use DD "01" for tomorrow, e.g. "01:${pad2(hh)}:${pad2(mm)}".`
    );
  }
  return d;
}

/** Next delivery after `deliverAt`. Calendar maths (days, then hours/minutes): 7:00 AM stays 7:00 AM. */
export function nextOccurrence(deliverAt: Date, repeatEvery: string): Date {
  const { dd, hh, mm } = parseDDHHMM(repeatEvery, "scheduled_action.repeatEvery", "01:00:00");
  const d = new Date(deliverAt);
  d.setDate(d.getDate() + dd);
  d.setHours(d.getHours() + hh, d.getMinutes() + mm);
  return d;
}

/** First occurrence in the series (starting at `from`) that is strictly after `now`. */
export function nextAfter(from: Date, repeatEvery: string, now: Date): Date {
  let d = from;
  while (d.getTime() <= now.getTime()) {
    const next = nextOccurrence(d, repeatEvery);
    if (next.getTime() <= d.getTime()) {
      throw new ValidationError("scheduled_action.repeatEvery: must be greater than 00:00:00.");
    }
    d = next;
  }
  return d;
}

/** When a run must start so it can deliver at `deliverAt`. */
export function cookTime(deliverAt: Date, cookMs: number): Date {
  return new Date(deliverAt.getTime() - cookMs);
}

/** A run still cooking when the next is due is skipped, so the lead time must be shorter than the gap. */
export function assertCookShorterThanRepeat(cookMs: number, repeatMs: number): void {
  if (cookMs >= repeatMs) {
    throw new ValidationError(
      "scheduled_action.startCookingInAdvance: must be shorter than repeatEvery. A run still cooking when the next one is due is skipped, " +
        "so a lead time as long as the gap loses runs. Shorten startCookingInAdvance, widen repeatEvery, or give the worker a lighter task."
    );
  }
}

/** Local `YYYY-MM-DDTHH:mm:ss`, the storage format (no offset). */
export function toLocalIso(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Inverse of {@link toLocalIso}; read as local time. */
export function parseLocalIso(value: string): Date {
  const m = LOCAL_ISO.exec(value);
  if (!m) throw new ValidationError(`Expected a local time like "2026-10-27T07:00:00"; got ${show(value)}.`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s);
}

/** Run file base name for a delivery date, e.g. `27-october-2026`. */
export function runFileName(deliverAt: Date): string {
  return `${pad2(deliverAt.getDate())}-${MONTHS[deliverAt.getMonth()]}-${deliverAt.getFullYear()}`;
}
