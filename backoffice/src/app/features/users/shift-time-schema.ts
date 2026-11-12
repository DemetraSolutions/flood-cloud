import { applyEach, schema, validate } from '@angular/forms/signals';
import {
  isCalendarDate,
  isDated,
  rangesOverlap,
  SHIFT_TIME_PATTERN,
  ShiftTimeModel,
  ShiftWeek,
} from '../../core/users/shift-time';

/** Validation error of the shifts: the `kind` is an issue name of the backend. */
type Issue = { kind: string } | undefined;

const INCORRECT: Issue = { kind: 'incorrect' };

function timeIssue(value: string): Issue {
  if (value === '') {
    return { kind: 'required' };
  }
  return SHIFT_TIME_PATTERN.test(value) ? undefined : { kind: 'format' };
}

function dateIssue(value: string): Issue {
  if (value === '') {
    return { kind: 'required' };
  }
  return isCalendarDate(value) ? undefined : { kind: 'format' };
}

/** The end of a slot must come after its start (only judged when both are valid times). */
function orderIssue(start: string, end: string): Issue {
  return SHIFT_TIME_PATTERN.test(start) && start >= end ? INCORRECT : undefined;
}

const isDefaultBlock = (week: ShiftWeek): boolean => week.from === '' && week.to === '';

const hasRange = (week: ShiftWeek): boolean =>
  isDated(week) && isCalendarDate(week.from) && isCalendarDate(week.to) && week.from <= week.to;

/**
 * Validation of the shifts, the same rules the backend applies (it stays the authority): times
 * are `HH:mm` and a slot starts before it ends; a dated week block has both dates in order and
 * does not overlap another one; only one block has no dates; a special day appears once.
 */
export const shiftTimeSchema = schema<ShiftTimeModel>((path) => {
  applyEach(path.weeks, (week) => {
    validate(week, ({ valueOf, value, index }) => {
      const before = valueOf(path.weeks).slice(0, index());
      const current = value();
      if (isDefaultBlock(current)) {
        return before.some(isDefaultBlock) ? INCORRECT : undefined;
      }
      return hasRange(current) &&
        before.some((other) => hasRange(other) && rangesOverlap(other, current))
        ? INCORRECT
        : undefined;
    });
    validate(week.from, ({ value, valueOf }) =>
      value() === '' && valueOf(week.to) === '' ? undefined : dateIssue(value()),
    );
    validate(week.to, ({ value, valueOf }) => {
      const from = valueOf(week.from);
      if (value() === '' && from === '') {
        return undefined;
      }
      const issue = dateIssue(value());
      if (issue !== undefined) {
        return issue;
      }
      return isCalendarDate(from) && from > value() ? INCORRECT : undefined;
    });
    applyEach(week.days, (day) => {
      applyEach(day.slots, (slot) => {
        validate(slot.start, ({ value }) => timeIssue(value()));
        validate(
          slot.end,
          ({ value, valueOf }) => timeIssue(value()) ?? orderIssue(valueOf(slot.start), value()),
        );
      });
    });
  });
  applyEach(path.specialDays, (day) => {
    validate(day.date, ({ value, valueOf, pathKeys }) => {
      const issue = dateIssue(value());
      if (issue !== undefined) {
        return issue;
      }
      return valueOf(path.specialDays)
        .slice(0, Number(pathKeys().at(-2)))
        .some((other) => other.date === value())
        ? INCORRECT
        : undefined;
    });
    applyEach(day.slots, (slot) => {
      validate(slot.start, ({ value }) => timeIssue(value()));
      validate(
        slot.end,
        ({ value, valueOf }) => timeIssue(value()) ?? orderIssue(valueOf(slot.start), value()),
      );
    });
  });
});
