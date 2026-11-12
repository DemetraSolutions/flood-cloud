import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { catalogFailureMessage, editorErrors, referencedBy } from './catalog-errors';

function fail(code: ApiError['code'], details: { field: string; issue: string }[] = []) {
  return new ApiError({ status: 409, code, message: code, details });
}

function translator(): I18nService {
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  return i18n;
}

afterEach(() => vi.restoreAllMocks());

describe('referencedBy', () => {
  it('counts the referencing elements by kind', () => {
    const error = fail('CONFLICT', [
      { field: 'cardTypes.a', issue: 'referenced' },
      { field: 'cardTypes.b', issue: 'referenced' },
      { field: 'pointsCollections.c', issue: 'referenced' },
      { field: 'name', issue: 'taken' },
    ]);
    expect([...referencedBy(error)]).toEqual([
      ['cardTypes', 2],
      ['pointsCollections', 1],
    ]);
  });
});

describe('catalogFailureMessage', () => {
  it('reports a concurrent change for a 409 without details', () => {
    expect(catalogFailureMessage(translator(), fail('CONFLICT'))).toBe('CATALOG.ERROR.CONCURRENT');
  });

  it('names who still uses a referenced element', () => {
    const error = fail('CONFLICT', [
      { field: 'cardTypes.a', issue: 'referenced' },
      { field: 'pointsCollections.b', issue: 'referenced' },
      { field: 'pointsCollections.c', issue: 'referenced' },
      { field: 'other.d', issue: 'referenced' },
    ]);
    expect(catalogFailureMessage(translator(), error)).toBe(
      'CATALOG.ERROR.REFERENCED ' +
        JSON.stringify({
          users:
            'CATALOG.REFERENCED.CARDTYPES {"count":1}, CATALOG.REFERENCED.POINTSCOLLECTIONS {"count":2}, CATALOG.REFERENCED.OTHER {"count":1}',
        }),
    );
  });

  it.each([
    ['default', 'CATALOG.ERROR.DEFAULT'],
    ['last', 'CATALOG.ERROR.LAST'],
    ['tooMany', 'CATALOG.ERROR.TOO_MANY'],
    ['taken', 'CATALOG.ERROR.TAKEN'],
    ['notAllowed', 'CATALOG.ERROR.NOT_ALLOWED'],
  ])('maps the %s rejection to its own message', (issue, key) => {
    const error = fail('VALIDATION_ERROR', [{ field: 'name', issue }]);
    expect(catalogFailureMessage(translator(), error)).toBe(key);
  });

  it('uses the message of the first detail for other issues', () => {
    const error = fail('VALIDATION_ERROR', [{ field: 'name', issue: 'required' }]);
    expect(catalogFailureMessage(translator(), error)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('uses the central mapping when there are no details and it is not a conflict', () => {
    expect(catalogFailureMessage(translator(), fail('FORBIDDEN'))).toBe('ERRORS.API.FORBIDDEN');
  });

  it('logs and reports generically an error that is not from the API', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(catalogFailureMessage(translator(), new Error('boom'))).toBe('ERRORS.GENERIC.MESSAGE');
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('editorErrors', () => {
  const known = ['name', 'enabled'];

  it('has nothing without an error', () => {
    expect(editorErrors(translator(), null, known)).toEqual({ fields: {}, form: null });
  });

  it('puts the first issue of each known field on the field', () => {
    const error = fail('VALIDATION_ERROR', [
      { field: 'name', issue: 'required' },
      { field: 'name', issue: 'maxLength' },
      { field: 'enabled', issue: 'type' },
    ]);
    expect(editorErrors(translator(), error, known)).toEqual({
      fields: { name: 'FORM.ISSUE.REQUIRED', enabled: 'FORM.ISSUE.TYPE' },
      form: null,
    });
  });

  it('keeps a message for the form when a detail has no field', () => {
    const error = fail('VALIDATION_ERROR', [
      { field: 'name', issue: 'required' },
      { field: 'other', issue: 'taken' },
    ]);
    expect(editorErrors(translator(), error, known)).toEqual({
      fields: { name: 'FORM.ISSUE.REQUIRED' },
      form: 'CATALOG.ERROR.TAKEN',
    });
  });

  it('shows an error without details on the form', () => {
    expect(editorErrors(translator(), fail('CONFLICT'), known)).toEqual({
      fields: {},
      form: 'CATALOG.ERROR.CONCURRENT',
    });
  });
});
