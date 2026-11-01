import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  ApiError,
  apiErrorMessageKey,
  fieldErrors,
  parseApiErrorBody,
  toApiError,
} from './api-error';

function failure(status: number, error: unknown, requestId?: string): HttpErrorResponse {
  const headers =
    requestId === undefined ? new HttpHeaders() : new HttpHeaders({ 'X-Request-Id': requestId });
  return new HttpErrorResponse({ status, error, headers });
}

describe('toApiError', () => {
  it('maps a conforming error body with the request id', () => {
    const error = toApiError(
      failure(404, { error: { code: 'NOT_FOUND', message: 'Nope' } }, 'req-1'),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Nope');
    expect(error.details).toEqual([]);
    expect(error.requestId).toBe('req-1');
  });

  it('keeps the field details of a validation error', () => {
    const error = toApiError(
      failure(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid',
          details: [{ field: 'email', issue: 'required' }],
        },
      }),
    );
    expect(error.details).toEqual([{ field: 'email', issue: 'required' }]);
    expect(error.requestId).toBeNull();
  });

  it('maps status 0 to a client NETWORK_ERROR', () => {
    const error = toApiError(failure(0, new ProgressEvent('error'), 'req-2'));
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
    expect(error.requestId).toBe('req-2');
  });

  it('maps a non-conforming body to UNKNOWN_ERROR without exposing it', () => {
    const error = toApiError(failure(502, '<html>secret internals</html>'));
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.status).toBe(502);
    expect(error.message).not.toContain('secret');
  });
});

describe('parseApiErrorBody', () => {
  const invalid: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['a missing error', {}],
    ['a non-object error', { error: 'x' }],
    ['an unknown code', { error: { code: 'WHATEVER', message: 'm' } }],
    ['a non-string code', { error: { code: 1, message: 'm' } }],
    ['a non-string message', { error: { code: 'NOT_FOUND', message: 1 } }],
    ['non-array details', { error: { code: 'NOT_FOUND', message: 'm', details: 'x' } }],
    ['a non-object detail', { error: { code: 'NOT_FOUND', message: 'm', details: ['x'] } }],
    [
      'a detail without issue',
      { error: { code: 'NOT_FOUND', message: 'm', details: [{ field: 'a' }] } },
    ],
    [
      'a detail without field',
      { error: { code: 'NOT_FOUND', message: 'm', details: [{ issue: 'a' }] } },
    ],
  ];

  it.each(invalid)('rejects %s', (_label, body) => {
    expect(parseApiErrorBody(body)).toBeNull();
  });

  it('accepts a body without details', () => {
    expect(parseApiErrorBody({ error: { code: 'CONFLICT', message: 'm' } })).toEqual({
      code: 'CONFLICT',
      message: 'm',
      details: [],
    });
  });
});

describe('fieldErrors', () => {
  it('keeps the first issue of each field', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'm',
      details: [
        { field: 'name', issue: 'required' },
        { field: 'name', issue: 'too_long' },
        { field: 'email', issue: 'invalid' },
      ],
    });
    expect(fieldErrors(error)).toEqual({ name: 'required', email: 'invalid' });
  });

  it('is empty without details', () => {
    expect(
      fieldErrors(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'm' })),
    ).toEqual({});
  });
});

describe('apiErrorMessageKey', () => {
  it('builds the dictionary key from the code', () => {
    const error = new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'm' });
    expect(apiErrorMessageKey(error)).toBe('ERRORS.API.NETWORK_ERROR');
  });
});
