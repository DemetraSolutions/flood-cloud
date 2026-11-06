import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { COLLECTIONS, USERS_OWNED_FIELDS, registeredCollectionNames, validateRegistry } from '../../src/db/collections.ts';
import { SESSIONS_INDEXES, SESSIONS_VALIDATOR } from '../../src/db/sessions-schema.ts';
import { DEALERS_INDEXES, DEALERS_VALIDATOR } from '../../src/db/dealers-schema.ts';
import { USER_CREDENTIALS_VALIDATOR } from '../../src/db/user-credentials-schema.ts';
import type { CollectionRegistry } from '../../src/db/collections.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

async function sourceFiles(dir: string = SRC): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []),
    ),
  );
  return nested.flat();
}

describe('collection registry', () => {
  it('registers the shared legacy collections (users writable on owned fields only) and the new ones with their indexes and validators', () => {
    assert.deepEqual(Object.keys(COLLECTIONS.common).sort(), ['activityEvents', 'countries', 'dealers', 'groups', 'rateLimits', 'sessions', 'userCredentials', 'users']);
    assert.deepEqual(Object.keys(COLLECTIONS.group).sort(), ['companies', 'contacts', 'contacts_groups', 'places', 'products', 'products_categories']);
    for (const [name, spec] of [...Object.entries(COLLECTIONS.common), ...Object.entries(COLLECTIONS.group)]) {
      const expected = ['activityEvents', 'dealers', 'rateLimits', 'sessions', 'userCredentials'].includes(name) ? 'new' : name === 'users' || name === 'groups' ? 'legacy-write' : 'legacy-read';
      assert.equal(spec.ownership, expected, name);
    }
    assert.deepEqual(
      COLLECTIONS.common.users.indexes.map((index) => index.name),
      ['groupId_1_role_1', 'dealerId_1'],
    );
    for (const index of COLLECTIONS.common.users.indexes) {
      assert.equal('unique' in index || 'expireAfterSeconds' in index, false, index.name);
    }
    assert.deepEqual([...COLLECTIONS.common.users.ownedFields].sort(), [...USERS_OWNED_FIELDS].sort());
    for (const field of ['name', 'surname', 'email', 'telephone', 'settings.language', 'settings.hiddenInStats', 'status', 'trash', 'role', 'groupId', 'dealerId', 'companyId', 'placeId', 'placesId', 'permissions.status', 'permissions.users.r', 'permissions.users.w', 'permissions.logs.r', 'permissions.stats.r', 'permissions.documents.w', 'description', 'avatar', 'pin', 'servicesId', 'shiftTime.status', 'shiftTime.weeksGeneric', 'shiftTime.daySpecial', 'permissions.apps.cash.status', 'permissions.apps.cash.sub.preblling', 'permissions.apps.cash.sub.automaticCash.glory.withdrawal', 'permissions.apps.cash.options.priceLists', 'password', 'tokens', 'userName', 'insertDate', 'updateDate']) {
      assert.ok(COLLECTIONS.common.users.ownedFields.includes(field), field);
    }
    // Containers are never replaced as a whole, `logs` has no write flag, and the keys the backend does not manage stay the legacy's.
    for (const field of ['shiftTime', 'permissions', 'permissions.apps', 'permissions.apps.cash', 'permissions.apps.cash.sub', 'permissions.logs.w', 'permissions.apps.cash.sub.productsStatus', 'permissions.apps.cash.options.service', 'permissions.hiddenInStats']) {
      assert.equal(COLLECTIONS.common.users.ownedFields.includes(field), false, field);
    }
    assert.equal(COLLECTIONS.common.userCredentials.validator, USER_CREDENTIALS_VALIDATOR);
    assert.deepEqual(
      COLLECTIONS.common.activityEvents.indexes.map((index) => index.name),
      ['at_-1__id_-1', 'groupId_1_at_-1__id_-1', 'actor.id_1_at_-1__id_-1', 'category_1_at_-1__id_-1', 'requestId_1', 'expiresAt_1'],
    );
    assert.deepEqual(COLLECTIONS.common.rateLimits.indexes, [{ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
    assert.equal(COLLECTIONS.common.sessions.validator, SESSIONS_VALIDATOR);
    assert.equal(COLLECTIONS.common.dealers.validator, DEALERS_VALIDATOR);
    assert.equal(COLLECTIONS.common.dealers.indexes, DEALERS_INDEXES);
    assert.equal(COLLECTIONS.common.sessions.indexes, SESSIONS_INDEXES);
    assert.deepEqual(
      SESSIONS_INDEXES.map(({ name, unique, expireAfterSeconds }) => [name, unique ?? false, expireAfterSeconds ?? null]),
      [['accessTokenHash_1', true, null], ['refreshTokenHash_1', true, null], ['previousRefreshHashes_1', false, null], ['userId_1_revokedAt_1', false, null], ['expiresAt_1', false, 0]],
    );
    assert.doesNotThrow(() => validateRegistry());
    assert.deepEqual([...registeredCollectionNames()].sort(), ['activityEvents', 'companies', 'contacts', 'contacts_groups', 'countries', 'dealers', 'groups', 'places', 'products', 'products_categories', 'rateLimits', 'sessions', 'userCredentials', 'users']);
  });

  it('accepts valid new, legacy-read and legacy-write entries', () => {
    const registry: CollectionRegistry = {
      common: {
        sessions: {
          ownership: 'new',
          indexes: [
            { name: 'token_unique', key: { tokenHash: 1 }, unique: true },
            { name: 'ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
          ],
        },
        users: { ownership: 'legacy-write', ownedFields: ['lastLoginAt'], indexes: [{ name: 'userName_1', key: { userName: 1 } }] },
      },
      group: { places: { ownership: 'legacy-read' } },
    };
    assert.doesNotThrow(() => validateRegistry(registry));
  });

  it('rejects violations of the coexistence rules, listing all of them', () => {
    const bad: CollectionRegistry = {
      common: {
        a: { ownership: 'legacy-write' },
        b: { ownership: 'legacy-write', ownedFields: [] },
        c: { ownership: 'new', ownedFields: ['x'] },
        d: { ownership: 'legacy-read', ownedFields: ['x'] },
        e: { ownership: 'legacy-read', indexes: [{ name: 'u', key: { x: 1 }, unique: true }] },
        f: { ownership: 'legacy-write', ownedFields: ['x'], indexes: [{ name: 't', key: { x: 1 }, expireAfterSeconds: 10 }] },
        g: { ownership: 'new', indexes: [{ name: ' ', key: { x: 1 } }] },
        h: { ownership: 'legacy-read', validator: { bsonType: 'object' } },
        i: { ownership: 'legacy-write', ownedFields: ['x'], validator: { bsonType: 'object' } },
        j: { ownership: 'new', validator: { bsonType: 'object' } },
      },
      group: {},
    };
    assert.throws(() => validateRegistry(bad), (error: Error) => {
      for (const where of ['common.a', 'common.b', 'common.c', 'common.d', 'common.e', 'common.f', 'common.g', 'common.h', 'common.i']) {
        assert.ok(error.message.includes(where), where);
      }
      assert.ok(!error.message.includes('common.j'));
      return true;
    });
  });

  it('every collection used in src is registered, by literal name', async () => {
    const known = registeredCollectionNames();
    // indexes.ts walks the registry itself, so its name is not a literal by construction. databases.ts has
    // exactly one non-literal use: the read-only analytics handle forwards the name its caller passes
    // (and that caller is checked here).
    const dynamicAllowed = new Map([[join(SRC, 'db', 'indexes.ts'), Infinity], [join(SRC, 'db', 'databases.ts'), 1]]);
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      const all = [...text.matchAll(/\.collection\(/g)].length;
      const literal = [...text.matchAll(/\.collection\(\s*(['"`])([^'"`$]*)\1\s*[,)]/g)];
      for (const match of literal) {
        assert.ok(known.has(match[2] as string), `${file}: collection "${match[2]}" is not in the registry`);
      }
      const dynamic = dynamicAllowed.get(file);
      if (dynamic === undefined) {
        assert.equal(literal.length, all, `${file}: collection names must be string literals`);
      } else {
        assert.ok(all - literal.length <= dynamic, `${file}: more non-literal collection names than expected`);
        if (dynamic === 1) {
          assert.equal(all - literal.length, 1, `${file}: the read-only handle is expected to be the single non-literal use`);
        }
      }
    }
  });

  it('no module outside src/db/databases.ts selects a database directly', async () => {
    const allowed = join(SRC, 'db', 'databases.ts');
    let seen = false;
    for (const file of await sourceFiles()) {
      const uses = /\.db\(/.test(await readFile(file, 'utf8'));
      if (file === allowed) {
        seen = uses;
      } else {
        assert.equal(uses, false, `${file} must obtain databases only from createDatabases`);
      }
    }
    assert.equal(seen, true, 'databases.ts is expected to be the single place');
  });
});
