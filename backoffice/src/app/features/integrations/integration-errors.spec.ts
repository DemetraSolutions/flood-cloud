import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ApiError } from '../../core/api/api-error';
import { ApiErrorCode } from '../../core/api/api.types';
import { apiErrorOf, integrationFailure, outcomeUnknown } from './integration-errors';

const error = (
  code: ApiErrorCode,
  status: number,
  details: { field: string; issue: string }[] = [],
  retryAfterSeconds: number | null = null,
) => new ApiError({ status, code, message: code, details, retryAfterSeconds });

describe('integration errors', () => {
  const i18n = () => {
    const service = TestBed.inject(I18nService);
    vi.spyOn(service, 't').mockImplementation((key, params) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
    );
    return service;
  };

  describe('outcomeUnknown', () => {
    it.each([
      [error('INTERNAL_ERROR', 500), true],
      [error('PROVIDER_ERROR', 502), true],
      [error('SERVICE_UNAVAILABLE', 503), true],
      [new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'x' }), true],
      [new Error('boom'), true],
      [error('VALIDATION_ERROR', 422), false],
      [error('PRECONDITION_FAILED', 412), false],
      [error('RATE_LIMITED', 429), false],
      [error('FORBIDDEN', 403), false],
    ])('says whether the outcome of %s is unknown', (failure, unknown) => {
      expect(outcomeUnknown(failure)).toBe(unknown);
    });
  });

  describe('integrationFailure', () => {
    it('invites to read the place again after a 412', () => {
      expect(integrationFailure(i18n(), error('PRECONDITION_FAILED', 412))).toEqual({
        message: 'INTEGRATIONS.STALE',
        stale: true,
      });
    });

    it.each([
      ['PROVIDER_ERROR', 502, 'INTEGRATIONS.PROVIDER_ERROR'],
      ['SERVICE_UNAVAILABLE', 503, 'INTEGRATIONS.UNAVAILABLE'],
      ['FORBIDDEN', 403, 'ERRORS.API.FORBIDDEN'],
      ['NOT_FOUND', 404, 'ERRORS.API.NOT_FOUND'],
    ] as const)('says the same sentence for %s', (code, status, text) => {
      expect(integrationFailure(i18n(), error(code, status))).toEqual({
        message: text,
        stale: false,
      });
    });

    it('tells how long to wait after a 429', () => {
      const failure = integrationFailure(i18n(), error('RATE_LIMITED', 429, [], 90));
      expect(failure.message).toContain('ERRORS.API.RATE_LIMITED_WAIT');
      expect(failure.stale).toBe(false);
    });

    it('says the generic sentence for anything that is not an API error', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(integrationFailure(i18n(), new Error('boom')).message).toBe(
        'ERRORS.GENERIC.MESSAGE',
      );
    });

    describe('422', () => {
      const validation = (field: string, issue: string) =>
        error('VALIDATION_ERROR', 422, [{ field, issue }]);

      it.each([
        [[], 'INTEGRATIONS.INVALID'],
        [[{ field: 'integrations.dojo.status', issue: 'incorrect' }], 'INTEGRATIONS.DISABLED'],
        [[{ field: 'integrations.tsh.secret', issue: 'required' }], 'INTEGRATIONS.CREDENTIAL_MISSING'],
        [[{ field: 'integrations.dojo.apiKey', issue: 'incorrect' }], 'INTEGRATIONS.CREDENTIAL_REFUSED'],
        [[{ field: 'street', issue: 'required' }], 'INTEGRATIONS.INVALID'],
      ])('maps %j to its sentence', (details, text) => {
        expect(integrationFailure(i18n(), error('VALIDATION_ERROR', 422, details)).message).toBe(text);
      });

      it('says the code was refused when the field of the call is rejected', () => {
        expect(
          integrationFailure(i18n(), validation('activationCode', 'incorrect'), 'activationCode')
            .message,
        ).toBe('INTEGRATIONS.CODE_REFUSED');
      });

      it('says the issue of the field of the call otherwise', () => {
        expect(
          integrationFailure(i18n(), validation('activationCode', 'pattern'), 'activationCode')
            .message,
        ).toBe('FORM.ISSUE.PATTERN');
      });
    });
  });

  describe('apiErrorOf', () => {
    it('returns the error itself, the one a failed resource wraps, or null', () => {
      const failure = error('NOT_FOUND', 404);
      expect(apiErrorOf(failure)).toBe(failure);
      expect(apiErrorOf({ cause: failure })).toBe(failure);
      expect(apiErrorOf({ cause: new Error('x') })).toBeNull();
      expect(apiErrorOf(undefined)).toBeNull();
    });
  });
});
