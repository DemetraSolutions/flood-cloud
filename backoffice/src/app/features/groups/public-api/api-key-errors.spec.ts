import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { apiKeyFailureMessage, keyEditorErrors } from './api-key-errors';

function error(code: ApiError['code'], details: { field: string; issue: string }[] = []) {
  return new ApiError({ status: 400, code, message: code, details });
}

function i18n(): I18nService {
  const service = TestBed.inject(I18nService);
  vi.spyOn(service, 't').mockImplementation((key) => key);
  return service;
}

afterEach(() => vi.restoreAllMocks());

describe('api key errors', () => {
  describe('apiKeyFailureMessage', () => {
    it('explains the 409 of a creation and of a modification', () => {
      expect(apiKeyFailureMessage(i18n(), error('CONFLICT'), true)).toBe(
        'PUBLIC_API.ERROR.TOO_MANY',
      );
      expect(apiKeyFailureMessage(i18n(), error('CONFLICT'), false)).toBe(
        'PUBLIC_API.ERROR.NOT_EDITABLE',
      );
    });

    it.each(['FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'VALIDATION_ERROR'] as const)(
      'uses the central message of %s',
      (code) => {
        expect(apiKeyFailureMessage(i18n(), error(code), true)).toBe(`ERRORS.API.${code}`);
      },
    );

    it('reports anything else generically', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(apiKeyFailureMessage(i18n(), new Error('x'), true)).toBe('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('keyEditorErrors', () => {
    const known = ['name', 'restrictions.companyIds'];

    it('has nothing without an error', () => {
      expect(keyEditorErrors(i18n(), null, known, true)).toEqual({ fields: {}, form: null });
    });

    it('puts the details on the fields, also for an element of a list', () => {
      const result = keyEditorErrors(
        i18n(),
        error('VALIDATION_ERROR', [
          { field: 'name', issue: 'required' },
          { field: 'restrictions.companyIds.2', issue: 'incorrect' },
        ]),
        known,
        true,
      );
      expect(result).toEqual({
        fields: { name: 'FORM.ISSUE.REQUIRED', 'restrictions.companyIds': 'FORM.ISSUE.INCORRECT' },
        form: null,
      });
    });

    it('gives a form message for what lands on no field', () => {
      expect(keyEditorErrors(i18n(), error('CONFLICT'), known, false).form).toBe(
        'PUBLIC_API.ERROR.NOT_EDITABLE',
      );
      expect(
        keyEditorErrors(
          i18n(),
          error('VALIDATION_ERROR', [{ field: 'other', issue: 'unknown' }]),
          known,
          true,
        ).form,
      ).toBe('ERRORS.API.VALIDATION_ERROR');
    });
  });
});
