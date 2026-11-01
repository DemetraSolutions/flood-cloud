import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Duplex } from 'node:stream';
import { handleClientError } from '../../src/shared/http/client-error.ts';
import { SECURITY_HEADERS } from '../../src/shared/http/security-headers.ts';

function fakeSocket(writable: boolean) {
  const state = { written: '', destroyed: 0 };
  const socket = {
    writable,
    end(data: string, callback: () => void) {
      state.written = data;
      callback();
    },
    destroy() {
      state.destroyed++;
    },
  };
  return { socket: socket as unknown as Duplex, state };
}

describe('handleClientError', () => {
  it('answers 400 by default with envelope and security headers, then destroys', () => {
    const { socket, state } = fakeSocket(true);
    handleClientError(Object.assign(new Error('parse'), { code: 'HPE_INVALID_METHOD' }), socket);
    assert.match(state.written, /^HTTP\/1\.1 400 Bad Request\r\n/);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.ok(state.written.includes(`${name}: ${value}\r\n`), name);
    }
    assert.ok(state.written.includes('Content-Type: application/json; charset=utf-8\r\n'));
    assert.ok(state.written.includes('Connection: close\r\n'));
    const body = state.written.split('\r\n\r\n')[1] ?? '';
    assert.deepEqual(JSON.parse(body), { error: { code: 'BAD_REQUEST', message: 'Bad request' } });
    assert.ok(state.written.includes(`Content-Length: ${Buffer.byteLength(body)}\r\n`));
    assert.equal(state.destroyed, 1);
  });

  it('uses 400 when the error has no code', () => {
    const { socket, state } = fakeSocket(true);
    handleClientError(new Error('x'), socket);
    assert.match(state.written, /^HTTP\/1\.1 400 /);
  });

  it('answers 408 for a request timeout and 431 for header overflow', () => {
    const timeout = fakeSocket(true);
    handleClientError(Object.assign(new Error('t'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), timeout.socket);
    assert.match(timeout.state.written, /^HTTP\/1\.1 408 Request Timeout\r\n/);
    const overflow = fakeSocket(true);
    handleClientError(Object.assign(new Error('h'), { code: 'HPE_HEADER_OVERFLOW' }), overflow.socket);
    assert.match(overflow.state.written, /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/);
  });

  it('only destroys on ECONNRESET or when the socket is not writable', () => {
    const reset = fakeSocket(true);
    handleClientError(Object.assign(new Error('r'), { code: 'ECONNRESET' }), reset.socket);
    assert.equal(reset.state.written, '');
    assert.equal(reset.state.destroyed, 1);
    const closed = fakeSocket(false);
    handleClientError(new Error('x'), closed.socket);
    assert.equal(closed.state.written, '');
    assert.equal(closed.state.destroyed, 1);
  });
});
