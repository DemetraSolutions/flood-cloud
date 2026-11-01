import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, DEFAULT_PORT, loadConfig } from '../config.ts';

const ok = { API_BASE_URL: 'https://api.example.com/v1' };

test('applies defaults and derives the API origin', () => {
  const config = loadConfig(ok, '/dist');
  assert.deepEqual(config, {
    port: DEFAULT_PORT,
    staticRoot: '/dist',
    apiBaseUrl: 'https://api.example.com/v1',
    apiOrigin: 'https://api.example.com',
  });
});

test('reads PORT and STATIC_ROOT; empty values fall back to defaults', () => {
  assert.equal(loadConfig({ ...ok, PORT: '3000', STATIC_ROOT: '/srv' }, '/dist').port, 3000);
  assert.equal(loadConfig({ ...ok, PORT: '3000', STATIC_ROOT: '/srv' }, '/dist').staticRoot, '/srv');
  const empty = loadConfig({ ...ok, PORT: '', STATIC_ROOT: '' }, '/dist');
  assert.equal(empty.port, DEFAULT_PORT);
  assert.equal(empty.staticRoot, '/dist');
});

test('accepts http only for localhost and 127.0.0.1', () => {
  assert.equal(loadConfig({ API_BASE_URL: 'http://localhost:3000' }, '/d').apiOrigin, 'http://localhost:3000');
  assert.equal(loadConfig({ API_BASE_URL: 'http://127.0.0.1:3000' }, '/d').apiOrigin, 'http://127.0.0.1:3000');
});

for (const [name, env, expected] of [
  ['invalid port text', { ...ok, PORT: 'abc' }, /PORT/],
  ['port out of range', { ...ok, PORT: '70000' }, /PORT/],
  ['missing API_BASE_URL', {}, /API_BASE_URL is required/],
  ['empty API_BASE_URL', { API_BASE_URL: '' }, /API_BASE_URL is required/],
  ['relative API_BASE_URL', { API_BASE_URL: '/v1' }, /absolute/],
  ['remote http', { API_BASE_URL: 'http://api.example.com' }, /https/],
  ['other scheme', { API_BASE_URL: 'ftp://localhost' }, /https/],
  ['credentials', { API_BASE_URL: 'https://user:pass@api.example.com' }, /credentials/],
  ['username only', { API_BASE_URL: 'https://user@api.example.com' }, /credentials/],
  ['query', { API_BASE_URL: 'https://api.example.com/?a=1' }, /query/],
  ['fragment', { API_BASE_URL: 'https://api.example.com/#x' }, /fragment/],
] as const) {
  test(`rejects ${name} without echoing values`, () => {
    assert.throws(
      () => loadConfig(env, '/d'),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /pass|abc|70000/);
        return true;
      },
    );
  });
}
