import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, DEFAULT_MESSAGES, ERROR_STATUS } from '../../src/shared/http/errors.ts';
import type { ErrorCode } from '../../src/shared/http/errors.ts';
import { sendData, sendPage } from '../../src/shared/http/envelope.ts';

describe('AppError', () => {
  it('derives status and default message from the code', () => {
    for (const code of Object.keys(ERROR_STATUS) as ErrorCode[]) {
      const error = new AppError(code);
      assert.equal(error.status, ERROR_STATUS[code]);
      assert.equal(error.message, DEFAULT_MESSAGES[code]);
      assert.equal(error.code, code);
      assert.equal(error.name, 'AppError');
      assert.equal(error.details, undefined);
      assert.deepEqual(error.headers, {});
    }
    assert.equal(ERROR_STATUS.SERVICE_UNAVAILABLE, 503);
  });

  it('accepts a message, details and headers', () => {
    const error = new AppError('VALIDATION_ERROR', {
      message: 'Bad',
      details: [{ field: 'price', issue: 'minimum' }],
      headers: { 'Retry-After': '3' },
    });
    assert.equal(error.message, 'Bad');
    assert.deepEqual(error.details, [{ field: 'price', issue: 'minimum' }]);
    assert.deepEqual(error.headers, { 'Retry-After': '3' });
  });
});

describe('envelope', () => {
  function fakeResponse(): { res: never; calls: { status?: number; body?: unknown } } {
    const calls: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        calls.status = code;
        return this;
      },
      json(body: unknown) {
        calls.body = body;
      },
    };
    return { res: res as never, calls };
  }

  it('sendData wraps in { data } with status 200 by default', () => {
    const { res, calls } = fakeResponse();
    sendData(res, { id: '1' });
    assert.equal(calls.status, 200);
    assert.deepEqual(calls.body, { data: { id: '1' } });
  });

  it('sendData accepts a custom status', () => {
    const { res, calls } = fakeResponse();
    sendData(res, { id: '1' }, 201);
    assert.equal(calls.status, 201);
  });

  it('sendPage wraps in { data, page }', () => {
    const { res, calls } = fakeResponse();
    sendPage(res, [1, 2], { limit: 50, next: null });
    assert.equal(calls.status, 200);
    assert.deepEqual(calls.body, { data: [1, 2], page: { limit: 50, next: null } });
  });
});
