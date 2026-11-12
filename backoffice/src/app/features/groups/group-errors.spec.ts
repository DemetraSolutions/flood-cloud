import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import {
  groupFailureMessage,
  hasFieldDetails,
  isGroupConflict,
  renameFields,
} from './group-errors';

const detail = { field: 'name', issue: 'REQUIRED' };
const apiError = (code: ApiError['code'], details: { field: string; issue: string }[] = []) =>
  new ApiError({ status: 0, code, message: code, details, requestId: 'req-1' });
const i18n = { t: (key: string) => key } as unknown as I18nService;

describe('group errors', () => {
  it('recognises a conflict', () => {
    expect(isGroupConflict(apiError('CONFLICT'))).toBe(true);
    expect(isGroupConflict(apiError('FORBIDDEN'))).toBe(false);
    expect(isGroupConflict(new Error('x'))).toBe(false);
  });

  it.each(['VALIDATION_ERROR', 'FORBIDDEN', 'CONFLICT'] as const)(
    'finds field details in a %s',
    (code) => {
      expect(hasFieldDetails(apiError(code, [detail]))).toBe(true);
      expect(hasFieldDetails(apiError(code))).toBe(false);
    },
  );

  it('ignores details of other codes and of other errors', () => {
    expect(hasFieldDetails(apiError('NOT_FOUND', [detail]))).toBe(false);
    expect(hasFieldDetails(new Error('x'))).toBe(false);
  });

  it('asks to reload on a conflict and uses the central mapping otherwise', () => {
    expect(groupFailureMessage(i18n, apiError('CONFLICT'))).toBe('GROUP_SETTINGS.ERROR.CONFLICT');
    expect(groupFailureMessage(i18n, apiError('NOT_FOUND'))).toBe('ERRORS.API.NOT_FOUND');
  });

  it('renames the fields of the details and keeps the rest', () => {
    const renamed = renameFields(apiError('VALIDATION_ERROR', [detail]), (f) => `x.${f}`);
    expect(renamed.details).toEqual([{ field: 'x.name', issue: 'REQUIRED' }]);
    expect(renamed.code).toBe('VALIDATION_ERROR');
    expect(renamed.requestId).toBe('req-1');
  });
});
