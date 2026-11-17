import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { inUseOf } from './countries.types';

/** What the page tells about a failed write. */
export interface CountryNotice {
  /** `stale`: the version is no longer the current one (offers to reload); `inUse`: refused deletion. */
  readonly kind: 'stale' | 'inUse' | 'error';
  /** Message (already translated). */
  readonly message: string;
}

/**
 * Whether a failure belongs on the fields of the editor: the backend refused the code or the
 * name (`422`, or `409` `taken` on the code).
 */
export function isFieldFailure(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status !== 412 &&
    error.details.some((detail) => detail.field === 'code' || detail.field === 'name')
  );
}

/**
 * The notice of a failed write: a stale version (`412`) offers to reload, a deletion refused
 * because companies or places use the item says how many, anything else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 * @param what What was deleted, when the failure may be a refused deletion.
 */
export function countryNotice(
  i18n: I18nService,
  error: unknown,
  what: 'COUNTRY' | 'AREA',
): CountryNotice {
  if (error instanceof ApiError && error.status === 412) {
    return { kind: 'stale', message: i18n.t('COUNTRIES.STALE') };
  }
  const used = inUseOf(error);
  if (used !== null) {
    const parts: string[] = [];
    const shown = (count: number): string | number => (used.limited ? `${count}+` : count);
    if (used.companies > 0) {
      parts.push(
        i18n.t(used.companies === 1 ? 'COUNTRIES.IN_USE.COMPANY' : 'COUNTRIES.IN_USE.COMPANIES', {
          count: shown(used.companies),
        }),
      );
    }
    if (used.places > 0) {
      parts.push(
        i18n.t(used.places === 1 ? 'COUNTRIES.IN_USE.PLACE' : 'COUNTRIES.IN_USE.PLACES', {
          count: shown(used.places),
        }),
      );
    }
    return {
      kind: 'inUse',
      message: i18n.t(`COUNTRIES.IN_USE.${what}`, { users: parts.join(', ') }),
    };
  }
  return { kind: 'error', message: failureMessage(i18n, error) };
}
