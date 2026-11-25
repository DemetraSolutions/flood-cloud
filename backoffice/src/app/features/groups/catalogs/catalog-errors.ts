import { ApiError, apiErrorMessageKey } from '../../../core/api/api-error';
import { issueMessageKey } from '../../../core/api/field-issues';
import { I18nService } from '../../../core/i18n/i18n.service';
import { failureMessage } from '../../../shared/forms/form-errors';

/** Most cards the server lists in a refusal. */
const MAX_LISTED_CARDS = 20;

/** Kinds of element that can still use a catalog element (the first part of a `referenced` field). */
const REFERENCING = ['cardTypes', 'pointsCollections', 'fidelityCards'] as const;

/**
 * Counts the elements that use the one being deleted, by kind, from the `referenced` details of
 * a `409` (`cardTypes.<id>`, `pointsCollections.<id>`).
 */
export function referencedBy(error: ApiError): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const detail of error.details) {
    if (detail.issue === 'referenced') {
      const kind = detail.field.split('.')[0];
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return counts;
}

function referencedMessage(i18n: I18nService, error: ApiError): string {
  const users = [...referencedBy(error)].map(([kind, count]) =>
    i18n.t(
      (REFERENCING as readonly string[]).includes(kind)
        ? `CATALOG.REFERENCED.${kind.toUpperCase()}`
        : 'CATALOG.REFERENCED.OTHER',
      // The server lists at most 20 cards: 20 means "20 or more".
      { count: kind === 'fidelityCards' && count >= MAX_LISTED_CARDS ? i18n.t('CATALOG.REFERENCED.MANY', { count }) : count },
    ),
  );
  return i18n.t('CATALOG.ERROR.REFERENCED', { users: users.join(', ') });
}

/**
 * User message for a failed write on a catalog. The rejections of the catalogs get a message of
 * their own: element already used (`taken`), standard element (`default`), last element (`last`),
 * element used by others (`referenced`, naming who), limit reached (`tooMany`), field not allowed
 * (`notAllowed`), an element outside the user's perimeter (`403` without details) and a
 * concurrent change (`409` without details). Anything else uses the central mapping.
 */
export function catalogFailureMessage(i18n: I18nService, error: unknown): string {
  if (!(error instanceof ApiError)) {
    return failureMessage(i18n, error);
  }
  const issues = new Set(error.details.map((detail) => detail.issue));
  if (error.code === 'CONFLICT' && error.details.length === 0) {
    return i18n.t('CATALOG.ERROR.CONCURRENT');
  }
  if (error.code === 'FORBIDDEN' && error.details.length === 0) {
    return i18n.t('CATALOG.ERROR.FORBIDDEN');
  }
  if (issues.has('referenced')) {
    return referencedMessage(i18n, error);
  }
  for (const [issue, key] of [
    ['default', 'CATALOG.ERROR.DEFAULT'],
    ['last', 'CATALOG.ERROR.LAST'],
    ['tooMany', 'CATALOG.ERROR.TOO_MANY'],
    ['taken', 'CATALOG.ERROR.TAKEN'],
    ['notAllowed', 'CATALOG.ERROR.NOT_ALLOWED'],
  ] as const) {
    if (issues.has(issue)) {
      return i18n.t(key);
    }
  }
  return error.details.length > 0
    ? i18n.t(issueMessageKey(error.details[0].issue))
    : i18n.t(apiErrorMessageKey(error));
}

/** How a failed save is shown in an editor: per field, plus a message for the form itself. */
export interface EditorErrors {
  /** Message of the first issue of each field of the editor (by form field name). */
  readonly fields: Readonly<Record<string, string>>;
  /** Message for the whole form, `null` when every detail landed on a field (or there is no error). */
  readonly form: string | null;
}

/**
 * Splits the error of a save into what belongs to the fields of an editor and what is left for
 * the form.
 *
 * @param i18n Translation service.
 * @param error The error of the last save, if any.
 * @param known Names of the fields of the editor; an issue on an element of a list
 *   (`placeIds.2`) lands on the field of the list (`placeIds`).
 */
export function editorErrors(
  i18n: I18nService,
  error: ApiError | null,
  known: readonly string[],
): EditorErrors {
  if (error === null) {
    return { fields: {}, form: null };
  }
  const fields: Record<string, string> = {};
  let unmatched = error.details.length === 0;
  for (const { field, issue } of error.details) {
    const name = known.includes(field)
      ? field
      : known.find((candidate) => field.startsWith(`${candidate}.`));
    if (name === undefined) {
      unmatched = true;
    } else if (!Object.hasOwn(fields, name)) {
      fields[name] = i18n.t(issueMessageKey(issue));
    }
  }
  return { fields, form: unmatched ? catalogFailureMessage(i18n, error) : null };
}
