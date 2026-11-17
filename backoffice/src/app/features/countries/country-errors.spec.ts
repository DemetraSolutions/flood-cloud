import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { countryNotice, isFieldFailure } from './country-errors';

const error = (
  status: number,
  code: ApiError['code'],
  details: { field: string; issue: string }[] = [],
) => new ApiError({ status, code, message: code, details });

function i18n(): I18nService {
  const service = TestBed.inject(I18nService);
  vi.spyOn(service, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  return service;
}

afterEach(() => vi.restoreAllMocks());

describe('isFieldFailure', () => {
  it('is true for details on the code or the name', () => {
    expect(isFieldFailure(error(409, 'CONFLICT', [{ field: 'code', issue: 'taken' }]))).toBe(true);
    expect(
      isFieldFailure(error(422, 'VALIDATION_ERROR', [{ field: 'name', issue: 'required' }])),
    ).toBe(true);
  });

  it.each([
    ['a stale version', error(412, 'PRECONDITION_FAILED', [{ field: 'code', issue: 'x' }])],
    ['details on other fields', error(409, 'CONFLICT', [{ field: 'places.a', issue: 'inUse' }])],
    ['no details', error(500, 'INTERNAL_ERROR')],
    ['another error', new Error('x')],
  ])('is false for %s', (_name, failure) => {
    expect(isFieldFailure(failure)).toBe(false);
  });
});

describe('countryNotice', () => {
  it('offers to reload after a stale version', () => {
    expect(countryNotice(i18n(), error(412, 'PRECONDITION_FAILED'), 'COUNTRY')).toEqual({
      kind: 'stale',
      message: 'COUNTRIES.STALE',
    });
  });

  it('says how many companies and places use the item', () => {
    const used = error(409, 'CONFLICT', [
      { field: 'companies.a', issue: 'inUse' },
      { field: 'places.b', issue: 'inUse' },
    ]);
    expect(countryNotice(i18n(), used, 'COUNTRY')).toEqual({
      kind: 'inUse',
      message:
        'COUNTRIES.IN_USE.COUNTRY {"users":"COUNTRIES.IN_USE.COMPANY {\\"count\\":1}, COUNTRIES.IN_USE.PLACE {\\"count\\":1}"}',
    });
  });

  it('names only the places when no company uses the item', () => {
    const used = error(409, 'CONFLICT', [{ field: 'places.a', issue: 'inUse' }]);
    expect(countryNotice(i18n(), used, 'COUNTRY').message).toBe(
      'COUNTRIES.IN_USE.COUNTRY {"users":"COUNTRIES.IN_USE.PLACE {\\"count\\":1}"}',
    );
  });

  it('uses the plural texts, the area text and the open count', () => {
    const companies = Array.from({ length: 20 }, (_, i) => ({
      field: `companies.${i}`,
      issue: 'inUse',
    }));
    const places = [
      { field: 'places.a', issue: 'inUse' },
      { field: 'places.b', issue: 'inUse' },
    ];
    const notice = countryNotice(i18n(), error(409, 'CONFLICT', [...companies, ...places]), 'AREA');
    expect(notice.kind).toBe('inUse');
    expect(notice.message).toContain('COUNTRIES.IN_USE.AREA');
    expect(notice.message).toContain('COUNTRIES.IN_USE.COMPANIES {\\"count\\":\\"20+\\"}');
    expect(notice.message).toContain('COUNTRIES.IN_USE.PLACES {\\"count\\":\\"2+\\"}');
  });

  it('reports an error that is not an API error generically, and logs it', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(countryNotice(i18n(), new Error('boom'), 'COUNTRY')).toEqual({
      kind: 'error',
      message: 'ERRORS.GENERIC.MESSAGE',
    });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('uses the central mapping for anything else', () => {
    const notice = countryNotice(i18n(), error(500, 'INTERNAL_ERROR'), 'AREA');
    expect(notice.kind).toBe('error');
    expect(notice.message).toBe('ERRORS.API.INTERNAL_ERROR');
  });
});
