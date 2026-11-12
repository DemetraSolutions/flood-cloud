import { formatDate } from '../../../core/i18n/format';
import { I18nService } from '../../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../../core/i18n/language';

/** Rules of a numeric text field. */
export interface NumberRule {
  readonly min: number;
  readonly max?: number;
  readonly integer?: boolean;
  /** Whether the field may be left empty. */
  readonly optional?: boolean;
}

/** Issue of a numeric text field, or `undefined` when it is valid (same names as the backend). */
export function numberIssue(
  text: string,
  rule: NumberRule,
): 'required' | 'type' | 'minimum' | 'maximum' | undefined {
  const value = text.trim();
  if (value === '') {
    return rule.optional ? undefined : 'required';
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (rule.integer === true && !Number.isInteger(number))) {
    return 'type';
  }
  if (number < rule.min) {
    return 'minimum';
  }
  return rule.max !== undefined && number > rule.max ? 'maximum' : undefined;
}

/** The number in a text field, `null` when it is empty. */
export function numberOrNull(text: string): number | null {
  return text.trim() === '' ? null : Number(text);
}

/** Text of a number for a text field (`''` for `null`). */
export function numberText(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Trimmed text, or `null` when blank. */
export function textOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Value of a `datetime-local` input (`YYYY-MM-DDTHH:mm`, in the time zone of the browser) for a
 * stored ISO 8601 date; `''` for `null` or for a text that is not a date.
 */
export function toLocalInput(iso: string | null): string {
  const date = iso === null ? new Date(Number.NaN) : new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Shape of a `datetime-local` value: date, hours and minutes, optional seconds and milliseconds. */
const LOCAL_INPUT = /^\d{4,}-\d{2}-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?$/;

/**
 * ISO 8601 date (UTC) for the value of a `datetime-local` input read in the time zone of the
 * browser; `null` for an empty or invalid value. Only the exact input format is read, and a day
 * that does not exist (31 April) is refused rather than moved to the next month, as `Date` would.
 */
export function fromLocalInput(text: string): string | null {
  const match = LOCAL_INPUT.exec(text.trim());
  if (match === null) {
    return null;
  }
  const date = new Date(text.trim());
  // An invalid month gives no date; a day past the end of the month would move to the next one.
  return Number.isNaN(date.getTime()) || Number(match[1]) !== date.getDate()
    ? null
    : date.toISOString();
}

/**
 * Validation issue of a date field: `incorrect` for a text that is filled but is not a date (it
 * would otherwise be sent as "no date"), `undefined` for an empty field or a valid date.
 */
export function dateIssue(text: string): 'incorrect' | undefined {
  return text.trim() !== '' && fromLocalInput(text) === null ? 'incorrect' : undefined;
}

/** Whether two dates of the form fields (local input values) are in the wrong order. */
export function datesReversed(from: string, to: string): boolean {
  const start = fromLocalInput(from);
  const end = fromLocalInput(to);
  return start !== null && end !== null && end < start;
}

/**
 * Text of the "stores" column of an element: every store, or how many, and "read only" when the
 * user may not change it.
 */
export function placesCell(
  i18n: I18nService,
  placeIds: readonly string[],
  readOnly: boolean,
): string {
  const text =
    placeIds.length === 0
      ? i18n.t('CATALOG.ALL_PLACES')
      : i18n.t('CATALOG.PLACES_COUNT', { count: placeIds.length });
  return readOnly ? `${text} · ${i18n.t('CATALOG.READ_ONLY')}` : text;
}

/** A stored date as "date, time" in the language of the user; a text that is not a date is shown as it is. */
export function dateTimeText(i18n: I18nService, value: string): string {
  return Number.isNaN(new Date(value).getTime())
    ? value
    : formatDate(value, i18n.language() ?? DEFAULT_LANGUAGE, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

/** Validity of an element as "from … to …" ("always" when it has no limit). */
export function validityText(i18n: I18nService, from: string | null, to: string | null): string {
  if (from === null && to === null) {
    return i18n.t('CATALOG.ALWAYS');
  }
  return i18n.t('CATALOG.VALIDITY', {
    from: from === null ? '…' : dateTimeText(i18n, from),
    to: to === null ? '…' : dateTimeText(i18n, to),
  });
}

/** Whether two lists hold the same ids in the same order. */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
