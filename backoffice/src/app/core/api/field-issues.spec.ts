import { FIELD_ISSUES, issueMessageKey } from './field-issues';

describe('issueMessageKey', () => {
  it.each([
    ['required', 'FORM.ISSUE.REQUIRED'],
    ['tooShort', 'FORM.ISSUE.TOO_SHORT'],
    ['sameAsUsername', 'FORM.ISSUE.SAME_AS_USERNAME'],
    ['forbiddenKey', 'FORM.ISSUE.FORBIDDEN_KEY'],
    ['invalidCharacters', 'FORM.ISSUE.INVALID_CHARACTERS'],
  ])('maps %s to %s', (issue, key) => {
    expect(issueMessageKey(issue)).toBe(key);
  });

  it('maps the email validator onto the format issue', () => {
    expect(issueMessageKey('email')).toBe('FORM.ISSUE.FORMAT');
  });

  it.each(['somethingNew', '__proto__', 'constructor', ''])(
    'falls back to the generic message for %j',
    (issue) => {
      expect(issueMessageKey(issue)).toBe('FORM.ISSUE.INVALID');
    },
  );

  it('has a key for every known issue', () => {
    expect(new Set(FIELD_ISSUES.map(issueMessageKey)).size).toBe(FIELD_ISSUES.length);
  });
});
