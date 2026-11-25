import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { contactFailureMessage, isReferenced, referenceKinds } from './contact-errors';

const conflict = (details: { field: string; issue: string }[] = []) =>
  new ApiError({ status: 409, code: 'CONFLICT', message: 'x', details });

const ref = (field: string) => ({ field, issue: 'referenced' });

function i18n(): I18nService {
  const service = TestBed.inject(I18nService);
  vi.spyOn(service, 't').mockImplementation(
    (key, params) => `[${key}${params ? JSON.stringify(params) : ''}]`,
  );
  return service;
}

afterEach(() => vi.restoreAllMocks());

describe('isReferenced', () => {
  it('is true for a conflict that lists a reference', () => {
    expect(isReferenced(conflict([ref('sales.s1')]))).toBe(true);
  });

  it('is false for a conflict without references, another code or another kind of error', () => {
    expect(isReferenced(conflict([{ field: 'x', issue: 'other' }]))).toBe(false);
    expect(isReferenced(conflict())).toBe(false);
    expect(
      isReferenced(
        new ApiError({
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'x',
          details: [ref('sales.s1')],
        }),
      ),
    ).toBe(false);
    expect(isReferenced(new Error('boom'))).toBe(false);
  });
});

describe('referenceKinds', () => {
  it('counts the references of each kind in the order of the kinds, leaving out the unknown ones', () => {
    const error = conflict([
      ref('sales.s1'),
      ref('promotions.p1'),
      ref('sales.s2'),
      ref('mystery.m1'),
      { field: 'documents.d1', issue: 'other' },
    ]);
    expect(referenceKinds(error, ['promotions', 'documents', 'sales'])).toEqual([
      { kind: 'promotions', count: 1 },
      { kind: 'sales', count: 2 },
    ]);
  });
});

describe('contactFailureMessage', () => {
  it('has a text for the check that was too slow', () => {
    const error = new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'x' });
    expect(contactFailureMessage(i18n(), error)).toBe('[CONTACTS.ERROR.TOO_SLOW]');
  });

  it('has a text for a concurrent change', () => {
    expect(contactFailureMessage(i18n(), conflict())).toBe('[CONTACTS.ERROR.CONCURRENT]');
  });

  it('uses the central mapping for the rest, with the waiting time of a rate limit', () => {
    const limited = new ApiError({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'x',
      retryAfterSeconds: 120,
    });
    const message = contactFailureMessage(i18n(), limited);
    expect(message).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    expect(message).toContain('ERRORS.WAIT.MINUTES');
    const plain = new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'x' });
    expect(contactFailureMessage(i18n(), plain)).toBe('[ERRORS.API.RATE_LIMITED]');
  });
});
