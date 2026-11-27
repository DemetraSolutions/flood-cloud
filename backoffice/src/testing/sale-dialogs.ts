import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { errorBody } from './api';

/** One way a write of a sale can fail, and what every dialog of a write shows for it. */
export interface SaleFailureCase {
  readonly name: string;
  /** Answers the request. */
  readonly answer: (request: TestRequest) => void;
  /** The message of the dialog (`null`: only contains `contains`). */
  readonly message: string | null;
  readonly contains?: string;
  /** The dialog asks the page to read the sale again. */
  readonly reread: boolean;
}

function fail(code: string, status: number, details?: { field: string; issue: string }[], headers?: Record<string, string>) {
  return (request: TestRequest) =>
    request.flush(errorBody(code, details), { status, statusText: code, headers });
}

/** The failures every write of a sale has the same answer to (the `403` is apart: it depends on the write). */
export const SALE_FAILURES: readonly SaleFailureCase[] = [
  {
    name: '409 with a detail the interface knows',
    answer: fail('CONFLICT', 409, [{ field: 'canceled', issue: 'canceled' }]),
    message: 'SALES.ACTION.CONFLICT.CANCELED',
    reread: true,
  },
  {
    name: '409 with a detail it does not know',
    answer: fail('CONFLICT', 409, [{ field: 'x', issue: 'y' }]),
    message: 'SALES.ACTION.CONFLICT.GENERIC',
    reread: true,
  },
  {
    name: '412',
    answer: fail('PRECONDITION_FAILED', 412),
    message: 'SALES.ACTION.STALE',
    reread: true,
  },
  {
    name: '429 with Retry-After',
    answer: fail('RATE_LIMITED', 429, undefined, { 'Retry-After': '30' }),
    message: null,
    contains: 'ERRORS.API.RATE_LIMITED_WAIT',
    reread: false,
  },
  {
    name: '404',
    answer: fail('NOT_FOUND', 404),
    message: 'ERRORS.API.NOT_FOUND',
    reread: false,
  },
  {
    name: 'no answer',
    answer: (request) => request.error(new ProgressEvent('error')),
    message: 'SALES.ACTION.UNCERTAIN',
    reread: true,
  },
  {
    name: '500',
    answer: fail('INTERNAL_ERROR', 500),
    message: 'SALES.ACTION.UNCERTAIN',
    reread: true,
  },
];

/** The request to a URL, whatever its query. */
export function requestTo(backend: HttpTestingController, url: string): TestRequest {
  return backend.expectOne((request) => request.url === url);
}

/** Answers a request with a `403`. */
export const forbidden = fail('FORBIDDEN', 403);

/** Answers a request with a `422` that names fields. */
export function invalid(details: { field: string; issue: string }[]) {
  return fail('VALIDATION_ERROR', 422, details);
}
