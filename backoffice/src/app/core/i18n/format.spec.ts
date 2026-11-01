import { formatDate, formatMoney, formatNumber } from './format';

describe('format', () => {
  it('formats a date for the language', () => {
    expect(formatDate('2026-03-05T12:00:00Z', 'it')).toBe('5 mar 2026');
  });

  it('accepts custom date options', () => {
    expect(
      formatDate(new Date(Date.UTC(2026, 2, 5, 12)), 'it', { dateStyle: 'short', timeZone: 'UTC' }),
    ).toBe('05/03/26');
  });

  it('rejects an invalid date', () => {
    expect(() => formatDate('not a date', 'it')).toThrow(RangeError);
  });

  it('formats a number for the language', () => {
    expect(formatNumber(1234567.5, 'it')).toBe('1.234.567,5');
    expect(formatNumber(0.5, 'it', { style: 'percent' })).toBe('50%');
  });

  it('formats minor units as currency', () => {
    expect(formatMoney(12345600, 'EUR', 'it').replace(/\s/g, ' ')).toBe('123.456,00 €');
  });

  it('respects currencies without minor units', () => {
    expect(formatMoney(500, 'JPY', 'it').replace(/\s/g, ' ')).toContain('500');
  });

  it('rejects an invalid currency code', () => {
    expect(() => formatMoney(1, 'x', 'it')).toThrow(RangeError);
  });
});
