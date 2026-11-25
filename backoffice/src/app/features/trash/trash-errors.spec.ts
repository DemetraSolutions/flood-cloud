import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { ApiErrorCode } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { trashFailureMessage } from './trash-errors';

function setup() {
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key) => key);
  return i18n;
}

const error = (status: number, code: ApiErrorCode) =>
  new ApiError({ status, code, message: code, details: [] });

afterEach(() => vi.restoreAllMocks());

describe('trashFailureMessage', () => {
  it('has its own text for a check of the contacts that was too slow', () => {
    expect(trashFailureMessage(setup(), 'contacts', error(503, 'SERVICE_UNAVAILABLE'))).toBe(
      'CONTACTS.ERROR.TOO_SLOW',
    );
  });

  it('uses the general mapping for the same error on another kind', () => {
    expect(trashFailureMessage(setup(), 'companies', error(503, 'SERVICE_UNAVAILABLE'))).toBe(
      'ERRORS.API.SERVICE_UNAVAILABLE',
    );
  });

  it('uses the general mapping for other errors of the contacts', () => {
    expect(trashFailureMessage(setup(), 'contacts', error(403, 'FORBIDDEN'))).toBe(
      'ERRORS.API.FORBIDDEN',
    );
  });

  it('gives the generic message for an error that is not from the API', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(trashFailureMessage(setup(), 'contacts', new Error('network'))).toBe(
      'ERRORS.GENERIC.MESSAGE',
    );
    expect(logged).toHaveBeenCalledOnce();
  });
});
