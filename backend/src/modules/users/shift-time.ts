import { isDeepStrictEqual } from 'node:util';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { UserAnomaly } from './user.types.ts';

/**
 * The shifts of a user, used by the appointments calendar: the legacy `shiftTime` object (`status`, `weeksGeneric`, `daySpecial`) in a clearer
 * domain shape. A week block with both dates is valid for that range of dates; the one without dates is the default; a special day beats both.
 */

/** Most week blocks of a user. */
export const MAX_SHIFT_WEEKS = 20;
/** Most slots in one day. */
export const MAX_SHIFT_SLOTS = 10;
/** Most special days of a user. */
export const MAX_SHIFT_SPECIAL_DAYS = 366;

/** The days of a week as the legacy keys them: `0` is Sunday, as `Date.getDay()`. */
export const SHIFT_DAYS = Object.freeze(['0', '1', '2', '3', '4', '5', '6'] as const);

/** A day of the week, `'0'` (Sunday) to `'6'`. */
export type ShiftDayKey = (typeof SHIFT_DAYS)[number];

/** A time of the day, `HH:mm` (24 hours). */
export const SHIFT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const SPECIAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A working interval inside a day. */
export interface ShiftSlot {
  readonly start: string;
  readonly end: string;
}

/** One day of a week block. */
export interface ShiftDay {
  /** Whether the user works that day. */
  readonly active: boolean;
  readonly slots: readonly ShiftSlot[];
}

/** A week block: the shifts of the seven days, valid for a range of dates or, with no dates, by default. */
export interface ShiftWeek {
  readonly from: Date | null;
  readonly to: Date | null;
  readonly days: Readonly<Record<ShiftDayKey, ShiftDay>>;
}

/** A special day, which beats the week blocks. */
export interface ShiftSpecialDay {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** The user does not work that day. */
  readonly dayOff: boolean;
  readonly slots: readonly ShiftSlot[];
}

/** The shifts of a user. */
export interface ShiftTime {
  readonly enabled: boolean;
  readonly weeks: readonly ShiftWeek[];
  readonly specialDays: readonly ShiftSpecialDay[];
}

/** The shift part of a creation or a modification; `weeks` and `specialDays`, when present, are the whole list. */
export interface ShiftTimePatch {
  readonly enabled?: boolean;
  readonly weeks?: readonly ShiftWeekInput[];
  readonly specialDays?: readonly ShiftSpecialDay[];
}

/** A week block as a request carries it: the days that are not listed are inactive and empty. */
export interface ShiftWeekInput {
  readonly from?: Date | null;
  readonly to?: Date | null;
  readonly days: Readonly<Partial<Record<ShiftDayKey, ShiftDay>>>;
}

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** A user with no shifts. */
export function emptyShiftTime(): ShiftTime {
  return { enabled: false, weeks: [], specialDays: [] };
}

function readSlots(raw: unknown, field: string, anomalies: UserAnomaly[]): ShiftSlot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const slots: ShiftSlot[] = [];
  for (const item of raw as unknown[]) {
    if (isRecord(item) && typeof item['start'] === 'string' && typeof item['end'] === 'string' && SHIFT_TIME_PATTERN.test(item['start']) && SHIFT_TIME_PATTERN.test(item['end'])) {
      slots.push({ start: item['start'], end: item['end'] });
    } else {
      anomalies.push({ kind: 'invalidType', field });
    }
  }
  if (slots.length > MAX_SHIFT_SLOTS) {
    anomalies.push({ kind: 'invalidType', field });
  }
  return slots.slice(0, MAX_SHIFT_SLOTS);
}

function readDays(raw: unknown, field: string, anomalies: UserAnomaly[]): Record<ShiftDayKey, ShiftDay> {
  const source = isRecord(raw) ? raw : {};
  const days = {} as Record<ShiftDayKey, ShiftDay>;
  for (const key of SHIFT_DAYS) {
    const day = source[key];
    days[key] = isRecord(day) ? { active: day['active'] === true, slots: readSlots(day['values'], `${field}.${key}.values`, anomalies) } : { active: false, slots: [] };
  }
  return days;
}

