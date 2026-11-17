import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Document, ObjectId } from 'mongodb';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

type GroupIndex = '0' | '1' | '2' | '3';
const a1: GroupIndex = '0';
const a2: GroupIndex = '1';
const b1: GroupIndex = '2';
const b2: GroupIndex = '3';
const group = (index: GroupIndex) => office.cluster.groups[Number(index)]!;
const gpath = (index: GroupIndex, query = '') => `/groups/${group(index).groupId.toHexString()}/users${query}`;
const hex = (id: ObjectId) => id.toHexString();
const users = () => ctx.databases.common().collection('users');

const D1 = new Date('2025-03-01T10:00:00.000Z');
const D2 = new Date('2025-04-01T10:00:00.000Z');

/** Extra users of group 2 (`a2`), with the awkward values a list has to sort: equal, empty and missing. */
function extras(): Document[] {
  const g = group(a2);
  const make = (n: number, overrides: Document, drop: string[] = []): Document => {
    const document = legacyUser(n, { role: 'E', groupId: g.groupId, dealerId: g.dealerId, placeId: g.ownPlaceId, placesId: [g.ownPlaceId], ...overrides });
    for (const field of drop) {
      delete document[field];
    }
    return document;
  };
  return [
    make(1000, { surname: 'Same', insertDate: D1 }),
    make(1001, { surname: 'Same', insertDate: D1 }),
    make(1002, { surname: 'Same', insertDate: D1 }),
    make(1003, {}, ['surname']),
    make(1004, { surname: 'Alpha' }, ['insertDate']),
    make(1005, { surname: 'Same', insertDate: D2 }),
    make(1006, { surname: '', insertDate: D2 }),
    make(1007, { surname: 'zeta', insertDate: D2 }),
    make(1008, { userName: 'Page-UPPER', insertDate: D2 }),
    make(1009, { status: false }),
    make(1010, { trash: true }),
    make(1011, { name: 'Reg.Ex', surname: 'a(b', email: 'x+y@example.test', telephone: '+39 0123 456', userName: 'search-me' }),
  ];
}

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  await users().insertMany(extras());
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

const SORTS = {
  username: { field: 'userName', kind: 'string' },
  lastName: { field: 'surname', kind: 'string' },
  createdAt: { field: 'insertDate', kind: 'date' },
} as const;

/** The order the list must have, computed here from the stored documents with plain code. */
function expectedOrder(documents: Document[], token: string): string[] {
  const descending = token.startsWith('-');
  const { field, kind } = SORTS[(descending ? token.slice(1) : token) as keyof typeof SORTS];
  const value = (document: Document): string | number | null => {
    const raw: unknown = document[field];
    return kind === 'date' ? (raw instanceof Date ? raw.getTime() : null) : typeof raw === 'string' ? raw : null;
  };
  const compare = (a: Document, b: Document): number => {
    const [x, y] = [value(a), value(b)];
    const byValue = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
    return byValue !== 0 ? byValue : hex(a['_id'] as ObjectId) < hex(b['_id'] as ObjectId) ? -1 : 1;
  };
  return [...documents].sort((a, b) => (descending ? compare(b, a) : compare(a, b))).map((document) => hex(document['_id'] as ObjectId));
}

/** Follows the cursors to the end and returns the ids in order, with the size of each page. */
async function walk(path: string, query: string): Promise<{ ids: string[]; sizes: number[] }> {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const reply = await as.call(group(a2).sa, 'GET', `${path}?${query}${cursor === null ? '' : `&cursor=${cursor}`}`);
    assert.equal(reply.status, 200);
    sizes.push(reply.body.data.length);
    ids.push(...reply.body.data.map((user: { id: string }) => user.id));
    cursor = reply.body.page.next;
    if (cursor === null) {
      return { ids, sizes };
    }
  }
  return assert.fail('the cursors never ended');
}

const listed = async (path: string, actor: ObjectId = group(a2).sa) => {
  const reply = await as.call(actor, 'GET', path);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body as { data: Array<Record<string, unknown> & { id: string; username: string }>; page: { limit: number; next: string | null } };
};

