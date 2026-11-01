import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact } from '../../src/shared/logging/logger.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { memoryLogger } from '../helpers/app.ts';

/** Round-trips through JSON so prototype-less results compare with plain literals. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('logger', () => {
  it('writes one JSON line with time, level, msg and fields', () => {
    const { logger, events, lines } = memoryLogger();
    logger.debug('d', { a: 1 });
    logger.info('i');
    logger.warn('w');
    logger.error('e', { b: [1, 2] });
    assert.equal(lines.length, 4);
    assert.deepEqual(events.map((event) => event['level']), ['debug', 'info', 'warn', 'error']);
    assert.deepEqual(events.map((event) => event['msg']), ['d', 'i', 'w', 'e']);
    assert.match(String(events[0]?.['time']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(events[0]?.['a'], 1);
    assert.deepEqual(events[3]?.['b'], [1, 2]);
  });

  it('does not let fields override the reserved keys', () => {
    const { logger, events } = memoryLogger();
    logger.info('real', { msg: 'fake', level: 'fake', time: 'fake' });
    assert.equal(events[0]?.['msg'], 'real');
    assert.equal(events[0]?.['level'], 'info');
    assert.notEqual(events[0]?.['time'], 'fake');
  });

  it('redacts sensitive keys case-insensitively and deeply', () => {
    const { logger, events } = memoryLogger();
    logger.info('x', {
      Authorization: 'Bearer abc',
      headers: { 'X-Api-Key': 'k', 'Set-Cookie': 'c', cookie: 'c' },
      user: { Email: 'a@b.c', name: 'N', surname: 'S', firstName: 'F', lastName: 'L', fiscalCode: 'X', phone: '1', telephone: '2' },
      list: [{ password: 'p', pin: '1', ok: 'visible' }],
      auth: { token: 't', accessToken: 'a', refreshToken: 'r', apiKey: 'k', secret: 's', pepper: 'p', mongodbUri: 'u' },
    });
    const text = JSON.stringify(events[0]);
    for (const leaked of ['Bearer abc', 'a@b.c']) {
      assert.ok(!text.includes(leaked), leaked);
    }
    const event = events[0] as Record<string, Record<string, unknown>>;
    assert.equal(events[0]?.['Authorization'], '[REDACTED]');
    assert.deepEqual(event['headers'], { 'X-Api-Key': '[REDACTED]', 'Set-Cookie': '[REDACTED]', cookie: '[REDACTED]' });
    assert.ok(Object.values(event['user'] ?? {}).every((value) => value === '[REDACTED]'));
    assert.deepEqual(event['list'], [{ password: '[REDACTED]', pin: '[REDACTED]', ok: 'visible' }]);
    assert.ok(Object.values(event['auth'] ?? {}).every((value) => value === '[REDACTED]'));
  });

  it('redacts string values that look like credentials', () => {
    const value = redact({
      a: 'x fc_at_abc y',
      b: 'fc_rt_abc',
      c: 'fc_pk_abc',
      d: 'mongodb://u:p@h/db',
      e: ['mongodb+srv://h'],
      safe: 'plain text',
    });
    assert.deepEqual(plain(value), { a: '[REDACTED]', b: '[REDACTED]', c: '[REDACTED]', d: '[REDACTED]', e: ['[REDACTED]'], safe: 'plain text' });
  });

  it('redacts Secret instances', () => {
    assert.deepEqual(plain(redact({ anything: new Secret('s') })), { anything: '[REDACTED]' });
  });

  it('serializes errors as name, message and stack, redacting their text', () => {
    const error = new TypeError('boom mongodb://u:p@h/db');
    const value = redact(error) as Record<string, string>;
    assert.equal(value['name'], 'TypeError');
    assert.equal(value['message'], '[REDACTED]');
    assert.equal(value['stack'], '[REDACTED]');
    const plain = redact({ error: new Error('plain') }) as { error: Record<string, string> };
    assert.equal(plain.error['message'], 'plain');
    assert.match(plain.error['stack'] ?? '', /Error: plain/);
    const noStack = new Error('no stack');
    delete noStack.stack;
    assert.equal((redact(noStack) as Record<string, unknown>)['stack'], undefined);
  });

  it('survives circular references but keeps shared references', () => {
    const a: Record<string, unknown> = { id: 1 };
    a['self'] = a;
    const shared = { v: 1 };
    const result = redact({ a, first: shared, second: shared }) as Record<string, unknown>;
    assert.deepEqual(plain(result['a']), { id: 1, self: '[Circular]' });
    assert.deepEqual(plain(result['first']), { v: 1 });
    assert.deepEqual(plain(result['second']), { v: 1 });
    const arr: unknown[] = [];
    arr.push(arr);
    assert.deepEqual(redact(arr), ['[Circular]']);
  });

  it('keeps JSON-safe primitives and converts dates and bigints', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    assert.deepEqual(plain(redact({ n: 1, b: true, z: null, d: date, big: 10n, u: undefined })), {
      n: 1,
      b: true,
      z: null,
      d: '2026-01-01T00:00:00.000Z',
      big: '10',
    });
  });

  it('never throws on serialization of exotic values', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info('x', { fn: () => 1, sym: Symbol('s'), big: 1n });
    assert.equal(lines.length, 1);
  });

  it('redacts by normalized key and substring', () => {
    const value = plain(
      redact({
        newPassword: 'a',
        passwordHash: 'a',
        access_token: 'a',
        refresh_token: 'a',
        api_key: 'a',
        clientSecret: 'a',
        privateKey: 'a',
        'X-Passcode': 'a',
        dbCredentials: 'a',
        Signature: 'a',
        harmless: 'visible',
      }),
    ) as Record<string, string>;
    for (const [key, v] of Object.entries(value)) {
      assert.equal(v, key === 'harmless' ? 'visible' : '[REDACTED]', key);
    }
  });

  it('redacts the value that follows a sensitive name in rawHeaders', () => {
    const value = plain(
      redact({ rawHeaders: ['Host', 'x.example', 'Cookie', 'sid=1', 'Authorization', 'Bearer z', 'Accept', '*/*', 5, 'v'], other: { RawHeaders: ['X-Api-Key', 'k'] } }),
    ) as { rawHeaders: unknown[]; other: { RawHeaders: unknown[] } };
    assert.deepEqual(value.rawHeaders, ['Host', 'x.example', 'Cookie', '[REDACTED]', 'Authorization', '[REDACTED]', 'Accept', '*/*', 5, 'v']);
    assert.deepEqual(value.other.RawHeaders, ['X-Api-Key', '[REDACTED]']);
  });

  it('reduces MongoDB errors to name, code and codeName', () => {
    class MongoServerError extends Error {
      override name = 'MongoServerError';
      code = 11000;
      codeName = 'DuplicateKey';
    }
    const value = redact(new MongoServerError('E11000 duplicate key error dup key: { email: "a@b.c" }')) as Record<string, unknown>;
    assert.deepEqual(plain(value), { name: 'MongoServerError', code: 11000, codeName: 'DuplicateKey' });
  });

  it('redacts duplicate key details in any string', () => {
    const value = redact({ message: 'E11000 dup key: { email: "a@b.c" } end', e: new Error('x dup key: { a: 1 }') }) as Record<string, unknown>;
    assert.equal(value['message'], 'E11000 dup key: [REDACTED] end');
    assert.match(String((value['e'] as Record<string, unknown>)['message']), /dup key: \[REDACTED\]/);
  });

  it('keeps a __proto__ key as a plain logged field', () => {
    const { logger, lines } = memoryLogger();
    logger.info('x', JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>);
    assert.match(lines[0] ?? '', /"__proto__":\{"polluted":true\}/);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('redacts the message', () => {
    const { events, logger } = memoryLogger();
    logger.info('connect to mongodb://u:p@h/db');
    assert.equal(events[0]?.['msg'], '[REDACTED]');
  });

  it('truncates deep structures', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 15; i++) {
      deep = { next: deep };
    }
    assert.match(JSON.stringify(redact(deep)), /\[Truncated\]/);
    assert.ok(!JSON.stringify(redact(deep)).includes('leaf'));
  });

  it('survives a throwing getter', () => {
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
      ok: 1,
    };
    assert.deepEqual(plain(redact(hostile)), { boom: '[Unreadable]', ok: 1 });
  });
});