function readInstant(raw: unknown): Date | null {
  const date = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
  return date !== null && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Reads the stored `shiftTime` tolerantly. The misspelt `ststus` (64 documents in production) counts as `status`; the older `weekGeneric` object (20
 * documents) is read as one week block without dates; a block that is not an object, a slot that is not `HH:mm` and the elements beyond the limits are
 * left out and reported. Nothing is ever thrown.
 *
 * @param raw The stored value (`undefined` for a document without shifts).
 * @param anomalies Receives what is wrong with the stored value.
 * @returns The shifts; a missing or irregular value reads as no shifts.
 */
export function readShiftTime(raw: unknown, anomalies: UserAnomaly[]): ShiftTime {
  if (raw === undefined || raw === null) {
    return emptyShiftTime();
  }
  if (!isRecord(raw)) {
    anomalies.push({ kind: 'invalidType', field: 'shiftTime' });
    return emptyShiftTime();
  }
  const status = typeof raw['status'] === 'boolean' ? raw['status'] : raw['ststus'];
  const weeks: ShiftWeek[] = [];
  const stored = raw['weeksGeneric'];
  if (Array.isArray(stored)) {
    (stored as unknown[]).forEach((item, index) => {
      if (isRecord(item)) {
        weeks.push({ from: readInstant(item['start']), to: readInstant(item['end']), days: readDays(item['days'], `shiftTime.weeksGeneric.${String(index)}.days`, anomalies) });
      } else {
        anomalies.push({ kind: 'invalidType', field: 'shiftTime.weeksGeneric' });
      }
    });
  } else if (isRecord(raw['weekGeneric'])) {
    weeks.push({ from: null, to: null, days: readDays(raw['weekGeneric'], 'shiftTime.weekGeneric', anomalies) });
  }
  const specialDays: ShiftSpecialDay[] = [];
  if (isRecord(raw['daySpecial'])) {
    for (const [date, item] of Object.entries(raw['daySpecial']).sort(([a], [b]) => a.localeCompare(b))) {
      if (SPECIAL_DATE.test(date) && isRecord(item)) {
        specialDays.push({ date, dayOff: item['free'] === true, slots: readSlots(item['values'], `shiftTime.daySpecial.${date}.values`, anomalies) });
      } else {
        anomalies.push({ kind: 'invalidType', field: 'shiftTime.daySpecial' });
      }
    }
  }
  if (weeks.length > MAX_SHIFT_WEEKS || specialDays.length > MAX_SHIFT_SPECIAL_DAYS) {
    anomalies.push({ kind: 'invalidType', field: 'shiftTime' });
  }
  return { enabled: status === true, weeks: weeks.slice(0, MAX_SHIFT_WEEKS), specialDays: specialDays.slice(0, MAX_SHIFT_SPECIAL_DAYS) };
}

/**
 * The week block with every day present, as the domain keeps it.
 *
 * @param input The week as received, possibly with days missing.
 * @returns The week with every day present.
 */
export function completeWeek(input: ShiftWeekInput): ShiftWeek {
  const days = {} as Record<ShiftDayKey, ShiftDay>;
  for (const key of SHIFT_DAYS) {
    days[key] = input.days[key] ?? { active: false, slots: [] };
  }
  return { from: input.from ?? null, to: input.to ?? null, days };
}

/**
 * Applies a shift patch to the current shifts: a field that is present replaces the current one.
 *
 * @param base The shifts before.
 * @param patch The patch, if any.
 */
export function applyShiftTime(base: ShiftTime, patch: ShiftTimePatch | undefined): ShiftTime {
  return {
    enabled: patch?.enabled ?? base.enabled,
    weeks: patch?.weeks === undefined ? base.weeks : patch.weeks.map(completeWeek),
    specialDays: patch?.specialDays === undefined ? base.specialDays : [...patch.specialDays].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const legacySlots = (slots: readonly ShiftSlot[]): Array<{ start: string; end: string }> => slots.map(({ start, end }) => ({ start, end }));

function legacyWeek(week: ShiftWeek): Record<string, unknown> {
  return {
    start: week.from,
    end: week.to,
    days: Object.fromEntries(SHIFT_DAYS.map((key) => [key, { active: week.days[key].active, values: legacySlots(week.days[key].slots) }])),
  };
}

const legacySpecialDays = (days: readonly ShiftSpecialDay[]): Record<string, unknown> =>
  Object.fromEntries(days.map((day) => [day.date, { free: day.dayOff, values: legacySlots(day.slots) }]));

/**
 * The legacy `shiftTime` object of some shifts, as the legacy form writes it.
 *
 * @param shift The shifts.
 */
export function toLegacyShiftTime(shift: ShiftTime): Record<string, unknown> {
  return { status: shift.enabled, weeksGeneric: shift.weeks.map(legacyWeek), daySpecial: legacySpecialDays(shift.specialDays) };
}

/** Stored paths the backend writes for the shifts (the container `shiftTime` is never replaced, so its unknown keys stay). */
export const SHIFT_TIME_OWNED_FIELDS: readonly string[] = Object.freeze(['shiftTime.status', 'shiftTime.weeksGeneric', 'shiftTime.daySpecial']);

/** Stored path of the special days: a map by date, written as a whole. */
export const SHIFT_SPECIAL_PATH = 'shiftTime.daySpecial';

/**
 * The shifts that differ between two states, as a patch.
 *
 * @param before The shifts before the change.
 * @param after The shifts after the change.
 * @returns The differences, or `undefined` when the shifts are the same.
 */
export function diffShiftTime(before: ShiftTime, after: ShiftTime): ShiftTimePatch | undefined {
  const changes: { enabled?: boolean; weeks?: readonly ShiftWeekInput[]; specialDays?: readonly ShiftSpecialDay[] } = {};
  if (before.enabled !== after.enabled) {
    changes.enabled = after.enabled;
  }
  if (!isDeepStrictEqual(before.weeks, after.weeks)) {
    changes.weeks = after.weeks;
  }
  if (!isDeepStrictEqual(before.specialDays, after.specialDays)) {
    changes.specialDays = after.specialDays;
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/**
 * The `$set` paths of a shift patch.
 *
 * @param patch What changes.
 */
export function shiftTimeSetPaths(patch: ShiftTimePatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.enabled !== undefined) {
    set['shiftTime.status'] = patch.enabled;
  }
  if (patch.weeks !== undefined) {
    set['shiftTime.weeksGeneric'] = patch.weeks.map((week) => legacyWeek(completeWeek(week)));
  }
  if (patch.specialDays !== undefined) {
    set[SHIFT_SPECIAL_PATH] = legacySpecialDays(patch.specialDays);
  }
  return set;
}

const overlap = (a: ShiftWeek, b: ShiftWeek): boolean => a.from!.getTime() <= b.to!.getTime() && b.from!.getTime() <= a.to!.getTime();

function slotIssues(slots: readonly ShiftSlot[], field: string): ErrorDetail[] {
  return slots.flatMap((slot, index): ErrorDetail[] => (slot.start >= slot.end ? [{ field: `${field}.${String(index)}.end`, issue: 'incorrect' }] : []));
}

/**
 * Checks the consistency of the shifts a request wants (the shape and the limits of every value were validated by the schema): each slot starts
 * before it ends, at most one week block has no dates (the default one), the dates of a block come in pairs and in order, the date ranges of
 * the blocks do not overlap and a special day appears once.
 *
 * @param shift The shifts as they would be after the request.
 * @param prefix Where they sit in the request (`shiftTime`).
 * @returns One detail per problem, empty when all is fine.
 */
export function shiftTimeIssues(shift: ShiftTime, prefix = 'shiftTime'): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  const dated: Array<{ week: ShiftWeek; index: number }> = [];
  let defaults = 0;
  shift.weeks.forEach((week, index) => {
    const at = `${prefix}.weeks.${String(index)}`;
    if (week.from === null && week.to === null) {
      defaults += 1;
      if (defaults > 1) {
        issues.push({ field: at, issue: 'incorrect' });
      }
    } else if (week.from === null || week.to === null) {
      issues.push({ field: `${at}.${week.from === null ? 'from' : 'to'}`, issue: 'required' });
    } else if (week.from.getTime() > week.to.getTime()) {
      issues.push({ field: `${at}.to`, issue: 'incorrect' });
    } else {
      dated.push({ week, index });
    }
    for (const key of SHIFT_DAYS) {
      issues.push(...slotIssues(week.days[key].slots, `${at}.days.${key}.slots`));
    }
  });
  dated.forEach(({ week, index }, position) => {
    if (dated.slice(0, position).some((other) => overlap(other.week, week))) {
      issues.push({ field: `${prefix}.weeks.${String(index)}`, issue: 'incorrect' });
    }
  });
  const seen = new Set<string>();
  shift.specialDays.forEach((day, index) => {
    const at = `${prefix}.specialDays.${String(index)}`;
    if (seen.has(day.date)) {
      issues.push({ field: `${at}.date`, issue: 'incorrect' });
    }
    seen.add(day.date);
    issues.push(...slotIssues(day.slots, `${at}.slots`));
  });
  return issues;
}