describe('GET /v1/groups/{groupId}/users: the common case', () => {
  it('returns the users of the group, sorted by username, with the response mapper and no secret', async () => {
    const body = await listed(gpath(a1), group(a1).sa);
    assert.deepEqual(body.page, { limit: 50, next: null });
    assert.deepEqual(body.data.map((user) => [user.username, user['role']]), [['user-003', 'SA'], ['user-004', 'CA'], ['user-005', 'PA'], ['user-006', 'E']]);
    assert.deepEqual(Object.keys(body.data[0]!).sort(), [
      'canManagePermissions', 'companyIds', 'createdAt', 'dealerId', 'description', 'email', 'firstName', 'groupId', 'hasAvatar', 'hiddenInStats', 'id', 'language', 'lastName', 'permissions', 'phone', 'pinSet', 'placeIds', 'pos', 'role', 'serviceIds', 'shiftTime', 'status', 'trashed', 'trashedAt', 'updatedAt', 'username',
    ].filter((key) => key !== 'canManagePermissions'));
    const text = JSON.stringify(body);
    for (const secret of ['"pin"', '1234', 'token-003', 'tokens', 'scrypt$', '"password"', '"avatar"', 'discounts', 'productsStatus']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.equal((body.data[0]!['permissions'] as { canManagePermissions: boolean }).canManagePermissions, true);
  });

  it('shows each role the users of its own perimeter and nothing else', async () => {
    const names = async (actor: ObjectId, index: GroupIndex) => (await listed(gpath(index), actor)).data.map((user) => user.username);
    const g = group(a1);
    assert.deepEqual(await names(office.cluster.psa, a1), ['user-003', 'user-004', 'user-005', 'user-006']);
    assert.deepEqual(await names(office.cluster.dealerA, a1), ['user-003', 'user-004', 'user-005', 'user-006']);
    assert.deepEqual(await names(g.sa, a1), ['user-003', 'user-004', 'user-005', 'user-006']);
    // The CA reaches the CA of his companies and the PA and E of the places of those companies: not the SA, not the E of the other company.
    assert.deepEqual(await names(g.ca, a1), ['user-004', 'user-005']);
    // The PA reaches the users of his places: himself.
    assert.deepEqual(await names(g.pa, a1), ['user-005']);
  });
});

describe('GET /v1/groups/{groupId}/users: isolation', () => {
  const cases: Array<[string, () => ObjectId, GroupIndex, number, string?]> = [
    ['PSA reaches a group of dealer B', () => office.cluster.psa, b1, 200],
    ['dealer A does not reach a group of dealer B', () => office.cluster.dealerA, b1, 404, 'NOT_FOUND'],
    ['dealer B does not reach a group of dealer A', () => office.cluster.dealerB, a1, 404, 'NOT_FOUND'],
    ['an SA does not reach another group of the same dealer', () => group(a1).sa, a2, 404, 'NOT_FOUND'],
    ['an SA does not reach a group of another dealer', () => group(a1).sa, b1, 404, 'NOT_FOUND'],
    ['a CA does not reach another group', () => group(a1).ca, a2, 404, 'NOT_FOUND'],
    ['a PA does not reach another group', () => group(a1).pa, a2, 404, 'NOT_FOUND'],
  ];
  for (const [name, actor, target, status, code] of cases) {
    it(name, async () => {
      const reply = await as.call(actor(), 'GET', gpath(target));
      assert.deepEqual([reply.status, reply.body.error?.code], [status, code]);
    });
  }

  it('does not let a group id with an operator, a malformed or an unknown group through', async () => {
    for (const id of ['not-a-group', '%7B%22%24ne%22%3Anull%7D', 'ffffffffffffffffffffffff']) {
      const reply = await as.call(office.cluster.psa, 'GET', `/groups/${id}/users`);
      assert.deepEqual([reply.status, reply.body.error.code], [404, 'NOT_FOUND'], id);
    }
  });

  it('an employee cannot even sign in, so he reaches nothing', async () => {
    assert.equal((await office.login(`user-006`)).status, 401);
  });

  it('keeps a trashed or suspended group to the PSA', async () => {
    await ctx.databases.common().collection('groups').updateOne({ _id: group(b2).groupId }, { $set: { trash: true } });
    await ctx.databases.common().collection('groups').updateOne({ _id: group(a1).groupId }, { $set: { status: false } });
    try {
      assert.equal((await as.call(office.cluster.psa, 'GET', gpath(b2))).status, 200);
      assert.equal((await as.call(office.cluster.dealerB, 'GET', gpath(b2))).status, 404);
      assert.equal((await as.call(office.cluster.dealerA, 'GET', gpath(a1))).status, 404);
    } finally {
      await ctx.databases.common().collection('groups').updateOne({ _id: group(b2).groupId }, { $set: { trash: false } });
      await ctx.databases.common().collection('groups').updateOne({ _id: group(a1).groupId }, { $set: { status: true } });
    }
  });
});

describe('GET /v1/groups/{groupId}/users: pagination', () => {
  const inGroup = async (): Promise<Document[]> =>
    users().find({ groupId: group(a2).groupId, role: { $in: ['SA', 'CA', 'PA', 'E', null] }, trash: { $ne: true } }).toArray();

  for (const sort of ['username', '-username', 'lastName', '-lastName', 'createdAt', '-createdAt']) {
    it(`walks every user exactly once in the stable order of sort=${sort}, with ties, empty and missing values`, async () => {
      const expected = expectedOrder(await inGroup(), sort);
      assert.ok(expected.length >= 14);
      for (const limit of [1, 2, 5, 200]) {
        const { ids, sizes } = await walk(gpath(a2).split('?')[0]!, `sort=${sort}&limit=${String(limit)}`);
        assert.deepEqual(ids, expected, `limit ${String(limit)}`);
        assert.ok(sizes.every((size) => size <= limit));
        assert.ok(sizes.slice(0, -1).every((size) => size === limit), 'every page but the last is full');
      }
    });
  }

  it('sorts before it cuts: the first page is the top of the whole ordering, not of the stored order', async () => {
    const expected = expectedOrder(await inGroup(), '-createdAt');
    const body = await listed(`${gpath(a2)}?sort=-createdAt&limit=3`);
    assert.deepEqual(body.data.map((user) => user.id), expected.slice(0, 3));
    assert.notEqual(body.page.next, null);
  });

  it('orders usernames by bytes: an upper-case name comes before the lower-case ones', async () => {
    const body = await listed(`${gpath(a2)}?limit=200`);
    const names = body.data.map((user) => user.username);
    assert.equal(names[0], 'Page-UPPER');
    assert.deepEqual(names, [...names].sort());
  });

  it('ends with next null both when the page is exactly full and when it is not', async () => {
    const total = (await inGroup()).length;
    const exact = await listed(`${gpath(a2)}?limit=${String(total)}`);
    assert.deepEqual([exact.data.length, exact.page.next], [total, null]);
    const short = await listed(`${gpath(a2)}?limit=${String(total - 1)}`);
    assert.notEqual(short.page.next, null);
    const reply = await as.call(group(a2).sa, 'GET', `${gpath(a2)}?limit=${String(total - 1)}&cursor=${short.page.next!}`);
    assert.deepEqual([reply.body.data.length, reply.body.page.next], [1, null]);
    assert.equal(short.page.limit, total - 1);
  });

  it('does not repeat or skip a user when one is added between two pages', async () => {
    const first = await listed(`${gpath(a2)}?limit=3`);
    const late = legacyUser(1100, { role: 'E', groupId: group(a2).groupId, dealerId: group(a2).dealerId, placeId: group(a2).ownPlaceId, placesId: [group(a2).ownPlaceId], userName: 'a-late-arrival' });
    await users().insertOne(late);
    try {
      const rest = await walk(gpath(a2).split('?')[0]!, 'limit=3');
      assert.equal(new Set(rest.ids).size, rest.ids.length);
      const second = await as.call(group(a2).sa, 'GET', `${gpath(a2)}?limit=3&cursor=${first.page.next!}`);
      const seen = [...first.data.map((user) => user.id), ...second.body.data.map((user: { id: string }) => user.id)];
      assert.equal(new Set(seen).size, 6);
      assert.ok(!seen.includes(hex(late['_id'] as ObjectId)), 'the late arrival sorts before the cursor, so this walk does not see it');
    } finally {
      await users().deleteOne({ _id: late['_id'] });
    }
  });
});

describe('GET /v1/groups/{groupId}/users: the request is validated', () => {
  const problem = async (query: string) => {
    const reply = await as.call(group(a2).sa, 'GET', `${gpath(a2)}?${query}`);
    return { status: reply.status, code: reply.body.error?.code, details: reply.body.error?.details };
  };
  const invalid = (field: string, issue: string) => ({ status: 422, code: 'VALIDATION_ERROR', details: [{ field, issue }] });

  it('refuses a limit out of range, not numeric or repeated', async () => {
    assert.deepEqual(await problem('limit=0'), invalid('limit', 'minimum'));
    assert.deepEqual(await problem('limit=201'), invalid('limit', 'maximum'));
    for (const bad of ['limit=abc', 'limit=1.5', 'limit=-1', 'limit=', 'limit=1&limit=2', 'limit[]=1', 'limit=0x10']) {
      assert.equal((await problem(bad)).status, 422, bad);
    }
  });

  it('refuses a sort outside the allowlist, a repeated one and unknown parameters', async () => {
    for (const bad of ['sort=password', 'sort=-password', 'sort=insertDate', 'sort=name,-name', 'sort=username&sort=-username', 'sort[$ne]=1']) {
      assert.equal((await problem(bad)).status, 422, bad);
    }
    assert.deepEqual(await problem('foo=1'), invalid('foo', 'unknown'));
    assert.deepEqual(await problem('groupId=abc'), invalid('groupId', 'unknown'));
    assert.deepEqual(await problem('dealerId=abc'), invalid('dealerId', 'unknown'));
  });

  it('refuses filters outside their values', async () => {
    assert.deepEqual(await problem('role=PSA'), invalid('role', 'enum'));
    assert.deepEqual(await problem('role=SA&role=CA'), invalid('role', 'type'));
    assert.deepEqual(await problem('status=on'), invalid('status', 'enum'));
    assert.deepEqual(await problem('trashed=1'), invalid('trashed', 'enum'));
  });

  it('refuses an empty or too long search text', async () => {
    assert.deepEqual(await problem('q='), invalid('q', 'minLength'));
    assert.deepEqual(await problem('q=%20%20'), invalid('q', 'minLength'));
    assert.deepEqual(await problem(`q=${'a'.repeat(65)}`), invalid('q', 'maxLength'));
  });

  it('refuses a cursor that is garbled, from another sort or from another version, with cursor/format', async () => {
    const first = await listed(`${gpath(a2)}?limit=2`);
    const cursor = first.page.next!;
    const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const tampered = [
      'garbage!',
      Buffer.from('not json').toString('base64url'),
      encode({ ...json, ver: 2 }),
      encode({ ...json, id: 'zz' }),
      encode({ ...json, v: 12 }),
      encode({ ...json, extra: true }),
      encode({ ...json, s: 'lastName' }),
      '"' + cursor,
    ];
    for (const bad of tampered) {
      assert.deepEqual(await problem(`cursor=${encodeURIComponent(bad)}`), invalid('cursor', 'format'), bad);
    }
    // The cursor of one sort is refused by another.
    assert.deepEqual(await problem(`sort=-username&cursor=${cursor}`), invalid('cursor', 'format'));
    assert.deepEqual(await problem(`sort=lastName&cursor=${cursor}`), invalid('cursor', 'format'));
    // A cursor holds the sort token, a value the client already sees and an id: nothing else.
    assert.deepEqual(Object.keys(json).sort(), ['id', 's', 'v', 'ver']);
    // The first page ends on user 1000-ish; a hand-made cursor for another user still works only as a position.
    assert.equal((await as.call(group(a2).sa, 'GET', `${gpath(a2)}?cursor=${cursor}`)).status, 200);
  });
});

describe('GET /v1/groups/{groupId}/users: filters and search', () => {
  const usernames = async (query: string, actor: ObjectId = group(a2).sa) => (await listed(`${gpath(a2)}?${query}`, actor)).data.map((user) => user.username);

  it('filters by role (an employee without role counts as E), status and trash; the trash is hidden by default', async () => {
    assert.deepEqual(await usernames('role=SA'), ['user-007']);
    assert.deepEqual(await usernames('role=CA&sort=-username'), ['user-008']);
    assert.ok((await usernames('role=E&limit=200')).includes('user-1000'));
    assert.ok(!(await usernames('role=E&limit=200')).includes('user-1010'), 'the trashed user is hidden');
    assert.deepEqual(await usernames('status=disabled'), ['user-1009']);
    assert.ok(!(await usernames('status=active&limit=200')).includes('user-1009'));
    assert.deepEqual(await usernames('trashed=true'), ['user-1010']);
    assert.ok(!(await usernames('trashed=false&limit=200')).includes('user-1010'));
    assert.deepEqual(await usernames('trashed=true&role=SA'), []);
    // A stored user without a role is an employee for the filter too.
    const roleless = legacyUser(1101, { groupId: group(a2).groupId, dealerId: group(a2).dealerId, placeId: group(a2).ownPlaceId, placesId: [group(a2).ownPlaceId] });
    delete roleless['role'];
    await users().insertOne(roleless);
    try {
      assert.ok((await usernames('role=E&limit=200')).includes('user-1101'));
      assert.ok(!(await usernames('role=PA&limit=200')).includes('user-1101'));
    } finally {
      await users().deleteOne({ _id: roleless['_id'] });
    }
  });

  it('searches user name, first and last name, e-mail and telephone, ignoring case', async () => {
    assert.deepEqual(await usernames('q=SEARCH-ME'), ['search-me']);
    assert.deepEqual(await usernames('q=reg.ex'), ['search-me']);
    assert.deepEqual(await usernames('q=A(B'), ['search-me']);
    assert.deepEqual(await usernames('q=X%2BY%40EXAMPLE'), ['search-me']);
    assert.deepEqual(await usernames('q=0123%20456'), ['search-me']);
    assert.deepEqual(await usernames('q=page-upper'), ['Page-UPPER']);
    assert.deepEqual(await usernames('q=  user-007  '.replace(/ /g, '%20')), ['user-007']);
  });

  it('takes regular expression characters literally: they match only themselves and never fail', async () => {
    for (const text of ['.*', '.', '(', '[', ')', '\\', '^', '$', '?', '+', '|', '{1}', '[a-z]', '(?i)', '(a|b)*']) {
      const found = await usernames(`q=${encodeURIComponent(text)}&limit=200`);
      const stored: Document[] = await users().find({ groupId: group(a2).groupId, trash: { $ne: true } }).toArray();
      const expected = stored.filter((document: Document) =>
        ['userName', 'name', 'surname', 'email', 'telephone'].some((field) => typeof document[field] === 'string' && (document[field] as string).toLowerCase().includes(text.toLowerCase())),
      );
      assert.deepEqual(new Set(found), new Set(expected.map((document: Document) => document['userName'] as string)), text);
    }
    assert.deepEqual(await usernames('q=.*'), []);
  });

  it('applies the search and the filters together with the cursor', async () => {
    const all = await usernames('q=user-10&role=E&limit=200');
    const paged: string[] = [];
    let next: string | null = null;
    do {
      const reply = await as.call(group(a2).sa, 'GET', `${gpath(a2)}?q=user-10&role=E&limit=3${next === null ? '' : `&cursor=${next}`}`);
      paged.push(...reply.body.data.map((user: { username: string }) => user.username));
      next = reply.body.page.next;
    } while (next !== null);
    assert.deepEqual(paged, all);
    assert.ok(all.length >= 9);
  });

  it('cannot widen the scope with a search or a cursor: a CA never sees the SA, whatever he asks', async () => {
    const g = group(a1);
    const names = (await listed(`${gpath(a1)}?q=user&limit=200&role=SA`, g.ca)).data.map((user) => user.username);
    assert.deepEqual(names, []);
    assert.deepEqual((await listed(`${gpath(a1)}?sort=-username&limit=1`, g.ca)).data.map((user) => user.username), ['user-005']);
  });
});

describe('GET /v1/users: the transversal list', () => {
  const all = (query = '', actor: ObjectId = office.cluster.psa) => listed(`/users?limit=200${query}`, actor);

  it('gives the PSA every user, platform users included', async () => {
    const body = await all();
    const stored = await users().find({ trash: { $ne: true } }).toArray();
    assert.equal(body.data.length, stored.length);
    assert.deepEqual(new Set(body.data.map((user) => user.id)), new Set(stored.map((document) => hex(document['_id'] as ObjectId))));
    assert.ok(body.data.some((user) => user['role'] === 'PSA') && body.data.some((user) => user['role'] === 'D'));
  });

  it('filters by role, group and dealer, for the PSA', async () => {
    assert.deepEqual((await all('&role=PSA')).data.map((user) => user.username), ['user-002']);
    assert.deepEqual((await all('&role=D&sort=-username')).data.map((user) => user.username), ['user-500', 'user-001']);
    const byGroup = await all(`&groupId=${hex(group(a1).groupId)}`);
    assert.deepEqual(byGroup.data.map((user) => user.username), ['user-003', 'user-004', 'user-005', 'user-006']);
    // The `dealerId` of a user is the field stored on his document (the fixtures give every user the first dealer).
    const byDealer = await all(`&dealerId=${hex(office.cluster.dealerA)}&role=SA`);
    assert.deepEqual(byDealer.data.map((user) => user.username), ['user-003', 'user-007', 'user-011', 'user-015']);
    assert.deepEqual((await all(`&dealerId=${hex(office.cluster.dealerB)}&role=SA`)).data, []);
  });

  it('gives a dealer only the users of his groups, never the platform users or another dealer', async () => {
    const body = await all('', office.cluster.dealerA);
    const expected = await users()
      .find({ groupId: { $in: [group(a1).groupId, group(a2).groupId] }, role: { $in: ['SA', 'CA', 'PA', 'E', null] }, trash: { $ne: true } })
      .toArray();
    assert.deepEqual(new Set(body.data.map((user) => user.id)), new Set(expected.map((document) => hex(document['_id'] as ObjectId))));
    assert.ok(body.data.every((user) => ['SA', 'CA', 'PA', 'E'].includes(user['role'] as string)));
    assert.deepEqual((await all(`&groupId=${hex(group(a1).groupId)}`, office.cluster.dealerA)).data.length, 4);
    // Another dealer's group is just empty: a dealer cannot tell it exists.
    assert.deepEqual((await all(`&groupId=${hex(group(b1).groupId)}`, office.cluster.dealerA)).data, []);
    assert.deepEqual((await all('&role=PSA', office.cluster.dealerA)).data, []);
  });

  it('refuses the dealer filter to a dealer and the whole list to every other role', async () => {
    const forbidden = await as.call(office.cluster.dealerA, 'GET', `/users?dealerId=${hex(office.cluster.dealerA)}`);
    assert.deepEqual(as.failure(forbidden), { status: 403, code: 'FORBIDDEN', details: undefined });
    for (const actor of [group(a1).sa, group(a1).ca, group(a1).pa]) {
      assert.deepEqual(as.failure(await as.call(actor, 'GET', '/users')).code, 'FORBIDDEN');
    }
  });

  it('paginates and refuses what the group list refuses, with the same cursor rules', async () => {
    const full = (await all()).data.map((user) => user.id);
    const ids: string[] = [];
    let next: string | null = null;
    do {
      const reply = await as.call(office.cluster.psa, 'GET', `/users?limit=7&sort=-createdAt${next === null ? '' : `&cursor=${next}`}`);
      ids.push(...reply.body.data.map((user: { id: string }) => user.id));
      next = reply.body.page.next;
    } while (next !== null);
    assert.deepEqual(new Set(ids), new Set(full));
    assert.equal(ids.length, full.length);
    assert.equal((await as.call(office.cluster.psa, 'GET', '/users?groupId=zz')).status, 422);
    assert.equal((await as.call(office.cluster.psa, 'GET', '/users?cursor=zz')).status, 422);
  });
});

describe('GET /v1/groups/{groupId}/users: values of an unexpected type', () => {
  it('pages through users whose sort value is a number, a string for a date or too long, as if the value were missing, with no page repeated', async () => {
    const g = group(a1);
    const odd = (n: number, overrides: Document): Document => legacyUser(n, { role: 'E', groupId: g.groupId, dealerId: g.dealerId, placeId: g.ownPlaceId, placesId: [g.ownPlaceId], ...overrides });
    const added = [
      odd(1300, { surname: 42, insertDate: 'yesterday' }),
      odd(1301, { surname: 7.5, insertDate: 12345 }),
      odd(1302, { surname: 'x'.repeat(300), insertDate: D1 }),
      odd(1303, { surname: 'ö'.repeat(129), insertDate: D2 }),
      odd(1304, { surname: { nested: true }, insertDate: ['a'] }),
      odd(1305, { surname: 'Normal', insertDate: D1 }),
      odd(1306, { surname: 'ö'.repeat(128), insertDate: D1 }),
    ];
    await users().insertMany(added);
    try {
      const stored: Document[] = await users().find({ groupId: g.groupId, role: { $in: ['SA', 'CA', 'PA', 'E', null] }, trash: { $ne: true } }).toArray();
      const expected = (token: string): string[] => {
        const descending = token.startsWith('-');
        const field = token.replace('-', '') === 'username' ? 'userName' : token.replace('-', '') === 'lastName' ? 'surname' : 'insertDate';
        const key = (document: Document): string | number | null => {
          const raw: unknown = document[field];
          if (field === 'insertDate') {
            return raw instanceof Date ? raw.getTime() : null;
          }
          return typeof raw === 'string' && Buffer.byteLength(raw) <= 256 ? raw : null;
        };
        const compare = (a: Document, b: Document): number => {
          const [x, y] = [key(a), key(b)];
          const byKey = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
          return byKey !== 0 ? byKey : hex(a['_id'] as ObjectId) < hex(b['_id'] as ObjectId) ? -1 : 1;
        };
        return [...stored].sort((a, b) => (descending ? compare(b, a) : compare(a, b))).map((document) => hex(document['_id'] as ObjectId));
      };
      const walkAs = async (query: string): Promise<string[]> => {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const reply = await as.call(g.sa, 'GET', `${gpath(a1)}?${query}${cursor === null ? '' : `&cursor=${cursor}`}`);
          assert.equal(reply.status, 200, JSON.stringify(reply.body));
          ids.push(...reply.body.data.map((user: { id: string }) => user.id));
          cursor = reply.body.page.next;
        } while (cursor !== null);
        return ids;
      };
      for (const sort of ['lastName', '-lastName', 'createdAt', '-createdAt', 'username']) {
        for (const limit of [1, 2, 3]) {
          const ids = await walkAs(`sort=${sort}&limit=${String(limit)}`);
          assert.equal(new Set(ids).size, ids.length, `${sort}/${String(limit)} repeats nothing`);
          assert.deepEqual(ids, expected(sort), `${sort}/${String(limit)}`);
        }
      }
    } finally {
      await users().deleteMany({ _id: { $in: added.map((document) => document['_id']) } });
    }
  });
});
