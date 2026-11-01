import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../../src/shared/http/error-handler.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { memoryLogger } from '../helpers/app.ts';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  destroyed: boolean;
}

function invoke(error: unknown, headersSent = false): { captured: Captured; events: Array<Record<string, unknown>> } {
  const { logger, events } = memoryLogger();
  const captured: Captured = { headers: {}, destroyed: false };
  const res = {
    locals: { requestId: 'req-12345678' },
    headersSent,
    set(headers: Record<string, string>) {
      Object.assign(captured.headers, headers);
      return this;
    },
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
    },
  };
  const req = { socket: { destroy: () => (captured.destroyed = true) } };
  errorHandler(logger)(error, req as never, res as never, () => undefined);
  return { captured, events };
}

describe('errorHandler', () => {
  it('renders an AppError without logging', () => {
    const { captured, events } = invoke(
      new AppError('VALIDATION_ERROR', { details: [{ field: 'a', issue: 'required' }], headers: { 'Retry-After': '1' } }),
    );
    assert.equal(captured.status, 422);
    assert.deepEqual(captured.body, {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: [{ field: 'a', issue: 'required' }] },
    });
    assert.equal(captured.headers['Retry-After'], '1');
    assert.equal(events.length, 0);
  });

  it('maps every body-parser error type', () => {
    const expected: Record<string, [number, string]> = {
      'entity.parse.failed': [400, 'MALFORMED_JSON'],
      'entity.too.large': [413, 'PAYLOAD_TOO_LARGE'],
      'charset.unsupported': [415, 'UNSUPPORTED_MEDIA_TYPE'],
      'encoding.unsupported': [415, 'UNSUPPORTED_MEDIA_TYPE'],
      'request.size.invalid': [400, 'BAD_REQUEST'],
    };
    for (const [type, [status, code]] of Object.entries(expected)) {
      const { captured } = invoke(Object.assign(new Error('internal detail'), { type }));
      assert.equal(captured.status, status);
      assert.equal((captured.body?.['error'] as Record<string, unknown>)['code'], code);
    }
  });

  it('answers 500 without leaking and logs the stack with the request id', () => {
    for (const error of [new Error('secret internal detail'), Object.assign(new Error('x'), { type: 'other' }), 'text', null, undefined]) {
      const { captured, events } = invoke(error);
      assert.equal(captured.status, 500);
      assert.deepEqual(captured.body, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      assert.equal(events[0]?.['level'], 'error');
      assert.equal(events[0]?.['requestId'], 'req-12345678');
    }
    const { events } = invoke(new Error('boom'));
    assert.match(String((events[0]?.['error'] as Record<string, unknown>)['stack']), /boom/);
  });

  it('logs and destroys the socket when headers were already sent', () => {
    const { captured, events } = invoke(new Error('late'), true);
    assert.equal(captured.destroyed, true);
    assert.equal(captured.status, undefined);
    assert.equal(events[0]?.['msg'], 'error after response started');
  });

  it('maps URIError and exposable 4xx errors without an error log', () => {
    const cases: Array<[unknown, number, string]> = [
      [new URIError('bad'), 400, 'BAD_REQUEST'],
      [Object.assign(new Error('x'), { status: 400, expose: true }), 400, 'BAD_REQUEST'],
      [Object.assign(new Error('x'), { status: 413, expose: true }), 413, 'PAYLOAD_TOO_LARGE'],
      [Object.assign(new Error('x'), { status: 415, expose: true }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ];
    for (const [error, status, code] of cases) {
      const { captured, events } = invoke(error);
      assert.equal(captured.status, status);
      assert.equal((captured.body?.['error'] as Record<string, unknown>)['code'], code);
      assert.equal(events.length, 0);
    }
  });

  it('maps other exposable 4xx errors to INTERNAL_ERROR with a warning, and ignores non-exposable ones', () => {
    const { captured, events } = invoke(Object.assign(new Error('x'), { status: 418, expose: true }));
    assert.equal(captured.status, 500);
    assert.equal(events[0]?.['level'], 'warn');
    for (const error of [{ status: 400, expose: false }, { status: 500, expose: true }, { status: 399, expose: true }]) {
      assert.equal(invoke(Object.assign(new Error('x'), error)).captured.status, 500);
    }
  });

  it('only logs an aborted request and closes the socket', () => {
    const { captured, events } = invoke(Object.assign(new Error('aborted'), { type: 'request.aborted' }));
    assert.equal(captured.status, undefined);
    assert.equal(captured.destroyed, true);
    assert.equal(events[0]?.['level'], 'debug');
  });

  it('falls back to a hand-written 500 when rendering fails', () => {
    const { logger, events } = memoryLogger();
    const written: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
    const res = {
      locals: { requestId: 'req-12345678' },
      headersSent: false,
      set() {
        throw new TypeError('Invalid character in header content');
      },
      setHeader(name: string, value: string) {
        written.headers[name] = value;
      },
      end(body: string) {
        written.body = body;
      },
      set statusCode(code: number) {
        written.status = code;
      },
    };
    errorHandler(logger)(new AppError('RATE_LIMITED', { headers: { 'Retry-After': '1\n2' } }), {} as never, res as never, () => undefined);
    assert.equal(written.status, 500);
    assert.equal(written.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(written.body ?? ''), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    assert.equal(events[0]?.['msg'], 'error handler failed');
  });

  it('destroys the socket when rendering fails after headers were sent', () => {
    const { logger } = memoryLogger();
    let destroyed = false;
    const res = { locals: {}, headersSent: false };
    Object.defineProperty(res, 'headersSent', { get: (() => { let n = 0; return () => n++ > 0; })() });
    const req = { socket: { destroy: () => (destroyed = true) } };
    errorHandler(logger)(new AppError('NOT_FOUND'), req as never, Object.assign(res, { set() { throw new Error('x'); } }) as never, () => undefined);
    assert.equal(destroyed, true);
  });
});
