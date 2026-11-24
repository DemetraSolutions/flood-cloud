import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { CONFLICT_REASONS, syncFailureMessage } from './tobacco-sync-errors';

const i18n = {
  t: (key: string, params?: object) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
} as unknown as I18nService;
const failed = (status: number, init: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  new ApiError({
    status,
    code: status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    message: 'x',
    ...init,
  });
const message = (status: number, init = {}) => syncFailureMessage(i18n, failed(status, init));

describe('syncFailureMessage', () => {
  it('tells the permission from the function on a 403', () => {
    expect(message(403, { code: 'FEATURE_DISABLED' })).toBe('TOBACCO_SYNC.ERROR.FEATURE');
    expect(message(403, { code: 'FORBIDDEN' })).toBe('TOBACCO_SYNC.ERROR.FORBIDDEN');
  });

  it.each([...CONFLICT_REASONS])('has its own text for the 409 of "%s"', (reason) => {
    expect(message(409, { code: 'CONFLICT', details: [{ field: 'group', issue: reason }] })).toBe(
      `TOBACCO_SYNC.ERROR.CONFLICT.${reason}`,
    );
  });

  it('tells a reused key and an unknown conflict', () => {
    expect(
      message(409, { code: 'CONFLICT', details: [{ field: 'Idempotency-Key', issue: 'reused' }] }),
    ).toBe('TOBACCO_SYNC.ERROR.KEY_REUSED');
    expect(message(409, { code: 'CONFLICT' })).toBe('TOBACCO_SYNC.ERROR.CONFLICT.other');
    expect(
      message(409, { code: 'CONFLICT', details: [{ field: 'group', issue: 'whatever' }] }),
    ).toBe('TOBACCO_SYNC.ERROR.CONFLICT.other');
  });

  it('has its own text for 413, 422 and 429', () => {
    expect(message(413)).toBe('TOBACCO_SYNC.ERROR.TOO_LARGE');
    expect(message(422, { details: [{ field: 'warehouse', issue: 'notAllowed' }] })).toBe(
      'TOBACCO_SYNC.ERROR.WAREHOUSE',
    );
    expect(message(422, { details: [{ field: 'placeIds.2', issue: 'notFound' }] })).toBe(
      'TOBACCO_SYNC.ERROR.PLACES',
    );
    expect(message(422, { details: [{ field: 'warehouse', issue: 'type' }] })).toBe(
      'TOBACCO_SYNC.ERROR.INVALID',
    );
    expect(message(429)).toBe('TOBACCO_SYNC.ERROR.RATE_LIMITED');
    expect(message(429, { retryAfterSeconds: 60 })).toBe(
      'TOBACCO_SYNC.ERROR.RATE_LIMITED_WAIT {"seconds":60}',
    );
  });

  it('leaves everything else to the central mapping', () => {
    expect(message(500)).toBe('ERRORS.API.INTERNAL_ERROR');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(syncFailureMessage(i18n, new Error('boom'))).toBe('ERRORS.GENERIC.MESSAGE');
  });
});
