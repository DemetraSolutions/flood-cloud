/**
 * Work shifts of a user (`shiftTime` of the API): types, the model the form edits and the
 * conversions between the two. The backend stays the authority on validity; the form applies the
 * same rules to help (`shiftTimeSchema`).
 */

/** Day keys of the API: `'0'` is Sunday, `'1'` Monday ... `'6'` Saturday. */
export const SHIFT_DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

/** Key of a day of the week. */
export type ShiftDayKey = (typeof SHIFT_DAY_KEYS)[number];

/** Order the interface shows the days in: Monday first, Sunday last. */
export const SHIFT_DAY_ORDER: readonly ShiftDayKey[] = ['1', '2', '3', '4', '5', '6', '0'];

/** Limits of the backend. */
export const MAX_SHIFT_WEEKS = 20;
export const MAX_SHIFT_SLOTS = 10;
export const MAX_SHIFT_SPECIAL_DAYS = 366;

/** A time range of a day, `HH:mm`. */
export interface ShiftSlot {
  start: string;
  end: string;
}

/** A day of a week block. */
export interface ShiftDay {
  active: boolean;
  slots: ShiftSlot[];
}

/** A week block as the form edits it: dates are `YYYY-MM-DD` or `''` for the default block. */
export interface ShiftWeek {
  from: string;
  to: string;
  days: Record<ShiftDayKey, ShiftDay>;
}

/** A special day: it wins over the week blocks. */
export interface SpecialDay {
  date: string;
  dayOff: boolean;
  slots: ShiftSlot[];
}

/** The shifts as the form edits them. */
export interface ShiftTimeModel {
  enabled: boolean;
  weeks: ShiftWeek[];
  specialDays: SpecialDay[];
}

/** A week block as the API returns it (dates in ISO 8601 UTC) or accepts it (`null` = no date). */
export interface ShiftWeekRecord {
  from: string | null;
  to: string | null;
  days: Record<ShiftDayKey, ShiftDay>;
}

/** The shifts as the API returns them. */
export interface ShiftTime {
  enabled: boolean;
  weeks: ShiftWeekRecord[];
  specialDays: SpecialDay[];
}

/** Time of the day as `HH:mm` (24 hours). */
export const SHIFT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Calendar date as `YYYY-MM-DD`. */
export const SHIFT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** An inactive day without time ranges. */
export function emptyDay(): ShiftDay {
  return { active: false, slots: [] };
}

/** A week block with no active day; without dates it is the default block. */
export function emptyWeek(): ShiftWeek {
  return {
    from: '',
    to: '',
    days: Object.fromEntries(SHIFT_DAY_KEYS.map((key) => [key, emptyDay()])) as Record<
      ShiftDayKey,
      ShiftDay
    >,
  };
}

/** No shifts. */
export function emptyShiftTime(): ShiftTimeModel {
  return { enabled: false, weeks: [], specialDays: [] };
}

/** Date part (`YYYY-MM-DD`) of an ISO 8601 instant, or `''`. */
export function dateOf(value: string | null): string {
  return value === null ? '' : value.slice(0, 10);
}

/** Form model of the shifts a user has. */
export function toShiftModel(shift: ShiftTime): ShiftTimeModel {
  return {
    enabled: shift.enabled,
    weeks: shift.weeks.map((week) => ({
      from: dateOf(week.from),
      to: dateOf(week.to),
      days: Object.fromEntries(
        SHIFT_DAY_KEYS.map((key) => [
          key,
          {
            active: week.days[key].active,
            slots: week.days[key].slots.map((slot) => ({ start: slot.start, end: slot.end })),
          },
        ]),
      ) as Record<ShiftDayKey, ShiftDay>,
    })),
    specialDays: shift.specialDays.map((day) => ({
      date: day.date,
      dayOff: day.dayOff,
      slots: day.slots.map((slot) => ({ start: slot.start, end: slot.end })),
    })),
  };
}

/** Request body of a list of week blocks (an empty date becomes `null`). */
export function weeksBody(weeks: readonly ShiftWeek[]): ShiftWeekRecord[] {
  return weeks.map((week) => ({
    from: week.from === '' ? null : week.from,
    to: week.to === '' ? null : week.to,
    days: Object.fromEntries(
      SHIFT_DAY_KEYS.map((key) => [
        key,
        {
          active: week.days[key].active,
          slots: week.days[key].slots.map((slot) => ({ start: slot.start, end: slot.end })),
        },
      ]),
    ) as Record<ShiftDayKey, ShiftDay>,
  }));
}

/** Request body of a list of special days. */
export function specialDaysBody(days: readonly SpecialDay[]): SpecialDay[] {
  return days.map((day) => ({
    date: day.date,
    dayOff: day.dayOff,
    slots: day.slots.map((slot) => ({ start: slot.start, end: slot.end })),
  }));
}

/** Whether two date ranges (`YYYY-MM-DD`, ends included) overlap. */
export function rangesOverlap(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** Whether a week block has both dates. */
export function isDated(week: Pick<ShiftWeek, 'from' | 'to'>): boolean {
  return week.from !== '' && week.to !== '';
}

/** Whether a string is an existing calendar date `YYYY-MM-DD`. */
export function isCalendarDate(value: string): boolean {
  if (!SHIFT_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
