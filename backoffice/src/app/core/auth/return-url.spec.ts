import { safeReturnUrl } from './return-url';

describe('safeReturnUrl', () => {
  it.each(['/', '/profile', '/profile/sessions?x=1#top', '/a%20b', '/loginx', '/logins/1'])(
    'accepts the internal path %s',
    (value) => {
      expect(safeReturnUrl(value)).toBe(value);
    },
  );

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['an empty string', ''],
    ['a relative path', 'profile'],
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['a slash-backslash URL', '/\\evil.example'],
    ['a backslash anywhere', '/a\\b'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a control character', '/a\nb'],
    ['a tab', '/a\tb'],
    ['a DEL character', '/a\u007fb'],
    ['the login page', '/login'],
    ['the login page with a query', '/login?returnUrl=%2F'],
    ['a login sub-path', '/login/x'],
    ['an excessive length', `/${'a'.repeat(2048)}`],
  ])('rejects %s', (_label, value) => {
    expect(safeReturnUrl(value)).toBeNull();
  });
});
