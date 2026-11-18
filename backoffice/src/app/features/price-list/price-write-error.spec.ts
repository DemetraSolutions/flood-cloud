import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { priceWriteOutcome } from './price-write-error';

function i18n(): I18nService {
  const service = TestBed.inject(I18nService);
  vi.spyOn(service, 't').mockImplementation((key) => key);
  return service;
}

const field = { name: 'field' } as never;

afterEach(() => vi.restoreAllMocks());

describe('priceWriteOutcome', () => {
  it('reports a stale version', () => {
    const error = new ApiError({ status: 412, code: 'PRECONDITION_FAILED', message: 'x' });
    expect(priceWriteOutcome(i18n(), error, () => ({}))).toEqual({
      stale: true,
      failure: null,
      errors: undefined,
    });
  });

  it('maps the refused fields and keeps the rest out of the form message', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'x',
      details: [{ field: 'plans.basic', issue: 'maximum' }],
    });
    const outcome = priceWriteOutcome(i18n(), error, () => ({ 'plans.basic': field }));
    expect(outcome.stale).toBe(false);
    expect(outcome.failure).toBeNull();
    expect(outcome.errors).toHaveLength(1);
  });

  it('shows a form message when a refused field matches none', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'x',
      details: [{ field: 'plans', issue: 'tooMany' }],
    });
    const outcome = priceWriteOutcome(i18n(), error, () => ({}));
    expect(outcome.failure).toBe('ERRORS.API.VALIDATION_ERROR');
    expect(outcome.errors).toEqual([]);
  });

  it('uses the central message for anything else', () => {
    const error = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
    expect(priceWriteOutcome(i18n(), error, () => ({})).failure).toBe('ERRORS.API.INTERNAL_ERROR');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(priceWriteOutcome(i18n(), new Error('boom'), () => ({})).failure).toBe(
      'ERRORS.GENERIC.MESSAGE',
    );
    // A validation error with no detail is not a field error.
    const bare = new ApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'x' });
    expect(priceWriteOutcome(i18n(), bare, () => ({})).failure).toBe('ERRORS.API.VALIDATION_ERROR');
  });
});
