import { percentIssue, percentOrNull } from './percent';

describe('percentOrNull', () => {
  it('is null for empty or blank text and the number otherwise', () => {
    expect(percentOrNull('')).toBeNull();
    expect(percentOrNull('   ')).toBeNull();
    expect(percentOrNull('12.5')).toBe(12.5);
    expect(percentOrNull('0')).toBe(0);
  });
});

describe('percentIssue', () => {
  it.each([
    ['', undefined],
    ['  ', undefined],
    ['0', undefined],
    ['50', undefined],
    ['100', undefined],
    ['abc', { kind: 'type' }],
    ['-1', { kind: 'minimum' }],
    ['100.5', { kind: 'maximum' }],
  ])('"%s" -> %j', (value, issue) => {
    expect(percentIssue(value)).toEqual(issue);
  });
});
