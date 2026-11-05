import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';
import { activityLogPageQuery } from '../../src/modules/activity-log/activity-log.repository.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const group = (index: number) => office.cluster.groups[index]!;
const hex = (id: ObjectId) => id.toHexString();
const ghost = new ObjectId();

/** Seeded entries by label; `at` grows with the order of the labels. */
const ids = new Map<string, ObjectId>();

interface Seed {
  readonly label: string;
  readonly category: 'data' | 'security' | 'error';
  readonly action: string;
  readonly outcome?: string;
  readonly actor: Document;
  readonly groupId?: ObjectId;
  readonly at?: number;
  readonly extra?: Document;
}

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  const g0 = group(0);
  const user = (id: ObjectId, role: string): Document => ({ kind: 'user', id, role });
  const seeds: Seed[] = [
    { label: 'a-g0-sa-created', category: 'data', action: 'user.created', actor: user(g0.sa, 'SA'), groupId: g0.groupId, extra: { resource: { type: 'user', id: 'abc' }, changes: [{ field: 'firstName', after: 'Mario' }, { field: 'password', redacted: true }, { field: 'note', before: 'a', after: 'b', truncated: true }], requestId: 'req-g0-created', ip: '203.0.113.5', metadata: { changesTotal: 3 } } },
    { label: 'b-g1-sa-created', category: 'data', action: 'user.created', actor: user(group(1).sa, 'SA'), groupId: group(1).groupId },
    { label: 'c-g2-sa-created', category: 'data', action: 'user.created', actor: user(group(2).sa, 'SA'), groupId: group(2).groupId },
    { label: 'd-login', category: 'security', action: 'auth.loginSucceeded', actor: user(office.cluster.psa, 'PSA') },
    { label: 'e-g0-failed-login', category: 'security', action: 'auth.loginFailed', outcome: 'failure', actor: { kind: 'anonymous' }, groupId: g0.groupId, extra: { metadata: { reason: 'badPassword' } } },
    { label: 'f-g0-500', category: 'error', action: 'request.failed', outcome: 'failure', actor: user(g0.sa, 'SA'), groupId: g0.groupId, extra: { metadata: { method: 'GET', route: '/v1/x', errorName: 'Error' } } },
    { label: 'g-g0-ca-client-error', category: 'error', action: 'client.error', outcome: 'failure', actor: user(g0.ca, 'CA'), groupId: g0.groupId, extra: { metadata: { route: '/groups/:groupId/users', appVersion: '1.0.0' }, error: { name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n    at x' } } },
    { label: 'h-g0-ca-updated', category: 'data', action: 'company.updated', actor: user(g0.ca, 'CA'), groupId: g0.groupId },
    { label: 'i-g0-pa-updated', category: 'data', action: 'place.updated', actor: user(g0.pa, 'PA'), groupId: g0.groupId },
    { label: 'j-g0-ghost', category: 'data', action: 'user.trashed', actor: user(ghost, 'SA'), groupId: g0.groupId, extra: { requestId: 'req-ghost' } },
    { label: 'k-system', category: 'security', action: 'session.revoked', actor: { kind: 'system' }, groupId: g0.groupId, extra: { metadata: { reason: 'expired' } } },
    { label: 'l-g1-psa', category: 'security', action: 'group.suspended', actor: user(office.cluster.psa, 'PSA'), groupId: group(1).groupId },
  ];
  const documents = seeds.map((seed, index): Document => {
    const _id = new ObjectId();
    ids.set(seed.label, _id);
    const at = new Date(seed.at ?? T0 + index * 1000);
    return {
      _id,
      at,
      category: seed.category,
      action: seed.action,
      outcome: seed.outcome ?? 'success',
      actor: seed.actor,
      ...(seed.groupId === undefined ? {} : { groupId: seed.groupId }),
      ...seed.extra,
      expiresAt: new Date(Date.now() + 365 * DAY),
    };
  });
  await ctx.databases.common().collection('activityLog').insertMany(documents);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

const labelOf = new Map<string, string>();
const label = (id: string): string => {
  if (labelOf.size === 0) {
    for (const [name, value] of ids) {
      labelOf.set(hex(value), name);
    }
  }
  return labelOf.get(id) ?? `unknown:${id}`;
};
/** Labels of the seeded entries a request returns (entries of the login of the test itself are ignored). */
const labels = (reply: { body: { data: Array<{ id: string }> } }): string[] => reply.body.data.map((item) => label(item.id)).filter((name) => !name.startsWith('unknown'));
const get = (actor: ObjectId, query = '') => as.call(actor, 'GET', `/activity-log${query}`);
const ALL_NEWEST_FIRST = ['l-g1-psa', 'k-system', 'j-g0-ghost', 'i-g0-pa-updated', 'h-g0-ca-updated', 'g-g0-ca-client-error', 'f-g0-500', 'e-g0-failed-login', 'd-login', 'c-g2-sa-created', 'b-g1-sa-created', 'a-g0-sa-created'];

describe('GET /v1/activity-log visibility', () => {
  it('shows everything to the PSA, newest first, with the contract fields only', async () => {
    const reply = await get(office.cluster.psa, '?limit=200');
    assert.equal(reply.status, 200);
    assert.deepEqual(labels(reply), ALL_NEWEST_FIRST);
    assert.deepEqual(reply.body.page, { limit: 200, next: null });
    for (const item of reply.body.data) {
      assert.deepEqual(Object.keys(item).filter((key) => key !== 'error').sort(), ['action', 'actor', 'at', 'category', 'changes', 'groupId', 'id', 'ip', 'metadata', 'outcome', 'requestId', 'resource']);
      assert.deepEqual(Object.keys(item.actor).sort(), ['id', 'kind', 'role', 'username']);
      assert.equal('error' in item, item.action === 'client.error');
      assert.ok(!('expiresAt' in item) && !('_id' in item));
    }
  });

  it('maps an entry with changes, a resource, a client error, a ghost and a system actor', async () => {
    const byLabel = new Map((await get(office.cluster.psa, '?limit=200')).body.data.map((item: { id: string }) => [label(item.id), item]));
    assert.deepEqual(byLabel.get('a-g0-sa-created'), {
      id: hex(ids.get('a-g0-sa-created')!),
      at: new Date(T0).toISOString(),
      category: 'data',
      action: 'user.created',
      outcome: 'success',
      actor: { kind: 'user', id: hex(group(0).sa), role: 'SA', username: userName(group(0).sa) },
      groupId: hex(group(0).groupId),
      resource: { type: 'user', id: 'abc' },
      changes: [{ field: 'firstName', after: 'Mario' }, { field: 'password', redacted: true }, { field: 'note', before: 'a', after: 'b', truncated: true }],
      requestId: 'req-g0-created',
      ip: '203.0.113.5',
      metadata: { changesTotal: 3 },
    });
    const clientError = byLabel.get('g-g0-ca-client-error') as { error: unknown; metadata: unknown };
    assert.deepEqual(clientError.error, { name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n    at x' });
    assert.deepEqual(clientError.metadata, { route: '/groups/:groupId/users', appVersion: '1.0.0' });
    assert.deepEqual((byLabel.get('j-g0-ghost') as { actor: unknown }).actor, { kind: 'user', id: hex(ghost), role: 'SA', username: null });
    const system = byLabel.get('k-system') as Record<string, unknown>;
    assert.deepEqual([system['actor'], system['resource'], system['changes'], system['requestId'], system['ip'], system['metadata']], [{ kind: 'system', id: null, role: null, username: null }, null, [], null, null, { reason: 'expired' }]);
    assert.deepEqual((byLabel.get('e-g0-failed-login') as { actor: unknown }).actor, { kind: 'anonymous', id: null, role: null, username: null });
  });

  it('shows a dealer the entries of his groups only, never errors', async () => {
    assert.deepEqual(labels(await get(office.cluster.dealerA, '?limit=200')), ['l-g1-psa', 'k-system', 'j-g0-ghost', 'i-g0-pa-updated', 'h-g0-ca-updated', 'e-g0-failed-login', 'b-g1-sa-created', 'a-g0-sa-created']);
    assert.deepEqual(labels(await get(office.cluster.dealerB, '?limit=200')), ['c-g2-sa-created']);
  });

  it('lets a dealer narrow to one of his groups and gets an empty list for a group that is not his', async () => {
    assert.deepEqual(labels(await get(office.cluster.dealerA, `?groupId=${hex(group(1).groupId)}`)), ['l-g1-psa', 'b-g1-sa-created']);
    assert.deepEqual(labels(await get(office.cluster.dealerA, `?groupId=${hex(group(2).groupId)}`)), []);
    assert.deepEqual(labels(await get(office.cluster.dealerA, `?groupId=${hex(new ObjectId())}`)), []);
    assert.deepEqual(labels(await get(office.cluster.psa, `?groupId=${hex(group(2).groupId)}`)), ['c-g2-sa-created']);
  });

  it('shows a group administrator the entries of his group only, never errors, whatever groupId he asks', async () => {
    const own = ['k-system', 'j-g0-ghost', 'i-g0-pa-updated', 'h-g0-ca-updated', 'e-g0-failed-login', 'a-g0-sa-created'];
    assert.deepEqual(labels(await get(group(0).sa, '?limit=200')), own);
    assert.deepEqual(labels(await get(group(0).sa, `?groupId=${hex(group(0).groupId)}`)), own);
    assert.deepEqual(labels(await get(group(0).sa, `?groupId=${hex(group(1).groupId)}`)), []);
    assert.deepEqual(labels(await get(group(1).sa, '?limit=200')), ['l-g1-psa', 'b-g1-sa-created']);
  });

  it('shows a company or place administrator only his own actions, never errors', async () => {
    assert.deepEqual(labels(await get(group(0).ca, '?limit=200')), ['h-g0-ca-updated']);
    assert.deepEqual(labels(await get(group(0).pa, '?limit=200')), ['i-g0-pa-updated']);
    assert.deepEqual(labels(await get(group(0).ca, `?actorId=${hex(group(0).pa)}`)), []);
    assert.deepEqual(labels(await get(group(0).ca, `?actorId=${hex(group(0).ca)}`)), ['h-g0-ca-updated']);
    assert.deepEqual(labels(await get(group(0).pa, '?action=place.updated')), ['i-g0-pa-updated']);
  });

  it('keeps the error category to the PSA: 403 when anybody else asks for it, none in unfiltered lists', async () => {
    for (const actor of [office.cluster.dealerA, group(0).sa, group(0).ca, group(0).pa]) {
      const reply = await get(actor, '?category=error');
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN']);
      for (const action of ['client.error', 'request.failed']) {
        const byAction = await get(actor, `?action=${action}`);
        assert.deepEqual([byAction.status, byAction.body.error.code], [403, 'FORBIDDEN'], action);
      }
      assert.equal((await get(actor, '?action=user.created')).status, 200);
    }
    assert.deepEqual(labels(await get(office.cluster.psa, '?category=error')), ['g-g0-ca-client-error', 'f-g0-500']);
  });

  it('requires authentication', async () => {
    const reply = await fetch(`${office.app.baseUrl}/v1/activity-log`);
    assert.equal(reply.status, 401);
  });

  it('requires the activityLog:read permission, read at every request', async () => {
    const users = ctx.databases.common().collection('users');
    assert.equal((await get(group(0).pa)).status, 200);
    await users.updateOne({ _id: group(0).pa }, { $set: { 'permissions.logs': { r: false, w: false } } });
    const denied = await get(group(0).pa);
    assert.deepEqual([denied.status, denied.body.error.code], [403, 'FORBIDDEN']);
    await users.updateOne({ _id: group(0).pa }, { $set: { 'permissions.logs': { r: true, w: true } } });
    assert.equal((await get(group(0).pa)).status, 200);
  });
});

describe('GET /v1/activity-log actors above the viewer', () => {
  it('hides id, user name and address of an actor with a higher role, keeping the role', async () => {
    const g0 = group(0);
    const mk = (actor: Document, ip: string, offset: number): Document => ({
      _id: new ObjectId(),
      at: new Date(T0 + 800_000 + offset),
      category: 'data',
      action: 'place.created',
      outcome: 'success',
      actor,
      groupId: g0.groupId,
      ip,
      expiresAt: new Date(Date.now() + 365 * DAY),
    });
    const entries = [
      mk({ kind: 'user', id: office.cluster.psa, role: 'PSA' }, '198.51.100.1', 1),
      mk({ kind: 'user', id: office.cluster.dealerA, role: 'D' }, '198.51.100.2', 2),
      mk({ kind: 'user', id: g0.sa, role: 'SA' }, '198.51.100.3', 3),
    ];
    await ctx.databases.common().collection('activityLog').insertMany(entries);
    const seen = async (viewer: ObjectId) => {
      const reply = await get(viewer, '?action=place.created');
      return reply.body.data.map((item: { actor: { id: string | null; role: string; username: string | null }; ip: string | null }) => [item.actor.role, item.actor.id !== null, item.actor.username !== null, item.ip !== null]);
    };
    // Newest first: SA, D, PSA.
    assert.deepEqual(await seen(office.cluster.psa), [['SA', true, true, true], ['D', true, true, true], ['PSA', true, true, true]]);
    assert.deepEqual(await seen(office.cluster.dealerA), [['SA', true, true, true], ['D', true, true, true], ['PSA', false, false, false]]);
    assert.deepEqual(await seen(g0.sa), [['SA', true, true, true], ['D', false, false, false], ['PSA', false, false, false]]);
    await ctx.databases.common().collection('activityLog').deleteMany({ _id: { $in: entries.map((entry) => entry['_id'] as ObjectId) } });
  });
});

describe('GET /v1/activity-log and groups that are no longer available', () => {
  it('stops showing a dealer the entries of a suspended or trashed group, and shows them again when it is back', async () => {
    const groups = ctx.databases.common().collection('groups');
    const dealer = office.cluster.dealerA;
    const g1 = group(1).groupId;
    assert.ok(labels(await get(dealer, '?limit=200')).includes('b-g1-sa-created'));
    await groups.updateOne({ _id: g1 }, { $set: { status: false } });
    assert.ok(!labels(await get(dealer, '?limit=200')).includes('b-g1-sa-created'));
    assert.deepEqual(labels(await get(dealer, `?groupId=${hex(g1)}`)), []);
    await groups.updateOne({ _id: g1 }, { $set: { status: true, trash: true } });
    assert.ok(!labels(await get(dealer, '?limit=200')).includes('l-g1-psa'));
    await groups.updateOne({ _id: g1 }, { $set: { trash: false } });
    assert.ok(labels(await get(dealer, '?limit=200')).includes('l-g1-psa'));
    assert.ok(labels(await get(office.cluster.psa, '?limit=200')).includes('b-g1-sa-created'));
  });
});

describe('GET /v1/activity-log queries use the indexes', () => {
  const blocking = (plan: unknown): boolean => JSON.stringify(plan).includes('"stage":"SORT"');
  it('has no blocking sort stage for the PSA, a dealer, a group administrator, a company administrator and a category filter', async () => {
    const principal = async (role: string, id: ObjectId, scope: unknown) => ({ userId: id, role, scope }) as never;
    const g0 = group(0);
    const cases: Array<[string, unknown, Document]> = [
      ['PSA, no filters', await principal('PSA', office.cluster.psa, { kind: 'platform' }), {}],
      ['PSA, category', await principal('PSA', office.cluster.psa, { kind: 'platform' }), { category: 'security' }],
      ['PSA, actor', await principal('PSA', office.cluster.psa, { kind: 'platform' }), { 'actor.id': g0.sa }],
      ['SA, group', await principal('SA', g0.sa, { kind: 'group', groupId: g0.groupId }), {}],
      ['CA, own actions', await principal('CA', g0.ca, { kind: 'companies', groupId: g0.groupId }), {}],
      ['D, groups', await principal('D', office.cluster.dealerA, { kind: 'dealer', groupIds: new Set([hex(g0.groupId), hex(group(1).groupId)]) }), {}],
      ['SA, category filter', await principal('SA', g0.sa, { kind: 'group', groupId: g0.groupId }), { category: 'data' }],
    ];
    for (const [name, who, filter] of cases) {
      const params = { limit: 50, sort: '-at', q: null, cursor: null };
      const { match, options } = activityLogPageQuery(who as never, filter, params);
      const plan = await ctx.databases.common().collection('activityLog').find(match, options).explain('queryPlanner');
      assert.ok(!blocking(plan.queryPlanner.winningPlan), `${name}: ${JSON.stringify(plan.queryPlanner.winningPlan)}`);
    }
  });
});

describe('GET /v1/activity-log filters', () => {
  it('filters by category, action, outcome, actor, group, request id and period (all combinable)', async () => {
    const psa = office.cluster.psa;
    assert.deepEqual(labels(await get(psa, '?category=security')), ['l-g1-psa', 'k-system', 'e-g0-failed-login', 'd-login']);
    assert.deepEqual(labels(await get(psa, '?action=user.created')), ['c-g2-sa-created', 'b-g1-sa-created', 'a-g0-sa-created']);
    assert.deepEqual(labels(await get(psa, '?outcome=failure')), ['g-g0-ca-client-error', 'f-g0-500', 'e-g0-failed-login']);
    assert.deepEqual(labels(await get(psa, `?actorId=${hex(group(0).sa)}`)), ['f-g0-500', 'a-g0-sa-created']);
    assert.deepEqual(labels(await get(psa, '?requestId=req-ghost')), ['j-g0-ghost']);
    assert.deepEqual(labels(await get(psa, `?actorId=${hex(group(0).sa)}&category=data&outcome=success&groupId=${hex(group(0).groupId)}&action=user.created`)), ['a-g0-sa-created']);
    assert.deepEqual(labels(await get(psa, `?actorId=${hex(group(0).sa)}&category=security`)), []);
  });

  it('filters by period with inclusive bounds and accepts one bound alone', async () => {
    const iso = (offset: number) => new Date(T0 + offset).toISOString();
    const psa = office.cluster.psa;
    assert.deepEqual(labels(await get(psa, `?from=${iso(2000)}&to=${iso(4000)}`)), ['e-g0-failed-login', 'd-login', 'c-g2-sa-created']);
    assert.deepEqual(labels(await get(psa, `?from=${iso(10_000)}`)), ['l-g1-psa', 'k-system']);
    assert.deepEqual(labels(await get(psa, `?to=${iso(1000)}`)), ['b-g1-sa-created', 'a-g0-sa-created']);
    assert.deepEqual(labels(await get(psa, `?from=${iso(3000)}&to=${iso(3000)}`)), ['d-login']);
    assert.deepEqual(labels(await get(psa, '?from=2026-06-01&to=2026-06-02')), ALL_NEWEST_FIRST);
  });

  it('resolves the user names of the page in one go', async () => {
    const reply = await get(office.cluster.psa, `?actorId=${hex(group(0).ca)}`);
    assert.deepEqual(reply.body.data.map((item: { actor: { username: string } }) => item.actor.username), [userName(group(0).ca), userName(group(0).ca)]);
  });
});

describe('GET /v1/activity-log actors without a user name', () => {
  it('shows a null user name for a user that has none and skips the lookup when no actor is a user', async () => {
    const nameless = new ObjectId();
    const entry = new ObjectId();
    await ctx.databases.common().collection('users').insertOne({ _id: nameless, userName: 7, role: 'SA' });
    await ctx.databases.common().collection('activityLog').insertOne({ _id: entry, at: new Date(T0 + 900_000), category: 'data', action: 'user.updated', outcome: 'success', actor: { kind: 'user', id: nameless, role: 'SA' }, expiresAt: new Date(Date.now() + 365 * DAY) });
    const reply = await get(office.cluster.psa, '?action=user.updated');
    assert.deepEqual(reply.body.data.map((item: { id: string; actor: { username: null } }) => [item.id, item.actor.username]), [[hex(entry), null]]);
    await ctx.databases.common().collection('activityLog').deleteOne({ _id: entry });
    await ctx.databases.common().collection('users').deleteOne({ _id: nameless });
    assert.deepEqual(labels(await get(office.cluster.psa, '?action=session.revoked')), ['k-system']);
  });
});

describe('GET /v1/activity-log pagination', () => {
  it('walks the whole list with the cursor, newest first, without gaps or repeats, also across equal timestamps', async () => {
    const same = new Date(T0 + 500_000);
    const tied = Array.from({ length: 5 }, (_, i) => ({
      _id: new ObjectId(),
      at: same,
      category: 'data',
      action: 'user.updated',
      outcome: 'success',
      actor: { kind: 'user', id: group(0).sa, role: 'SA' },
      groupId: group(0).groupId,
      requestId: `req-tied-${String(i)}`,
      expiresAt: new Date(Date.now() + 365 * DAY),
    }));
    await ctx.databases.common().collection('activityLog').insertMany(tied);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const reply: Awaited<ReturnType<typeof get>> = await get(office.cluster.psa, `?limit=3${cursor === null ? '' : `&cursor=${cursor}`}&action=user.updated`);
      assert.equal(reply.status, 200);
      assert.ok(reply.body.data.length <= 3);
      seen.push(...reply.body.data.map((item: { id: string }) => item.id));
      cursor = reply.body.page.next;
      pages += 1;
    } while (cursor !== null);
    assert.equal(pages, 2);
    assert.deepEqual(seen, tied.map((entry) => hex(entry._id)).reverse());
    const everything: string[] = [];
    let next: string | null = null;
    do {
      const reply: Awaited<ReturnType<typeof get>> = await get(office.cluster.psa, `?limit=4${next === null ? '' : `&cursor=${next}`}`);
      everything.push(...reply.body.data.map((item: { id: string }) => item.id));
      next = reply.body.page.next;
    } while (next !== null);
    assert.equal(new Set(everything).size, everything.length);
    assert.ok(everything.length >= ALL_NEWEST_FIRST.length + tied.length);
    await ctx.databases.common().collection('activityLog').deleteMany({ _id: { $in: tied.map((entry) => entry._id) } });
  });

  it('keeps the cursor inside the caller scope and answers an empty page to a cursor without a date', async () => {
    const first = await get(office.cluster.psa, '?limit=2');
    const cursor = first.body.page.next as string;
    // A cursor taken by a PSA does not widen the scope of a CA: the scope filter is always applied.
    const asCa = await get(group(0).ca, `?cursor=${cursor}`);
    assert.equal(asCa.status, 200);
    assert.ok(labels(asCa).every((name) => name === 'h-g0-ca-updated'));
    const nullDate = Buffer.from(JSON.stringify({ ver: 1, s: '-at', v: null, id: hex(new ObjectId()) })).toString('base64url');
    const empty = await get(office.cluster.psa, `?cursor=${nullDate}`);
    assert.deepEqual([empty.status, empty.body.data, empty.body.page.next], [200, [], null]);
  });

  it('rejects malformed cursors and out-of-range limits', async () => {
    const asc = Buffer.from(JSON.stringify({ ver: 1, s: 'at', v: 1, id: hex(new ObjectId()) })).toString('base64url');
    for (const bad of ['cursor=!!!', `cursor=${asc}`, 'cursor=', 'limit=0', 'limit=201', 'limit=abc', 'limit=1&limit=2']) {
      const reply = await get(office.cluster.psa, `?${bad}`);
      assert.deepEqual([bad, reply.status, reply.body.error.code], [bad, 422, 'VALIDATION_ERROR']);
    }
  });
});

describe('GET /v1/activity-log query validation', () => {
  const failure = async (query: string, actor = office.cluster.psa) => {
    const reply = await get(actor, query);
    return [reply.status, reply.body.error.code, reply.body.error.details];
  };

  it('rejects unknown parameters, sort and q, operators and bad values', async () => {
    assert.deepEqual(await failure('?sort=at'), [422, 'VALIDATION_ERROR', [{ field: 'sort', issue: 'unknown' }]]);
    assert.deepEqual(await failure('?q=x'), [422, 'VALIDATION_ERROR', [{ field: 'q', issue: 'unknown' }]]);
    assert.deepEqual(await failure('?category[$ne]=data'), [422, 'VALIDATION_ERROR', [{ field: '(key)', issue: 'unknown' }]]);
    assert.deepEqual(await failure('?category=other'), [422, 'VALIDATION_ERROR', [{ field: 'category', issue: 'enum' }]]);
    assert.deepEqual(await failure('?action=user.exploded'), [422, 'VALIDATION_ERROR', [{ field: 'action', issue: 'enum' }]]);
    assert.deepEqual(await failure('?outcome=maybe'), [422, 'VALIDATION_ERROR', [{ field: 'outcome', issue: 'enum' }]]);
    assert.deepEqual(await failure('?actorId=nope'), [422, 'VALIDATION_ERROR', [{ field: 'actorId', issue: 'format' }]]);
    assert.deepEqual(await failure('?groupId=nope'), [422, 'VALIDATION_ERROR', [{ field: 'groupId', issue: 'format' }]]);
    assert.deepEqual(await failure(`?requestId=${'r'.repeat(129)}`), [422, 'VALIDATION_ERROR', [{ field: 'requestId', issue: 'maxLength' }]]);
    assert.deepEqual(await failure('?requestId='), [422, 'VALIDATION_ERROR', [{ field: 'requestId', issue: 'minLength' }]]);
    assert.deepEqual(await failure('?from=yesterday'), [422, 'VALIDATION_ERROR', [{ field: 'from', issue: 'format' }]]);
    assert.deepEqual(await failure('?to=2026-02-30'), [422, 'VALIDATION_ERROR', [{ field: 'to', issue: 'format' }]]);
  });

  it('rejects a period that ends before it starts or is longer than 400 days', async () => {
    assert.deepEqual(await failure('?from=2026-06-02&to=2026-06-01'), [422, 'VALIDATION_ERROR', [{ field: 'to', issue: 'minimum' }]]);
    assert.deepEqual(await failure('?from=2025-01-01&to=2026-06-01'), [422, 'VALIDATION_ERROR', [{ field: 'to', issue: 'maximum' }]]);
    assert.equal((await get(office.cluster.psa, '?from=2025-05-01&to=2026-06-01')).status, 200);
    const from = Date.UTC(2025, 0, 1);
    const at = (ms: number) => new Date(ms).toISOString();
    assert.equal((await get(office.cluster.psa, `?from=${at(from)}&to=${at(from + 400 * DAY)}`)).status, 200);
    assert.equal((await get(office.cluster.psa, `?from=${at(from)}&to=${at(from + 400 * DAY + 1)}`)).status, 422);
  });

  it('checks the validation before the scope and the scope before the data', async () => {
    assert.deepEqual(await failure('?category=error&limit=0', group(0).sa), [422, 'VALIDATION_ERROR', [{ field: 'limit', issue: 'minimum' }]]);
    assert.equal((await get(group(0).sa, '?category=error')).status, 403);
  });
});

describe('GET /v1/activity-log credentials', () => {
  it('refuses revoked tokens, public API keys and, last, expired tokens', async () => {
    const revoked = await office.tokens(userName(group(0).sa));
    assert.equal((await office.call('POST', '/auth/logout', revoked.accessToken)).status, 204);
    const expired = await office.tokens(userName(group(1).sa));
    assert.equal((await office.call('GET', '/activity-log', expired.accessToken)).status, 200);
    for (const credential of [revoked.accessToken, `fc_pk_${'a'.repeat(48)}`]) {
      const reply = await office.call('GET', '/activity-log', credential);
      assert.deepEqual([reply.status, ((await reply.json()) as { error: { code: string } }).error.code], [401, 'UNAUTHENTICATED']);
    }
    office.clock.advance(901_000);
    const late = await office.call('GET', '/activity-log', expired.accessToken);
    assert.deepEqual([late.status, ((await late.json()) as { error: { code: string } }).error.code], [401, 'TOKEN_EXPIRED']);
  });
});
