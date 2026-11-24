import { ApiErrorRow } from '../../core/api/api.types';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';

/** What the user is told when an import or a check fails. */
export interface ImportFailure {
  /** The reason, in one sentence. */
  readonly message: string;
  /** The problems of the file (`422` only). */
  readonly rows: readonly ApiErrorRow[];
  /** How many problems the file has, when the server said. */
  readonly errorCount: number | null;
  /** Whether there are problems that are not in `rows`. */
  readonly moreErrors: boolean;
  /** Whether the file was refused for what it contains: the check must be made again with another file. */
  readonly refused: boolean;
}

/** The wait of a `429`, as a sentence. */
function rateLimited(i18n: I18nService, error: ApiError, key: string): string {
  return error.retryAfterSeconds === null
    ? i18n.t(`${key}.RATE_LIMITED`)
    : i18n.t(`${key}.RATE_LIMITED_WAIT`, { seconds: error.retryAfterSeconds });
}

/**
 * The message for a failed download of the model or of the export (the body of the error is a file, so only the status tells): `413` limits of the file, `429` one at a time or too many, `409`, anything else generic.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function downloadFailureMessage(i18n: I18nService, error: unknown): string {
  if (!(error instanceof ApiError)) {
    return i18n.t('CATALOG_XLSX.DOWNLOAD_ERROR.GENERIC');
  }
  switch (error.status) {
    case 413:
      return i18n.t('CATALOG_XLSX.DOWNLOAD_ERROR.TOO_LARGE');
    case 429:
      return rateLimited(i18n, error, 'CATALOG_XLSX.DOWNLOAD_ERROR');
    case 409:
      return i18n.t('CATALOG_XLSX.DOWNLOAD_ERROR.BUSY');
    case 403:
      return i18n.t('CATALOG_XLSX.DOWNLOAD_ERROR.FORBIDDEN');
    default:
      return i18n.t('CATALOG_XLSX.DOWNLOAD_ERROR.GENERIC');
  }
}

/** Dictionary key of the message of a `422` that is about the file as a whole. */
function fileIssueKey(error: ApiError): string {
  const issue = error.details.find((detail) => detail.field === 'file')?.issue;
  switch (issue) {
    case 'incorrect':
      return 'CATALOG_XLSX.IMPORT.ERROR.INCORRECT';
    case 'tooMany':
      return 'CATALOG_XLSX.IMPORT.ERROR.TOO_MANY';
    case 'required':
      return 'CATALOG_XLSX.IMPORT.ERROR.EMPTY';
    default:
      return 'CATALOG_XLSX.IMPORT.ERROR.INVALID';
  }
}

/**
 * Describes a failed check or import: the statuses the route answers have their own text (`413`, `415`, `422` with the problems of the file or about the file as a whole, `409` another import running, `429` with the wait, `503`); anything else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function importFailure(i18n: I18nService, error: unknown): ImportFailure {
  const failure = (message: string, refused = false, source?: ApiError): ImportFailure => ({
    message,
    rows: source?.rows ?? [],
    errorCount: source?.errorCount ?? null,
    moreErrors: source?.moreErrors ?? false,
    refused,
  });
  if (!(error instanceof ApiError)) {
    return failure(failureMessage(i18n, error));
  }
  switch (error.status) {
    case 413:
      return failure(i18n.t('CATALOG_XLSX.IMPORT.ERROR.TOO_LARGE'));
    case 415:
      return failure(i18n.t('CATALOG_XLSX.IMPORT.ERROR.UNSUPPORTED'));
    case 409:
      // The reuse of the key with another file carries a detail on the header; an import already running has none.
      return failure(
        i18n.t(
          error.details.some((detail) => detail.field === 'Idempotency-Key')
            ? 'CATALOG_XLSX.IMPORT.ERROR.KEY_REUSED'
            : 'CATALOG_XLSX.IMPORT.ERROR.BUSY',
        ),
      );
    case 422:
      return error.rows.length > 0
        ? failure(i18n.t('CATALOG_XLSX.IMPORT.ERROR.ROWS'), true, error)
        : failure(i18n.t(fileIssueKey(error)), true);
    case 429:
      return failure(rateLimited(i18n, error, 'CATALOG_XLSX.IMPORT.ERROR'));
    case 503:
      return failure(i18n.t('CATALOG_XLSX.IMPORT.ERROR.UNAVAILABLE'));
    default:
      return failure(failureMessage(i18n, error));
  }
}
