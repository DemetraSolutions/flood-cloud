import {
  ERROR_CODE_PATTERN,
  errorDocumentTypeKey,
  formatDay,
  isErrorDocumentType,
} from './error-documents.types';

describe('error document types', () => {
  it('recognizes the known document types only', () => {
    expect(isErrorDocumentType('invoice')).toBe(true);
    expect(isErrorDocumentType('creditNote')).toBe(true);
    expect(isErrorDocumentType('credit-note')).toBe(false);
    expect(isErrorDocumentType(null)).toBe(false);
  });

  it('builds the dictionary key of a type', () => {
    expect(errorDocumentTypeKey('invoice')).toBe('ERROR_DOCUMENTS.TYPE.INVOICE');
    expect(errorDocumentTypeKey('creditNote')).toBe('ERROR_DOCUMENTS.TYPE.CREDIT_NOTE');
  });

  it('accepts only 1 to 10 letters and digits as an error code', () => {
    expect(ERROR_CODE_PATTERN.test('0099')).toBe(true);
    expect(ERROR_CODE_PATTERN.test('AbC123')).toBe(true);
    expect(ERROR_CODE_PATTERN.test('')).toBe(false);
    expect(ERROR_CODE_PATTERN.test('12345678901')).toBe(false);
    expect(ERROR_CODE_PATTERN.test('a-b')).toBe(false);
  });

  it('formats a day as dd-MM-yyyy and rejects an invalid date', () => {
    expect(formatDay('2026-09-25T12:00:00.000Z')).toBe('25-09-2026');
    expect(formatDay('2026-01-05T12:00:00.000Z')).toBe('05-01-2026');
    expect(formatDay('not a date')).toBeNull();
  });
});
