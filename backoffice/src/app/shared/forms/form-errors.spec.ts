import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, required, validate, ReadonlyFieldTree } from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
  waitText,
} from './form-errors';

function i18n(): I18nService {
  const service = TestBed.inject(I18nService);
  vi.spyOn(service, 't').mockImplementation((key) => `[${key}]`);
  return service;
}

function makeForm() {
  return TestBed.runInInjectionContext(() =>
    form(signal({ name: '', other: '' }), (path) => {
      required(path.name);
      validate(path.other, ({ value }) =>
        value() === 'with-message' ? { kind: 'server', message: 'Dal server' } : undefined,
      );
      validate(path.other, ({ value }) => (value() === 'bare' ? { kind: 'server' } : undefined));
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('fieldErrorMessage', () => {
  it('is null when the field is valid', () => {
    const f = makeForm();
    f.name().value.set('x');
    expect(fieldErrorMessage(i18n(), f.name())).toBeNull();
  });

  it('hides client errors until the field is touched', () => {
    const f = makeForm();
    const service = i18n();
    expect(fieldErrorMessage(service, f.name())).toBeNull();
    f.name().markAsTouched();
    expect(fieldErrorMessage(service, f.name())).toBe('[FORM.ISSUE.REQUIRED]');
  });

  it('shows a server error with its message even when untouched', () => {
    const f = makeForm();
    f.other().value.set('with-message');
    expect(fieldErrorMessage(i18n(), f.other())).toBe('Dal server');
  });

  it('falls back to the generic message for a server error without text', () => {
    const f = makeForm();
    f.other().value.set('bare');
    expect(fieldErrorMessage(i18n(), f.other())).toBe('[FORM.ISSUE.INVALID]');
  });
});

describe('serverFieldErrors', () => {
  const error = (details: { field: string; issue: string }[]) =>
    new ApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'm', details });

  it('maps the first issue of each known field to a translated server error', () => {
    const f = makeForm();
    const result = serverFieldErrors(
      i18n(),
      error([
        { field: 'name', issue: 'tooShort' },
        { field: 'name', issue: 'required' },
        { field: 'other', issue: 'incorrect' },
      ]),
      { name: f.name, other: f.other },
    );
    expect(result.unmatched).toBe(false);
    expect(result.errors).toEqual([
      { kind: 'server', fieldTree: f.name, message: '[FORM.ISSUE.TOO_SHORT]' },
      { kind: 'server', fieldTree: f.other, message: '[FORM.ISSUE.INCORRECT]' },
    ]);
  });

  it.each(['unknown', '(body)', '__proto__', 'constructor'])(
    'reports a detail on %s as unmatched',
    (field) => {
      const f = makeForm();
      const result = serverFieldErrors(i18n(), error([{ field, issue: 'required' }]), {
        name: f.name,
      });
      expect(result.unmatched).toBe(true);
      expect(result.errors).toEqual([]);
    },
  );

  it('reports an error without details as unmatched', () => {
    expect(serverFieldErrors(i18n(), error([]), {})).toEqual({ errors: [], unmatched: true });
  });
});

describe('focusFirstError', () => {
  it('focuses the control of the first field with an error', () => {
    const focusBoundControl = vi.fn();
    const root = (() => ({
      errorSummary: () => [{ fieldTree: () => ({ focusBoundControl }) }],
    })) as unknown as ReadonlyFieldTree<unknown>;
    focusFirstError(root);
    expect(focusBoundControl).toHaveBeenCalledOnce();
  });

  it('does nothing when there is no error', () => {
    const root = (() => ({ errorSummary: () => [] })) as unknown as ReadonlyFieldTree<unknown>;
    expect(() => focusFirstError(root)).not.toThrow();
  });
});

describe('failureMessage', () => {
  it('uses the central mapping for API errors', () => {
    const error = new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'm' });
    expect(failureMessage(i18n(), error)).toBe('[ERRORS.API.RATE_LIMITED]');
  });

  it('says how long to wait on a rate limit that tells it, and the code of the browser block', () => {
    const wait = (retryAfterSeconds: number) =>
      new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'm', retryAfterSeconds });
    const t = vi.spyOn(TestBed.inject(I18nService), 't');
    t.mockImplementation((key, params) => `[${key}${params ? JSON.stringify(params) : ''}]`);
    const service = TestBed.inject(I18nService);
    const message = failureMessage(service, wait(30));
    expect(message).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    expect(message).toContain('ERRORS.WAIT.SECONDS');
    expect(message).toContain('30');
    const browser = new ApiError({ status: 403, code: 'BROWSER_REQUIRED', message: 'm' });
    expect(failureMessage(service, browser)).toBe('[ERRORS.API.BROWSER_REQUIRED]');
  });

  it('writes a waiting time in the unit that reads best, in the singular when it is one', () => {
    const service = TestBed.inject(I18nService);
    vi.spyOn(service, 't').mockImplementation((key, params) => `${key}:${params?.['count']}`);
    expect(waitText(service, 0.2)).toBe('ERRORS.WAIT.SECOND:1');
    expect(waitText(service, 59)).toBe('ERRORS.WAIT.SECONDS:59');
    expect(waitText(service, 60)).toBe('ERRORS.WAIT.MINUTE:1');
    expect(waitText(service, 61)).toBe('ERRORS.WAIT.MINUTES:2');
    expect(waitText(service, 3600)).toBe('ERRORS.WAIT.HOUR:1');
    expect(waitText(service, 7201)).toBe('ERRORS.WAIT.HOURS:3');
  });

  it('logs anything else and answers generically', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('boom');
    expect(failureMessage(i18n(), boom)).toBe('[ERRORS.GENERIC.MESSAGE]');
    expect(console.error).toHaveBeenCalledWith(boom);
  });
});
