import { CONFIGURED, UNCONFIGURED } from '../../../testing/einvoicing';
import {
  limitIssue,
  passwordIssue,
  toChange,
  toFormModel,
  usernameIssue,
} from './einvoicing-account.types';

describe('toFormModel', () => {
  it('starts from the defaults before an account exists', () => {
    const defaults = {
      enabled: true,
      username: '',
      password: '',
      maxPerHour: '55',
      maxPerYear: '10000',
    };
    expect(toFormModel(null)).toEqual(defaults);
    expect(toFormModel(UNCONFIGURED)).toEqual(defaults);
  });

  it('starts from the account, with an empty password and an empty annual ceiling for none', () => {
    expect(toFormModel(CONFIGURED)).toEqual({
      enabled: true,
      username: 'flood.user',
      password: '',
      maxPerHour: '55',
      maxPerYear: '10000',
    });
    expect(toFormModel({ ...CONFIGURED, enabled: false, maxPerYear: null })).toMatchObject({
      enabled: false,
      maxPerYear: '',
    });
  });
});

describe('field issues', () => {
  it('checks the username', () => {
    expect(usernameIssue('')).toBe('required');
    expect(usernameIssue('has space')).toBe('pattern');
    expect(usernameIssue('è')).toBe('pattern');
    expect(usernameIssue('a'.repeat(101))).toBe('maxLength');
    expect(usernameIssue('a'.repeat(100))).toBeUndefined();
  });

  it('checks the password, required only when none is stored', () => {
    expect(passwordIssue('', true)).toBe('required');
    expect(passwordIssue('', false)).toBeUndefined();
    expect(passwordIssue('a\nb', false)).toBe('pattern');
    expect(passwordIssue('a\u007fb', false)).toBe('pattern');
    expect(passwordIssue('a\u0085b', false)).toBe('pattern');
    expect(passwordIssue('a\u009fb', false)).toBe('pattern');
    expect(passwordIssue('a\u00a0b', false)).toBeUndefined();
    expect(passwordIssue('a'.repeat(257), false)).toBe('maxLength');
    expect(passwordIssue('with spaces é', true)).toBeUndefined();
  });

  it('checks the ceilings', () => {
    expect(limitIssue(' ', 1000, false)).toBe('required');
    expect(limitIssue('', 1000, true)).toBeUndefined();
    expect(limitIssue('1.5', 1000, false)).toBe('pattern');
    expect(limitIssue('0', 1000, false)).toBe('minimum');
    expect(limitIssue('1001', 1000, false)).toBe('maximum');
    expect(limitIssue('1000', 1000, false)).toBeUndefined();
  });
});

describe('toChange', () => {
  it('leaves the password out when none was typed, and sends null for no annual ceiling', () => {
    expect(
      toChange({ enabled: true, username: 'u', password: '', maxPerHour: '55', maxPerYear: ' ' }),
    ).toEqual({ enabled: true, username: 'u', maxPerHour: 55, maxPerYear: null });
  });

  it('sends the password when typed', () => {
    expect(
      toChange({
        enabled: false,
        username: 'u',
        password: 'secret',
        maxPerHour: '5',
        maxPerYear: '9',
      }),
    ).toEqual({ enabled: false, username: 'u', password: 'secret', maxPerHour: 5, maxPerYear: 9 });
  });
});
