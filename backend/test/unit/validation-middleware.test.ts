import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { errorHandler } from '../../src/shared/http/error-handler.ts';
import { inputOf, validateBody, validateParams, validateQuery } from '../../src/shared/validation/middleware.ts';
import { integer, objectId, object, optional, string } from '../../src/shared/validation/schema.ts';
import type { Infer } from '../../src/shared/validation/schema.ts';
import { recordingErrorReporter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';

const body = object({ name: string({ min: 1, max: 5, trim: true }), age: optional(integer({ min: 0 })) });
const params = object({ id: objectId() });
const query = object({ q: optional(string({ max: 5 })) });

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.post('/no-parser', validateBody(body), (_req, res) => void res.json({ ok: true }));
  app.use(express.json());
  app.post('/things/:id', validateParams(params), validateQuery(query), validateBody(body), (_req, res) => {
    const input = {
      body: inputOf<Infer<typeof body>>(res, 'body'),
      query: inputOf<Infer<typeof query>>(res, 'query'),
      id: inputOf<Infer<typeof params>>(res, 'params').id.toHexString(),
    };
    res.json(input);
  });
  app.get('/unvalidated', (_req, res) => void res.json(inputOf(res, 'body')));
  app.use(errorHandler(memoryLogger().logger, recordingErrorReporter().reporter));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ID = 'aabbccddeeff001122334455';
const post = (path: string, payload?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });

describe('validateBody, validateQuery, validateParams', () => {
  it('puts the converted parts in res.locals.input', async () => {
    const response = await post(`/things/${ID}?q=ab`, { name: '  Ann ' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { body: { name: 'Ann' }, query: { q: 'ab' }, id: ID });
  });

  it('answers 422 with the problems of every part, never the values', async () => {
    const bad = await post('/things/zz?x=1', { name: 5, $where: 'sentinel-secret' });
    assert.equal(bad.status, 422);
    const text = await bad.text();
    assert.equal(text.includes('sentinel-secret'), false);
    const { error } = JSON.parse(text) as { error: { code: string; details: unknown[] } };
    assert.equal(error.code, 'VALIDATION_ERROR');
    // The first failing part stops the chain: params come first.
    assert.deepEqual(error.details, [{ field: 'id', issue: 'format' }]);
    assert.deepEqual(((await (await post(`/things/${ID}?x=1`, { name: 'a' })).json()) as { error: { details: unknown[] } }).error.details, [{ field: 'x', issue: 'unknown' }]);
    assert.deepEqual(((await (await post(`/things/${ID}`, { name: 5, $where: 1 })).json()) as { error: { details: unknown[] } }).error.details, [
      { field: '(key)', issue: 'forbiddenKey' },
      { field: 'name', issue: 'type' },
    ]);
  });

  it('answers 422 (body) required when no parser produced a body', async () => {
    const response = await post('/no-parser');
    assert.equal(response.status, 422);
    assert.deepEqual(((await response.json()) as { error: { details: unknown[] } }).error.details, [{ field: '(body)', issue: 'required' }]);
  });

  it('treats an empty or non-object JSON body as a body that fails its schema', async () => {
    const empty = await post(`/things/${ID}`);
    assert.deepEqual(((await empty.json()) as { error: { details: unknown[] } }).error.details, [{ field: 'name', issue: 'required' }]);
    const response = await post(`/things/${ID}`, []);
    assert.deepEqual(((await response.json()) as { error: { details: unknown[] } }).error.details, [{ field: '(body)', issue: 'type' }]);
  });

  it('inputOf fails loudly when the route validated nothing', async () => {
    const response = await fetch(`${base}/unvalidated`);
    assert.equal(response.status, 500);
  });
});
