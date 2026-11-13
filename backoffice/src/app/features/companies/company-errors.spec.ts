import { signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { companyActionMessage, hasFieldDetails, isStale, resolveField } from './company-errors';

function apiError(
  status: number,
  code: ApiError['code'],
  details: { field: string; issue: string }[] = [],
) {
  return new ApiError({ status, code, message: code, details });
}

describe('resolveField', () => {
  it('finds the field, or the closest parent that exists', () => {
    const root = TestBed.runInInjectionContext(() =>
      form(signal({ a: { b: { c: 'x' } }, list: [{ n: 'y' }] })),
    );
    expect(resolveField(root, 'a.b.c')).toBe(root.a.b.c);
    expect(resolveField(root, 'a.b.missing')).toBe(root.a.b);
    expect(resolveField(root, 'list.0.n')).toBe(root.list[0].n);
    expect(resolveField(root, 'missing')).toBeUndefined();
    expect(resolveField(root, 'missing.deeper')).toBeUndefined();
  });
});

describe('failure classification', () => {
  it('knows the failures that carry fields', () => {
    const detail = [{ field: 'a', issue: 'b' }];
    expect(hasFieldDetails(apiError(422, 'VALIDATION_ERROR', detail))).toBe(true);
    expect(hasFieldDetails(apiError(409, 'CONFLICT', detail))).toBe(true);
    expect(hasFieldDetails(apiError(403, 'FORBIDDEN', detail))).toBe(true);
    expect(hasFieldDetails(apiError(422, 'VALIDATION_ERROR'))).toBe(false);
    expect(hasFieldDetails(apiError(500, 'INTERNAL_ERROR', detail))).toBe(false);
    expect(hasFieldDetails(new Error('x'))).toBe(false);
  });

  it('knows a stale version', () => {
    expect(isStale(apiError(412, 'PRECONDITION_FAILED'))).toBe(true);
    expect(isStale(apiError(409, 'CONFLICT'))).toBe(false);
    expect(isStale('x')).toBe(false);
  });
});

describe('companyActionMessage', () => {
  const i18n = { t: (key: string) => key } as unknown as I18nService;

  it('has a text for each reason the backend gives', () => {
    expect(companyActionMessage(i18n, apiError(412, 'PRECONDITION_FAILED'))).toBe(
      'COMPANIES.CONFLICT',
    );
    expect(
      companyActionMessage(
        i18n,
        apiError(409, 'CONFLICT', [{ field: 'vatNumber', issue: 'taken' }]),
      ),
    ).toBe('COMPANIES.ACTION.ERROR_VAT_TAKEN');
    expect(
      companyActionMessage(
        i18n,
        apiError(409, 'CONFLICT', [{ field: 'places', issue: 'referenced' }]),
      ),
    ).toBe('COMPANIES.ACTION.ERROR_REFERENCED');
  });

  it('uses the central mapping for everything else', () => {
    expect(companyActionMessage(i18n, apiError(409, 'CONFLICT'))).toBe('ERRORS.API.CONFLICT');
    expect(
      companyActionMessage(i18n, apiError(409, 'CONFLICT', [{ field: 'trash', issue: 'other' }])),
    ).toBe('ERRORS.API.CONFLICT');
    expect(companyActionMessage(i18n, apiError(403, 'FORBIDDEN'))).toBe('ERRORS.API.FORBIDDEN');
  });
});
