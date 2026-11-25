import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { computeChanges, MAX_STRING_LENGTH } from '../../src/shared/activity-log/changes.ts';

describe('computeChanges', () => {
  it('lists nothing for equal documents, including both undefined', () => {
    assert.deepEqual(computeChanges({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } }), []);
    assert.deepEqual(computeChanges(undefined, undefined), []);
    assert.deepEqual(computeChanges({}, {}), []);
  });

  it('reports changed, added and removed fields; absent is not null', () => {
    assert.deepEqual(computeChanges({ a: 1, gone: 'x', n: null }, { a: 2, added: true, n: null }), [
      { field: 'a', before: 1, after: 2 },
      { field: 'gone', before: 'x' },
      { field: 'added', after: true },
    ]);
    assert.deepEqual(computeChanges({ a: null }, {}), [{ field: 'a', before: null }]);
    assert.deepEqual(computeChanges({}, { a: null }), [{ field: 'a', after: null }]);
    assert.deepEqual(computeChanges({ a: undefined }, { a: null }), [{ field: 'a', after: null }]);
  });

  it('flattens nested objects with dotted paths and treats a creation or deletion as all fields', () => {
    assert.deepEqual(computeChanges({ a: { b: { c: 1, d: 2 } } }, { a: { b: { c: 1, d: 3 } } }), [{ field: 'a.b.d', before: 2, after: 3 }]);
    assert.deepEqual(computeChanges(undefined, { a: 1, b: { c: 2 } }), [
      { field: 'a', after: 1 },
      { field: 'b.c', after: 2 },
    ]);
    assert.deepEqual(computeChanges({ a: 1 }, undefined), [{ field: 'a', before: 1 }]);
    // A subtree absent on one side flattens on the other.
    assert.deepEqual(computeChanges({}, { s: { x: 1 } }), [{ field: 's.x', after: 1 }]);
  });

  it('compares whole the subtree below the fourth segment, and a value that changes kind', () => {
    const before = { a: { b: { c: { d: { e: 1 }, same: 1 } } } };
    const after = { a: { b: { c: { d: { e: 2 }, same: 1 } } } };
    assert.deepEqual(computeChanges(before, after), [{ field: 'a.b.c.d', before: { e: 1 }, after: { e: 2 } }]);
    // Key order inside a whole subtree is not a change.
    assert.deepEqual(computeChanges({ a: { b: { c: { d: { x: 1, y: 2 } } } } }, { a: { b: { c: { d: { y: 2, x: 1 } } } } }), []);
    assert.deepEqual(computeChanges({ a: { x: 1 } }, { a: 5 }), [{ field: 'a', before: { x: 1 }, after: 5 }]);
    assert.deepEqual(computeChanges({ a: null }, { a: { x: 1 } }), [{ field: 'a', before: null, after: { x: 1 } }]);
  });

  it('compares arrays whole', () => {
    assert.deepEqual(computeChanges({ t: [1, 2] }, { t: [1, 2] }), []);
    assert.deepEqual(computeChanges({ t: [1, 2] }, { t: [2, 1] }), [{ field: 't', before: [1, 2], after: [2, 1] }]);
    assert.deepEqual(computeChanges({}, { t: [{ a: 1 }] }), [{ field: 't', after: [{ a: 1 }] }]);
  });

  it('compares ObjectIds and dates by value and stores them as hex and ISO strings', () => {
    const id = new ObjectId();
    const other = new ObjectId();
    const date = new Date('2026-01-02T03:04:05.000Z');
    assert.deepEqual(computeChanges({ id, at: date }, { id: ObjectId.createFromHexString(id.toHexString()), at: new Date(date.getTime()) }), []);
    assert.deepEqual(computeChanges({ id, at: date }, { id: other, at: new Date('2026-02-01T00:00:00.000Z') }), [
      { field: 'id', before: id.toHexString(), after: other.toHexString() },
      { field: 'at', before: '2026-01-02T03:04:05.000Z', after: '2026-02-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(computeChanges({ ids: [id] }, { ids: [other] }), [{ field: 'ids', before: [id.toHexString()], after: [other.toHexString()] }]);
    assert.deepEqual(computeChanges({}, { at: new Date(Number.NaN) }), [{ field: 'at', after: 'Invalid Date' }]);
  });

  it('stores other driver values and bigints as text', () => {
    assert.deepEqual(computeChanges({}, { big: 10n, nested: [undefined] }), [
      { field: 'big', after: '10' },
      { field: 'nested', after: ['undefined'] },
    ]);
  });

  it('never stores the values of sensitive fields, whatever the depth', () => {
    const changes = computeChanges(
      {
        password: 'old',
        user: { pin: '1', tokens: ['a'], PasswordHash: 'x', name: 'n', note: 'a' },
        integrations: { stripe: { key: 'k1' } },
        settings: { integrations: { x: 1 }, email: { smtp: 'a' }, ok: 1 },
        fattura_elettronica: { user: 'u' },
        apiKey: 'k',
        legacyHashFingerprint: 'f',
      },
      {
        password: 'new',
        user: { pin: '2', tokens: ['b'], PasswordHash: 'y', name: 'm', note: 'b' },
        integrations: { stripe: { key: 'k2' } },
        settings: { integrations: { x: 2 }, email: { smtp: 'b' }, ok: 2 },
        fattura_elettronica: { user: 'v' },
        apiKey: 'k',
        legacyHashFingerprint: 'g',
      },
    );
    assert.deepEqual(changes, [
      { field: 'password', redacted: true },
      { field: 'user.pin', redacted: true },
      { field: 'user.tokens', redacted: true },
      { field: 'user.PasswordHash', redacted: true },
      { field: 'user.name', before: 'n', after: 'm' },
      { field: 'user.note', before: 'a', after: 'b' },
      { field: 'integrations', redacted: true },
      { field: 'settings.integrations', redacted: true },
      { field: 'settings.email', redacted: true },
      { field: 'settings.ok', before: 1, after: 2 },
      { field: 'fattura_elettronica', redacted: true },
      { field: 'legacyHashFingerprint', redacted: true },
    ]);
    assert.ok(!JSON.stringify(changes).match(/old|"new"|k1|k2/));
  });

  it('redacts a sensitive field set or removed, but not an unchanged one', () => {
    assert.deepEqual(computeChanges(undefined, { password: 'x' }), [{ field: 'password', redacted: true }]);
    assert.deepEqual(computeChanges({ password: 'x' }, {}), [{ field: 'password', redacted: true }]);
    assert.deepEqual(computeChanges({ password: 'x' }, { password: 'x' }), []);
  });

  it('accepts extra sensitive fields, by name and by prefix', () => {
    const changes = computeChanges({ secret: 1, vault: { a: 1, b: 1, c: 1 }, deep: { secret: 1 } }, { secret: 2, vault: { a: 2, b: 2, c: 2 }, deep: { secret: 2 } }, { sensitive: ['secret', 'vault.a', 'vault.b.'] });
    assert.deepEqual(changes, [
      { field: 'secret', redacted: true },
      { field: 'vault.a', redacted: true },
      { field: 'vault.b', redacted: true },
      { field: 'vault.c', before: 1, after: 2 },
      { field: 'deep.secret', redacted: true },
    ]);
  });

  it('cuts long strings and flags the change, also inside structures', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 50);
    const [change] = computeChanges({ s: 'a' }, { s: long });
    assert.equal(change?.truncated, true);
    assert.equal((change?.after as string).length, MAX_STRING_LENGTH);
    const [nested] = computeChanges({ t: [] }, { t: [{ a: long }] });
    assert.equal(nested?.truncated, true);
    const [short] = computeChanges({ s: 'a' }, { s: 'x'.repeat(MAX_STRING_LENGTH) });
    assert.equal(short?.truncated, undefined);
  });

  it('hides secrets inside values stored whole, keeping the rest', () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['settings', null, { email: { smtpPassword: 'p' } }],
      ['integrations', null, { provider: { apiSecret: 's' } }],
      ['integrations', 'a', 'b'],
      ['fattura_elettronica', 'a', 'b'],
    ];
    for (const [field, before, after] of cases) {
      const changes = computeChanges({ [field]: before }, { [field]: after });
      assert.equal(changes.length, 1, field);
      assert.ok(!JSON.stringify(changes).match(/smtpPassword|apiSecret|"p"|"s"|"a"|"b"/) || changes[0]?.redacted === true, field);
    }
    assert.deepEqual(computeChanges({ settings: null }, { settings: { email: { smtpPassword: 'p' }, theme: 'dark' } }), [
      { field: 'settings', before: null, after: { email: '[REDACTED]', theme: 'dark' } },
    ]);
    assert.deepEqual(computeChanges({ integrations: null }, { integrations: { provider: { apiSecret: 's' } } }), [{ field: 'integrations', redacted: true }]);
    assert.deepEqual(computeChanges({ sessions: [] }, { sessions: [{ token: 't', pin: '1', device: 'phone' }] }), [
      { field: 'sessions', before: [], after: [{ token: '[REDACTED]', pin: '[REDACTED]', device: 'phone' }] },
    ]);
    assert.deepEqual(computeChanges({ a: { b: { c: { d: { password: 'x', keep: 1 } } } } }, { a: { b: { c: { d: { password: 'y', keep: 1 } } } } }), [
      { field: 'a.b.c.d', before: { password: '[REDACTED]', keep: 1 }, after: { password: '[REDACTED]', keep: 1 } },
    ]);
  });

  it('keeps personal data in clear: only secrets are hidden', () => {
    assert.deepEqual(
      computeChanges(
        { email: 'a@x.it', name: 'Mario', phone: '1', surname: 'R', fiscalCode: 'F1', password: 'p', list: [] },
        { email: 'b@x.it', name: 'Luigi', phone: '2', surname: 'S', fiscalCode: 'F2', password: 'q', list: [{ name: 'N', email: 'e', token: 't' }] },
      ),
      [
        { field: 'email', before: 'a@x.it', after: 'b@x.it' },
        { field: 'name', before: 'Mario', after: 'Luigi' },
        { field: 'phone', before: '1', after: '2' },
        { field: 'surname', before: 'R', after: 'S' },
        { field: 'fiscalCode', before: 'F1', after: 'F2' },
        { field: 'password', redacted: true },
        { field: 'list', before: [], after: [{ name: 'N', email: 'e', token: '[REDACTED]' }] },
      ],
    );
  });

  it('matches a dotted sensitive entry anywhere in the path, also inside whole values', () => {
    const before = { places: [] as unknown[], a: { settings: { email: { host: 'h1' }, theme: 'x' } } };
    const after = { places: [{ name: 'P', settings: { email: { host: 'h2' }, theme: 'dark' } }], a: { settings: { email: { host: 'h2' }, theme: 'y' } } };
    assert.deepEqual(computeChanges(before, after), [
      { field: 'places', before: [], after: [{ name: 'P', settings: { email: '[REDACTED]', theme: 'dark' } }] },
      { field: 'a.settings.email', redacted: true },
      { field: 'a.settings.theme', before: 'x', after: 'y' },
    ]);
    assert.deepEqual(computeChanges({ x: { vault: { a: 1 } } }, { x: { vault: { a: 2 } } }, { sensitive: ['vault.a'] }), [{ field: 'x.vault.a', redacted: true }]);
    assert.equal(computeChanges({ settings: { other: 1 } }, { settings: { other: 2 } })[0]?.redacted, undefined);
  });

  it('treats every sensitive key name as sensitive at any depth', () => {
    for (const key of ['token', 'accessToken', 'tokenHash', 'clientSecret', 'smtpPassword', 'privateKey', 'apiSecret']) {
      assert.deepEqual(computeChanges({ [key]: 'old' }, { [key]: 'new' }), [{ field: key, redacted: true }], key);
      assert.deepEqual(computeChanges({ x: { [key]: 'old' } }, { x: { [key]: 'new' } }), [{ field: `x.${key}`, redacted: true }], key);
      assert.deepEqual(computeChanges({ list: [] }, { list: [{ [key]: 'v', ok: 1 }] }), [{ field: 'list', before: [], after: [{ [key]: '[REDACTED]', ok: 1 }] }], key);
    }
  });

  it('still reports a change of a secret hidden inside a whole value', () => {
    assert.equal(computeChanges({ l: [{ token: 'a' }] }, { l: [{ token: 'b' }] }).length, 1);
    assert.deepEqual(computeChanges({ l: [{ token: 'a' }] }, { l: [{ token: 'a' }] }), []);
  });
});
