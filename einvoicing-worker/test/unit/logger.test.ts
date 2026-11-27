import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogLevel } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { Secret } from '../../src/secret.ts';

function capture(level: LogLevel = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
  return { lines, logger };
}

describe('logger', () => {
  it('writes JSON lines with time, level, message and the fields', () => {
    const { lines, logger } = capture();
    logger.debug('d');
    logger.info('i', { a: 1 });
    logger.warn('w');
    logger.error('e', { b: [1, { c: 2 }] });
    assert.deepEqual(
      lines.map((l) => [l['level'], l['message']]),
      [['debug', 'd'], ['info', 'i'], ['warn', 'w'], ['error', 'e']],
    );
    assert.equal(lines[1]?.['time'], '2026-01-02T03:04:05.000Z');
    assert.equal(lines[1]?.['a'], 1);
    assert.deepEqual(lines[3]?.['b'], [1, { c: 2 }]);
  });

  it('drops the levels below the threshold', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    assert.deepEqual(lines.map((l) => l['message']), ['w', 'e']);
  });

  it('redacts secret-looking keys at any depth and Secret values', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      MONGODB_URI: 'mongodb://u:p@h',
      nested: { apiKey: 'k', Authorization: 'Bearer z', fine: 'ok', list: [{ password: 'p' }] },
      wrapped: new Secret('hidden'),
    });
    const text = JSON.stringify(lines[0]);
    assert.doesNotMatch(text, /mongodb:|Bearer|"k"|"p"|hidden/);
    assert.equal((lines[0]?.['nested'] as { fine: string }).fine, 'ok');
    assert.equal(lines[0]?.['wrapped'], '[REDACTED]');
  });

  it('keeps only name, code and message of an error', () => {
    const { lines, logger } = capture();
    const withString = Object.assign(new Error('boom'), { code: 'E_X', stack: 'secret stack' });
    const withNumber = Object.assign(new TypeError('bang'), { code: 11000 });
    logger.error('e', { error: withString, other: withNumber, plain: new Error('none') });
    assert.deepEqual(lines[0]?.['error'], { name: 'Error', code: 'E_X', message: 'boom' });
    assert.deepEqual(lines[0]?.['other'], { name: 'TypeError', code: 11000, message: 'bang' });
    assert.deepEqual(lines[0]?.['plain'], { name: 'Error', message: 'none' });
    assert.doesNotMatch(JSON.stringify(lines[0]), /secret stack/);
  });

  it('serializes bigint, null and truncates deep nesting', () => {
    const { lines, logger } = capture();
    logger.info('x', { big: 10n, nothing: null, deep: { a: { b: { c: { d: { e: 1 } } } } } });
    assert.equal(lines[0]?.['big'], '10');
    assert.equal(lines[0]?.['nothing'], null);
    assert.equal(JSON.stringify(lines[0]?.['deep']).includes('[truncated]'), true);
  });
});
