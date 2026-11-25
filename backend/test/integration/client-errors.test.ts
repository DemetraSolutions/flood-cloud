import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { createActivityLog } from '../../src/shared/activity-log/activity-log.ts';
import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';
import { addUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { memoryLogger } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors, send } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const g0 = () => office.cluster.groups[0]!;
const hex = (id: ObjectId) => id.toHexString();
const report = { name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at a (app.js:1:1)', route: '/groups/:groupId/users', appVersion: '1.2.3' };
const reports = (): ActivityEntry[] => office.activity.entries.filter((entry) => entry.action === 'client.error');
const last = (): ActivityEntry => reports().at(-1)!;

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx, { env: { RATE_LIMIT_CLIENT_ERRORS_PER_USER: '100' } });
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('POST /v1/client-errors', () => {
  it('accepts a report from every role with 202 and no body, attributed to the reporter', async () => {
    const reporters: Array<[string, ObjectId, ObjectId | undefined]> = [
      ['PSA', office.cluster.psa, undefined],
      ['D', office.cluster.dealerA, undefined],
      ['SA', g0().sa, g0().groupId],
      ['CA', g0().ca, g0().groupId],
      ['PA', g0().pa, g0().groupId],
    ];
    for (const [role, user, groupId] of reporters) {
      const count = reports().length;
      const reply = await as.call(user, 'POST', '/client-errors', { ...report, occurredAt: '2026-11-05T10:00:00.000Z' });
      assert.deepEqual([reply.status, reply.body], [202, undefined], role);
      assert.equal(reply.headers.get('content-length') ?? '0', '0');
      assert.equal(reports().length, count + 1);
      const entry = last();
      assert.deepEqual([entry.category, entry.action, entry.outcome], ['error', 'client.error', 'failure']);
      assert.deepEqual(entry.actor, { kind: 'user', id: user, role });
      assert.equal(entry.groupId?.toHexString(), groupId?.toHexString());
      assert.equal(entry.requestId, reply.headers.get('x-request-id'));
      assert.equal(typeof entry.ip, 'string');
      assert.deepEqual(entry.metadata, { route: report.route, appVersion: report.appVersion, ...(entry.metadata?.['userAgent'] === undefined ? {} : { userAgent: entry.metadata['userAgent'] }) });
      assert.deepEqual(entry.error, { name: report.name, message: report.message, stack: report.stack });
    }
  });

  it('keeps the user agent abbreviated to 120 characters and accepts an empty message and no stack', async () => {
    const reply = await office.call('POST', '/client-errors', (await office.tokens('user-001')).accessToken, { name: 'E', message: '', route: '/', appVersion: '1' }, { 'user-agent': 'U'.repeat(200) });
    assert.equal(reply.status, 202);
    assert.equal((last().metadata?.['userAgent'] as string).length, 120);
    assert.deepEqual(last().error, { name: 'E', message: '' });
  });

  it('is refused to anonymous callers', async () => {
    const anonymous = await send(office, 'POST', '/client-errors', undefined, report);
    assert.equal(anonymous.status, 401);
  });

  it('validates the body by allowlist', async () => {
    const issues = async (body: unknown) => {
      const reply = await as.call(g0().sa, 'POST', '/client-errors', body);
      return [reply.status, reply.body.error.code, reply.body.error.details];
    };
    const count = reports().length;
    assert.deepEqual(await issues({ ...report, extra: 1 }), [422, 'VALIDATION_ERROR', [{ field: 'extra', issue: 'unknown' }]]);
    assert.deepEqual(await issues({ ...report, name: '' }), [422, 'VALIDATION_ERROR', [{ field: 'name', issue: 'minLength' }]]);
    assert.deepEqual(await issues({ ...report, name: 'n'.repeat(101) }), [422, 'VALIDATION_ERROR', [{ field: 'name', issue: 'maxLength' }]]);
    assert.deepEqual(await issues({ ...report, message: 'm'.repeat(301) }), [422, 'VALIDATION_ERROR', [{ field: 'message', issue: 'maxLength' }]]);
    assert.deepEqual(await issues({ ...report, stack: 's'.repeat(4001) }), [422, 'VALIDATION_ERROR', [{ field: 'stack', issue: 'maxLength' }]]);
    assert.deepEqual(await issues({ ...report, route: '/groups/1/users?token=abc' }), [422, 'VALIDATION_ERROR', [{ field: 'route', issue: 'pattern' }]]);
    assert.deepEqual(await issues({ ...report, route: '/a b' }), [422, 'VALIDATION_ERROR', [{ field: 'route', issue: 'pattern' }]]);
    assert.deepEqual(await issues({ ...report, name: 'Type\u0000Error' }), [422, 'VALIDATION_ERROR', [{ field: 'name', issue: 'pattern' }]]);
    assert.deepEqual(await issues({ ...report, name: 'Type\u202EError' }), [422, 'VALIDATION_ERROR', [{ field: 'name', issue: 'pattern' }]]);
    assert.deepEqual(await issues({ ...report, appVersion: '1.0 <b>' }), [422, 'VALIDATION_ERROR', [{ field: 'appVersion', issue: 'pattern' }]]);
    for (const route of ['/groups/123/users', '/groups/0123456789abcdef01234567/users', '/groups/0123456789ABCDEF01234567', '//a', '/a/', 'groups', '/a%20b', '/:1x', '/a:b', '/a/b?x=1', '/groups/:groupId/users#top']) {
      assert.deepEqual(await issues({ ...report, route }), [422, 'VALIDATION_ERROR', [{ field: 'route', issue: 'pattern' }]], route);
    }
    assert.deepEqual(await issues({ ...report, route: '' }), [422, 'VALIDATION_ERROR', [{ field: 'route', issue: 'minLength' }]]);
    assert.deepEqual(await issues({ ...report, route: `/${'r'.repeat(200)}` }), [422, 'VALIDATION_ERROR', [{ field: 'route', issue: 'maxLength' }]]);
    assert.deepEqual(await issues({ ...report, appVersion: 'v'.repeat(33) }), [422, 'VALIDATION_ERROR', [{ field: 'appVersion', issue: 'maxLength' }]]);
    assert.deepEqual(await issues({ ...report, occurredAt: 'yesterday' }), [422, 'VALIDATION_ERROR', [{ field: 'occurredAt', issue: 'format' }]]);
    assert.deepEqual(await issues({ name: 'x' }), [422, 'VALIDATION_ERROR', [{ field: 'message', issue: 'required' }, { field: 'route', issue: 'required' }, { field: 'appVersion', issue: 'required' }]]);
    assert.deepEqual(await issues({ ...report, $where: 'x' }), [422, 'VALIDATION_ERROR', [{ field: '(key)', issue: 'forbiddenKey' }]]);
    assert.equal(reports().length, count, 'nothing is recorded for a refused report');
  });

  it('accepts route patterns made of names, parameters and wildcards, and versions with dots, plus and dash', async () => {
    let n = 0;
    for (const route of ['/', '/login', '/groups/:groupId/users', '/a_b-c/:id2/**', '/**', '/x1/12abc', '/groups/0123456789abcdef0123456']) {
      n += 1;
      const reply = await as.call(g0().sa, 'POST', '/client-errors', { ...report, message: `route ${String(n)}`, route, appVersion: '1.2.3-rc.1+build5' });
      assert.equal(reply.status, 202, route);
    }
  });

  it('stores the same error of the same user once, and again for another user or another error', async () => {
    const count = () => reports().length;
    const body = { ...report, message: 'dedupe-me', stack: 'TypeError: dedupe-me\n    at a (x.js:1:1)' };
    const start = count();
    assert.equal((await as.call(g0().ca, 'POST', '/client-errors', body)).status, 202);
    assert.equal((await as.call(g0().ca, 'POST', '/client-errors', { ...body, stack: 'TypeError: dedupe-me\n    at other (y.js:9:9)' })).status, 202);
    assert.equal(count(), start + 1, 'same name, message and first stack line: stored once');
    assert.equal((await as.call(g0().pa, 'POST', '/client-errors', body)).status, 202);
    assert.equal((await as.call(g0().ca, 'POST', '/client-errors', { ...body, message: 'another' })).status, 202);
    assert.equal(count(), start + 3);
    assert.ok(office.logEvents.some((event) => event['msg'] === 'client error repeated, not stored again' && event['repeats'] === 1));
  });

  it('refuses a body over 8 KB (413) and a body that is not JSON (415)', async () => {
    const token = (await office.tokens('user-001')).accessToken;
    const big = await office.call('POST', '/client-errors', token, { ...report, stack: 'x'.repeat(9000) });
    assert.equal(big.status, 413);
    const wrongType = await fetch(`${office.app.baseUrl}/v1/client-errors`, { method: 'POST', headers: { ...office.userHeaders('POST', '/client-errors', token), 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(wrongType.status, 415);
  });

  it('limits the reports per user (429 with Retry-After) without touching other users', async () => {
    const user = (await office.tokens((await addUser(ctx, office)).name)).accessToken;
    const other = (await office.tokens((await addUser(ctx, office)).name)).accessToken;
    for (let i = 0; i < 100; i += 1) {
      assert.equal((await office.call('POST', '/client-errors', user, report)).status, 202);
    }
    const limited = await office.call('POST', '/client-errors', user, report);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.has('retry-after'));
    assert.equal((await office.call('POST', '/client-errors', other, report)).status, 202);
  });

  it('is allowed while a provisional password is pending', async () => {
    const password = `Prov-${randomBytes(8).toString('hex')}-pass`;
    const created = await as.call(g0().sa, 'POST', `/groups/${hex(g0().groupId)}/users`, { username: 'provisional-reporter', password, role: 'PA', placeIds: [hex(fixtureId('place', 1))] });
    assert.equal(created.status, 201);
    const login = (await (await office.login('provisional-reporter', password)).json()) as { data: { accessToken: string; passwordChangeRequired: boolean } };
    assert.equal(login.data.passwordChangeRequired, true);
    assert.equal((await office.call('POST', '/client-errors', login.data.accessToken, report)).status, 202);
    assert.equal((await office.call('GET', '/users', login.data.accessToken)).status, 403);
  });
});

describe('what is stored of a report (real activity log)', () => {
  it('redacts credentials and connection strings, keeps 10 stack lines and 4000 characters', async () => {
    const token = `fc_at_${randomBytes(16).toString('hex')}`;
    const uri = 'mongodb://user:secret@db.example:27017/app';
    const lines = Array.from({ length: 40 }, (_, i) => `    at fn${String(i)} (https://app.example/main.js:${String(i)}:1)`);
    lines[2] = `    at login (https://app.example/?access=${token})`;
    lines[3] = `    at connect (${uri})`;
    const reply = await as.call(g0().sa, 'POST', '/client-errors', { ...report, message: `failed with ${token}`, stack: ['Error: boom', ...lines].join('\n') });
    assert.equal(reply.status, 202);
    const log = createActivityLog({ databases: ctx.databases, logger: memoryLogger().logger, retentionDays: 365, errorRetentionDays: 90 });
    await log.record(last());
    const stored = await ctx.databases.common().collection('activityEvents').find({ action: 'client.error', 'actor.id': g0().sa }).sort({ at: -1 }).limit(1).next();
    const text = JSON.stringify(stored);
    for (const secret of [token, uri, 'secret@']) {
      assert.ok(!text.includes(secret), secret);
    }
    const error = stored!['error'] as { name: string; message: string; stack: string };
    assert.equal(error.message, '[REDACTED]');
    assert.equal(error.stack.split('\n').length, 10);
    assert.ok(error.stack.includes('[REDACTED]'));
    assert.ok(error.stack.startsWith('Error: boom'));
    assert.ok(error.stack.length <= 4000);
    assert.deepEqual(Object.keys(stored!).sort(), ['_id', 'action', 'actor', 'at', 'category', 'error', 'expiresAt', 'groupId', 'ip', 'metadata', 'outcome', 'requestId']);
  });
});

describe('credentials of the reporter', () => {
  it('needs a live credential: expired, revoked and public API keys are refused', async () => {
    const { name } = await addUser(ctx, office);
    const revoked = await office.tokens(name);
    assert.equal((await office.call('POST', '/auth/logout', revoked.accessToken)).status, 204);
    const expired = await office.tokens((await addUser(ctx, office)).name);
    for (const credential of [revoked.accessToken, `fc_pk_${randomBytes(24).toString('hex')}`]) {
      const reply = await office.call('POST', '/client-errors', credential, report);
      assert.equal(reply.status, 401);
      assert.equal(((await reply.json()) as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
    }
    assert.equal((await office.call('POST', '/client-errors', expired.accessToken, report)).status, 202);
    const before = reports().length;
    office.clock.advance(901_000);
    const late = await office.call('POST', '/client-errors', expired.accessToken, report);
    assert.equal(late.status, 401);
    assert.equal(((await late.json()) as { error: { code: string } }).error.code, 'TOKEN_EXPIRED');
    assert.equal(reports().length, before);
  });
});
