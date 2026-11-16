import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { ImportProblem, importProblems, MAX_REPORTED_PROBLEMS } from './tobaccos.types';

/** What the user is told when an import fails. */
export interface ImportFailure {
  /** The reason, in one sentence. */
  readonly message: string;
  /** The cells of the file that are not valid (`422` only). */
  readonly problems: readonly ImportProblem[];
  /** Whether the server reported as many problems as it ever does, so there may be more. */
  readonly truncated: boolean;
}

/** Dictionary key of the message of a `422` that is about the file as a whole. */
function fileIssueKey(error: ApiError): string {
  const issue = error.details.find((detail) => detail.field === 'file')?.issue;
  switch (issue) {
    case 'incorrect':
      return 'TOBACCOS.IMPORT.ERROR.INCORRECT';
    case 'required':
      return 'TOBACCOS.IMPORT.ERROR.EMPTY';
    case 'tooMany':
      return 'TOBACCOS.IMPORT.ERROR.TOO_MANY';
    default:
      return 'TOBACCOS.IMPORT.ERROR.INVALID';
  }
}

/**
 * Describes a failed import: the statuses the route can answer have their own text (`413`, `415`, `422` with the rows and columns, `429` with the wait, `503`); everything else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function importFailure(i18n: I18nService, error: unknown): ImportFailure {
  const failure = (message: string, problems: readonly ImportProblem[] = []): ImportFailure => ({
    message,
    problems,
    truncated: problems.length >= MAX_REPORTED_PROBLEMS,
  });
  if (!(error instanceof ApiError)) {
    return failure(failureMessage(i18n, error));
  }
  switch (error.status) {
    case 413:
      return failure(i18n.t('TOBACCOS.IMPORT.ERROR.TOO_LARGE'));
    case 415:
      return failure(i18n.t('TOBACCOS.IMPORT.ERROR.UNSUPPORTED'));
    case 422: {
      const problems = importProblems(error.details);
      return problems.length > 0
        ? failure(i18n.t('TOBACCOS.IMPORT.ERROR.ROWS'), problems)
        : failure(i18n.t(fileIssueKey(error)));
    }
    case 429:
      return failure(
        error.retryAfterSeconds === null
          ? i18n.t('TOBACCOS.IMPORT.ERROR.RATE_LIMITED')
          : i18n.t('TOBACCOS.IMPORT.ERROR.RATE_LIMITED_WAIT', { seconds: error.retryAfterSeconds }),
      );
    case 503:
      return failure(i18n.t('TOBACCOS.IMPORT.ERROR.UNAVAILABLE'));
    default:
      return failure(failureMessage(i18n, error));
  }
}
