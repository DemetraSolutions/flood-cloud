import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { downloadFailureMessage, importFailure } from './catalog-xlsx-errors';

const i18n = {
  t: (key: string, params?: object) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
} as unknown as I18nService;
const ROW = { sheet: 'Prodotti', row: 7, column: 'NOME', code: 'required', message: 'm' };
const failed = (
  status: number,
  init: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) =>
  new ApiError({
    status,
    code: status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    message: 'x',
    ...init,
  });

describe('downloadFailureMessage', () => {
  it('has its own text for the statuses a download can fail with', () => {
    expect(downloadFailureMessage(i18n, failed(413))).toBe('CATALOG_XLSX.DOWNLOAD_ERROR.TOO_LARGE');
    expect(downloadFailureMessage(i18n, failed(429))).toBe('CATALOG_XLSX.DOWNLOAD_ERROR.RATE_LIMITED');
    expect(downloadFailureMessage(i18n, failed(429, { retryAfterSeconds: 30 }))).toBe(
      'CATALOG_XLSX.DOWNLOAD_ERROR.RATE_LIMITED_WAIT {"seconds":30}',
    );
    expect(downloadFailureMessage(i18n, failed(409))).toBe('CATALOG_XLSX.DOWNLOAD_ERROR.BUSY');
    expect(downloadFailureMessage(i18n, failed(403))).toBe('CATALOG_XLSX.DOWNLOAD_ERROR.FORBIDDEN');
    expect(downloadFailureMessage(i18n, failed(500))).toBe('CATALOG_XLSX.DOWNLOAD_ERROR.GENERIC');
    expect(downloadFailureMessage(i18n, new Error('boom'))).toBe(
      'CATALOG_XLSX.DOWNLOAD_ERROR.GENERIC',
    );
  });

  it('takes the text of the limits of the file from the tool', () => {
    expect(downloadFailureMessage(i18n, failed(413), 'CONTACTS_XLSX')).toBe(
      'CONTACTS_XLSX.DOWNLOAD_ERROR.TOO_LARGE',
    );
  });
});

describe('importFailure', () => {
  it('has its own text for the statuses the route answers', () => {
    const message = (status: number, init = {}) => importFailure(i18n, failed(status, init)).message;
    expect(message(413)).toBe('CATALOG_XLSX.IMPORT.ERROR.TOO_LARGE');
    expect(message(415)).toBe('CATALOG_XLSX.IMPORT.ERROR.UNSUPPORTED');
    expect(message(409)).toBe('CATALOG_XLSX.IMPORT.ERROR.BUSY');
    expect(message(409, { details: [{ field: 'Idempotency-Key', issue: 'reused' }] })).toBe(
      'CATALOG_XLSX.IMPORT.ERROR.KEY_REUSED',
    );
    expect(message(429)).toBe('CATALOG_XLSX.IMPORT.ERROR.RATE_LIMITED');
    expect(message(429, { retryAfterSeconds: 90 })).toBe(
      'CATALOG_XLSX.IMPORT.ERROR.RATE_LIMITED_WAIT {"seconds":90}',
    );
    expect(message(503)).toBe('CATALOG_XLSX.IMPORT.ERROR.UNAVAILABLE');
    expect(importFailure(i18n, failed(413)).refused).toBe(false);
  });

  it('carries the problems of a 422 with the count and the flag', () => {
    const failure = importFailure(
      i18n,
      failed(422, { rows: [ROW], errorCount: 250, moreErrors: true }),
    );
    expect(failure).toEqual({
      message: 'CATALOG_XLSX.IMPORT.ERROR.ROWS',
      rows: [ROW],
      errorCount: 250,
      moreErrors: true,
      refused: true,
    });
  });

  it('reads the problems of a 422 that also has the standard details', () => {
    const failure = importFailure(
      i18n,
      failed(422, {
        details: [{ field: 'Prodotti!7!NOME', issue: 'required' }],
        rows: [ROW],
        errorCount: 1,
      }),
    );
    expect(failure.message).toBe('CATALOG_XLSX.IMPORT.ERROR.ROWS');
    expect(failure.rows).toEqual([ROW]);
  });

  it('gives a 422 about the file as a whole its own text by reason', () => {
    const about = (issue: string) =>
      importFailure(i18n, failed(422, { details: [{ field: 'file', issue }] }));
    expect(about('incorrect').message).toBe('CATALOG_XLSX.IMPORT.ERROR.INCORRECT');
    expect(about('tooMany').message).toBe('CATALOG_XLSX.IMPORT.ERROR.TOO_MANY');
    expect(about('required').message).toBe('CATALOG_XLSX.IMPORT.ERROR.EMPTY');
    expect(about('other').message).toBe('CATALOG_XLSX.IMPORT.ERROR.INVALID');
    expect(importFailure(i18n, failed(422)).message).toBe('CATALOG_XLSX.IMPORT.ERROR.INVALID');
    expect(about('incorrect')).toMatchObject({ rows: [], errorCount: null, moreErrors: false, refused: true });
  });

  it('takes the text of the limits and of the lock from the tool', () => {
    expect(importFailure(i18n, failed(409), 'CARDS_XLSX').message).toBe('CARDS_XLSX.IMPORT.ERROR.BUSY');
    expect(
      importFailure(i18n, failed(422, { details: [{ field: 'file', issue: 'tooMany' }] }), 'CARDS_XLSX')
        .message,
    ).toBe('CARDS_XLSX.IMPORT.ERROR.TOO_MANY');
    expect(
      importFailure(i18n, failed(409, { details: [{ field: 'Idempotency-Key', issue: 'reused' }] }), 'CARDS_XLSX')
        .message,
    ).toBe('CATALOG_XLSX.IMPORT.ERROR.KEY_REUSED');
  });

  it('uses the central mapping for anything else', () => {
    expect(importFailure(i18n, failed(500)).message).toBe('ERRORS.API.INTERNAL_ERROR');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(importFailure(i18n, new Error('boom')).message).toBe('ERRORS.GENERIC.MESSAGE');
  });
});
