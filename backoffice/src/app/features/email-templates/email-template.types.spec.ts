import {
  hasBodyControl,
  hasNameControl,
  TEMPLATE_LIMITS,
  templateRoute,
  utf8Length,
} from './email-template.types';

describe('email template types', () => {
  it('mirrors the limits of the server', () => {
    expect(TEMPLATE_LIMITS).toEqual({ name: 150, textBytes: 65536, htmlBytes: 262144 });
  });

  it('measures a text in UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('')).toBe(0);
  });

  it('refuses NUL and the control characters but tab, carriage return and line feed in a content', () => {
    expect(hasBodyControl('a\tb\r\nc')).toBe(false);
    for (const code of [0, 8, 11, 12, 14, 31, 127]) {
      expect(hasBodyControl(`a${String.fromCharCode(code)}b`)).toBe(true);
    }
  });

  it('refuses every control character in a name', () => {
    expect(hasNameControl('Conferma')).toBe(false);
    expect(hasNameControl('a\nb')).toBe(true);
    expect(hasNameControl('a\tb')).toBe(true);
  });

  it('builds the router links of the list, of a new template and of one template', () => {
    expect(templateRoute('g1')).toEqual(['/groups', 'g1', 'email-templates']);
    expect(templateRoute('g1', null)).toEqual(['/groups', 'g1', 'email-templates', 'new']);
    expect(templateRoute('g1', 't1')).toEqual(['/groups', 'g1', 'email-templates', 't1']);
  });
});
