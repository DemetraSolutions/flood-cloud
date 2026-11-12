import { numberIssue, numberOrNull, numberText, textOrNull } from './catalog-fields';

describe('numberIssue', () => {
  it('requires a value unless optional', () => {
    expect(numberIssue('  ', { min: 0 })).toBe('required');
    expect(numberIssue('', { min: 0, optional: true })).toBeUndefined();
  });

  it('rejects text that is not a finite number', () => {
    expect(numberIssue('abc', { min: 0 })).toBe('type');
    expect(numberIssue('Infinity', { min: 0 })).toBe('type');
  });

  it('rejects decimals when an integer is expected', () => {
    expect(numberIssue('1.5', { min: 0, integer: true })).toBe('type');
    expect(numberIssue('2', { min: 0, integer: true })).toBeUndefined();
    expect(numberIssue('1.5', { min: 0 })).toBeUndefined();
  });

  it('checks the minimum and the maximum', () => {
    expect(numberIssue('-1', { min: 0 })).toBe('minimum');
    expect(numberIssue('101', { min: 0, max: 100 })).toBe('maximum');
    expect(numberIssue('100', { min: 0, max: 100 })).toBeUndefined();
    expect(numberIssue('1000', { min: 0 })).toBeUndefined();
  });
});

describe('field conversions', () => {
  it('converts a number text to a number or null', () => {
    expect(numberOrNull(' 12.5 ')).toBe(12.5);
    expect(numberOrNull('  ')).toBeNull();
  });

  it('converts a number to the text of a field', () => {
    expect(numberText(7)).toBe('7');
    expect(numberText(null)).toBe('');
  });

  it('trims a text or returns null when blank', () => {
    expect(textOrNull('  abc ')).toBe('abc');
    expect(textOrNull('   ')).toBeNull();
  });
});
