import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { importFailure } from './tobaccos-import-error';

const i18n = {
  t: (key: string, params?: object) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
} as unknown as I18nService;
const failed = (
  status: number,
  details: { field: string; issue: string }[] = [],
  retryAfterSeconds: number | null = null,
) =>
  new ApiError({
    status,
    code: status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    message: 'x',
    details,
    retryAfterSeconds,
  });

describe('importFailure', () => {
  it('has its own text for the statuses the route answers', () => {
    expect(importFailure(i18n, failed(413)).message).toBe('TOBACCOS.IMPORT.ERROR.TOO_LARGE');
    expect(importFailure(i18n, failed(415)).message).toBe('TOBACCOS.IMPORT.ERROR.UNSUPPORTED');
    expect(importFailure(i18n, failed(429)).message).toBe('TOBACCOS.IMPORT.ERROR.RATE_LIMITED');
    expect(importFailure(i18n, failed(429, [], 90)).message).toBe(
      'TOBACCOS.IMPORT.ERROR.RATE_LIMITED_WAIT {"seconds":90}',
    );
    expect(importFailure(i18n, failed(503)).message).toBe('TOBACCOS.IMPORT.ERROR.UNAVAILABLE');
  });

  it('gives a 422 about the file as a whole its own text by reason', () => {
    const about = (issue: string) =>
      importFailure(i18n, failed(422, [{ field: 'file', issue }])).message;
    expect(about('incorrect')).toBe('TOBACCOS.IMPORT.ERROR.INCORRECT');
    expect(about('required')).toBe('TOBACCOS.IMPORT.ERROR.EMPTY');
    expect(about('tooMany')).toBe('TOBACCOS.IMPORT.ERROR.TOO_MANY');
    expect(about('unknown')).toBe('TOBACCOS.IMPORT.ERROR.INVALID');
    expect(importFailure(i18n, failed(422)).message).toBe('TOBACCOS.IMPORT.ERROR.INVALID');
  });

  it('lists the cells of a 422 with rows, and says when there may be more', () => {
    const one = importFailure(i18n, failed(422, [{ field: 'rows[4].price', issue: 'type' }]));
    expect(one).toEqual({
      message: 'TOBACCOS.IMPORT.ERROR.ROWS',
      problems: [{ row: 4, columnKey: 'TOBACCOS.COLUMN.PRICE', columnParams: {}, issue: 'type' }],
      truncated: false,
    });
    const many = importFailure(
      i18n,
      failed(
        422,
        Array.from({ length: 50 }, (_item, index) => ({
          field: `rows[${index + 2}].code`,
          issue: 'taken',
        })),
      ),
    );
    expect(many.problems).toHaveLength(50);
    expect(many.truncated).toBe(true);
  });

  it('uses the central mapping for everything else', () => {
    expect(importFailure(i18n, failed(500)).message).toBe('ERRORS.API.INTERNAL_ERROR');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(importFailure(i18n, new Error('boom'))).toEqual({
      message: 'ERRORS.GENERIC.MESSAGE',
      problems: [],
      truncated: false,
    });
  });
});
