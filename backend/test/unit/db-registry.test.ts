import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { COLLECTIONS, GROUPS_INSERT_ONLY_FIELDS, PRODUCTS_CATEGORIES_OWNED_FIELDS, PRODUCTS_CATEGORIES_OWNED_TREES, GROUPS_OWNED_FIELDS, USERS_OWNED_FIELDS, registeredCollectionNames, validateRegistry } from '../../src/db/collections.ts';
import { SESSIONS_INDEXES } from '../../src/db/sessions-schema.ts';
import { DEALERS_INDEXES } from '../../src/db/dealers-schema.ts';
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
  it('registers the shared legacy collections (users writable on owned fields only) and the new ones with their indexes', () => {
    assert.deepEqual(Object.keys(COLLECTIONS.common).sort(), ['activityEvents', 'apiKeys', 'apiUsage', 'billingClosures', 'companies', 'countries', 'dealers', 'groups', 'idempotencyKeys', 'places', 'rateLimits', 'reserve_with_google', 'sessions', 'settings', 'storeActivationCodes', 'storeKeys', 'syncIssues', 'tobaccos', 'userCredentials', 'users']);
    assert.deepEqual(Object.keys(COLLECTIONS.group).sort(), ['companies', 'contacts', 'contacts_groups', 'email_templates', 'files', 'places', 'products', 'products_attributes', 'products_brands', 'products_categories', 'products_departments']);
    for (const [name, spec] of [...Object.entries(COLLECTIONS.common), ...Object.entries(COLLECTIONS.group)]) {
      const isMirror = ['companies', 'places'].includes(name) && COLLECTIONS.common[name as 'companies' | 'places'] === spec;
      const expected = isMirror
        ? 'mirror'
        : ['activityEvents', 'apiKeys', 'apiUsage', 'billingClosures', 'dealers', 'idempotencyKeys', 'rateLimits', 'sessions', 'settings', 'storeActivationCodes', 'storeKeys', 'syncIssues', 'userCredentials'].includes(name)
          ? 'new'
          : name === 'users' || name === 'groups' || name === 'reserve_with_google' || name === 'tobaccos' || name === 'countries' || (['companies', 'email_templates', 'files', 'places', 'products', 'products_attributes', 'products_brands', 'products_categories', 'products_departments'].includes(name) && !isMirror)
            ? 'legacy-write'
            : 'legacy-read';
      assert.equal(spec.ownership, expected, name);
    }
    assert.deepEqual(
      COLLECTIONS.common.users.indexes.map((index) => index.name),
      ['groupId_1_role_1', 'dealerId_1'],
    );
    for (const index of COLLECTIONS.common.users.indexes) {
      assert.equal('unique' in index || 'expireAfterSeconds' in index, false, index.name);
    }
    assert.deepEqual([...COLLECTIONS.common.tobaccos.ownedFields].sort(), ['barcodes', 'category', 'code', 'description', 'name', 'numPieces', 'price', 'priceKg', 'shortName', 'unitWeight']);
    assert.deepEqual(COLLECTIONS.common.tobaccos.indexes.map((index) => index.name), ['name_1', 'code_1']);
    assert.deepEqual([...COLLECTIONS.common.countries.ownedFields].sort(), ['areas', 'code', 'insertDate', 'name', 'updateDate']);
    assert.equal('indexes' in COLLECTIONS.common.countries, false, 'no unique index on the code until the count of duplicates in production is done');
    assert.deepEqual([...COLLECTIONS.group.email_templates.ownedFields].sort(), ['html', 'insertDate', 'name', 'text', 'updateDate']);
    assert.deepEqual([...COLLECTIONS.group.products_departments.ownedFields].sort(), ['code', 'description', 'groupId', 'insertDate', 'medias', 'name', 'noDiscount', 'placesAvailability', 'secondaryFiscalPrinter', 'status', 'tax', 'trash', 'updateDate']);
    assert.deepEqual([...COLLECTIONS.group.products_brands.ownedFields].sort(), ['description', 'insertDate', 'medias', 'name', 'placesAvailability', 'status', 'updateDate']);
    assert.deepEqual([...COLLECTIONS.group.products_categories.ownedFields].sort(), [...PRODUCTS_CATEGORIES_OWNED_FIELDS].sort());
    for (const tree of PRODUCTS_CATEGORIES_OWNED_TREES) {
      assert.ok(COLLECTIONS.group.products_categories.ownedFields.includes(tree), tree);
    }
    // The containers are owned leaf by leaf, `medias` below its images, `trash` never.
    for (const field of ['integrations', 'roomsSettings', 'availability', 'tgm', 'trash', 'integrations.easyAppear']) {
      assert.equal(COLLECTIONS.group.products_categories.ownedFields.includes(field), false, field);
    }
    assert.deepEqual([...COLLECTIONS.group.products_attributes.ownedFields].sort(), ['attributes', 'insertDate', 'name', 'updateDate']);
    assert.deepEqual([...COLLECTIONS.common.users.ownedFields].sort(), [...USERS_OWNED_FIELDS].sort());
    for (const field of ['name', 'surname', 'email', 'telephone', 'settings.language', 'settings.theme', 'settings.hiddenInStats', 'status', 'trash', 'role', 'groupId', 'dealerId', 'companyId', 'placeId', 'placesId', 'permissions.status', 'permissions.users.r', 'permissions.users.w', 'permissions.logs.r', 'permissions.stats.r', 'permissions.documents.w', 'description', 'avatar', 'pin', 'servicesId', 'shiftTime.status', 'shiftTime.weeksGeneric', 'shiftTime.daySpecial', 'permissions.apps.cash.status', 'permissions.apps.cash.sub.preblling', 'permissions.apps.cash.sub.automaticCash.glory.withdrawal', 'permissions.apps.cash.options.priceLists', 'password', 'tokens', 'userName', 'insertDate', 'updateDate']) {
      assert.ok(COLLECTIONS.common.users.ownedFields.includes(field), field);
    }
    // Containers are never replaced as a whole, `logs` has no write flag, and the keys the backend does not manage stay the legacy's.
    for (const field of ['shiftTime', 'permissions', 'permissions.apps', 'permissions.apps.cash', 'permissions.apps.cash.sub', 'permissions.logs.w', 'permissions.apps.cash.sub.productsStatus', 'permissions.apps.cash.options.service', 'permissions.hiddenInStats']) {
      assert.equal(COLLECTIONS.common.users.ownedFields.includes(field), false, field);
    }
    assert.deepEqual(
      COLLECTIONS.common.activityEvents.indexes.map((index) => index.name),
      ['at_-1__id_-1', 'groupId_1_at_-1__id_-1', 'actor.id_1_at_-1__id_-1', 'category_1_at_-1__id_-1', 'action_1_at_-1', 'requestId_1', 'expiresAt_1'],
    );
    assert.deepEqual(COLLECTIONS.common.rateLimits.indexes, [{ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
    assert.equal(COLLECTIONS.common.dealers.indexes, DEALERS_INDEXES);
    assert.equal(COLLECTIONS.common.sessions.indexes, SESSIONS_INDEXES);
    assert.deepEqual(
      SESSIONS_INDEXES.map(({ name, unique, expireAfterSeconds }) => [name, unique ?? false, expireAfterSeconds ?? null]),
      [['accessTokenHash_1', true, null], ['refreshTokenHash_1', true, null], ['previousRefreshHashes_1', false, null], ['userId_1_revokedAt_1', false, null], ['expiresAt_1', false, 0]],
    );
    // The copies of the group documents: non-unique indexes only; the issues collection has a 180-day TTL.
    assert.deepEqual(COLLECTIONS.common.companies.indexes.map((index) => [index.name, index.key]), [['groupId_1__id_1', { groupId: 1, _id: 1 }], ['groupId_1_name_1', { groupId: 1, name: 1 }], ['groupId_1_status_1', { groupId: 1, status: 1 }], ['groupId_1_code_1', { groupId: 1, code: 1 }]]);
    assert.deepEqual(COLLECTIONS.common.places.indexes.map((index) => index.name), ['groupId_1__id_1', 'groupId_1_name_1', 'groupId_1_companyId_1', 'groupId_1_status_1']);
    for (const spec of [COLLECTIONS.common.companies, COLLECTIONS.common.places]) {
      assert.equal(spec.indexes.some((index) => 'unique' in index || 'expireAfterSeconds' in index), false);
    }
    assert.deepEqual(COLLECTIONS.common.syncIssues.indexes.map(({ name, key, expireAfterSeconds }) => [name, key, expireAfterSeconds ?? null]), [
      ['runId_1', { runId: 1 }, null],
      ['kind_1_detectedAt_-1', { kind: 1, detectedAt: -1 }, null],
      ['detectedAt_ttl', { detectedAt: 1 }, 180 * 86400],
    ]);
    assert.deepEqual(COLLECTIONS.common.storeKeys.indexes.map((index) => [index.name, 'unique' in index, 'expireAfterSeconds' in index ? index.expireAfterSeconds : null, 'partialFilterExpression' in index ? index.partialFilterExpression : null]), [
      ['keyHash_1', true, null, null],
      ['placeId_1_active', true, null, { status: 'active' }],
      ['groupId_1_placeId_1_activatedAt_-1', false, null, null],
      ['purgeAt_1', false, 0, null],
    ]);
    assert.deepEqual(COLLECTIONS.common.storeActivationCodes.indexes.map((index) => [index.name, 'unique' in index, 'expireAfterSeconds' in index ? index.expireAfterSeconds : null]), [['codeHash_1', true, null], ['placeId_1', true, null], ['expiresAt_1', false, 0]]);
    assert.doesNotThrow(() => validateRegistry());
    assert.deepEqual([...registeredCollectionNames()].sort(), ['activityEvents', 'apiKeys', 'apiUsage', 'billingClosures', 'companies', 'contacts', 'contacts_groups', 'countries', 'dealers', 'documents', 'email_templates', 'files', 'groups', 'idempotencyKeys', 'places', 'products', 'products_attributes', 'products_brands', 'products_categories', 'products_departments', 'rateLimits', 'reserve_with_google', 'sessions', 'settings', 'storeActivationCodes', 'storeKeys', 'syncIssues', 'tobaccos', 'userCredentials', 'users']);
  });

  it('registers the documents of the legacy send queue as read only, with no index, and refuses anything else there', () => {
    assert.deepEqual(COLLECTIONS.queue, { documents: { ownership: 'legacy-read' } });
    const bad: CollectionRegistry = {
      common: {},
      group: {},
      queue: {
        a: { ownership: 'legacy-write', ownedFields: ['x'] },
        b: { ownership: 'legacy-read', indexes: [{ name: 'x_1', key: { x: 1 } }] },
        c: { ownership: 'legacy-read' },
      },
    };
    assert.throws(() => validateRegistry(bad), (error: Error) => {
      for (const where of ['queue.a', 'queue.b']) {
        assert.ok(error.message.includes(where), where);
      }
      assert.ok(!error.message.includes('queue.c'));
      return true;
    });
    assert.deepEqual([...registeredCollectionNames({ common: { a: { ownership: 'legacy-read' } }, group: {}, queue: { q: { ownership: 'legacy-read' } } })].sort(), ['a', 'q']);
    assert.deepEqual([...registeredCollectionNames({ common: { a: { ownership: 'legacy-read' } }, group: {} })], ['a']);
  });

  it('keeps the api key of the group out of every field a $set can write: it is written only when a new customer is inserted', () => {
    assert.ok(GROUPS_INSERT_ONLY_FIELDS.includes('apiKey'));
    assert.deepEqual(GROUPS_INSERT_ONLY_FIELDS.filter((field) => (GROUPS_OWNED_FIELDS as readonly string[]).includes(field)), []);
    assert.ok(!(COLLECTIONS.common.groups.ownedFields as readonly string[]).includes('apiKey'));
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
      },
      group: {},
    };
    assert.throws(() => validateRegistry(bad), (error: Error) => {
      for (const where of ['common.a', 'common.b', 'common.c', 'common.d', 'common.e', 'common.f', 'common.g']) {
        assert.ok(error.message.includes(where), where);
      }
      return true;
    });
  });

  it('applies explicit rules to mirror collections', () => {
    assert.doesNotThrow(() => validateRegistry({ common: { copies: { ownership: 'mirror', indexes: [{ name: 'a_1', key: { a: 1 } }] } }, group: {} }));
    const bad: CollectionRegistry = {
      common: {
        a: { ownership: 'mirror', indexes: [{ name: 'u', key: { x: 1 }, unique: true }] },
        b: { ownership: 'mirror', indexes: [{ name: 't', key: { x: 1 }, expireAfterSeconds: 10 }] },
        d: { ownership: 'mirror', ownedFields: ['x'] },
        e: { ownership: 'mirror' },
      },
      group: { f: { ownership: 'mirror' } },
    };
    assert.throws(() => validateRegistry(bad), (error: Error) => {
      assert.match(error.message, /common\.a: unique and TTL indexes are forbidden on mirror collections \(u\)/);
      assert.match(error.message, /common\.b: unique and TTL indexes are forbidden on mirror collections \(t\)/);
      assert.match(error.message, /common\.d: ownedFields is allowed only on legacy-write/);
      assert.match(error.message, /group\.f: a mirror collection must live in the common database/);
      assert.ok(!error.message.includes('common.e'));
      return true;
    });
  });

  it('every collection used in src is registered, by literal name', async () => {
    const known = registeredCollectionNames();
    // indexes.ts walks the registry itself, so its name is not a literal by construction. databases.ts has
    // exactly one non-literal use: the read-only analytics handle forwards the name its caller passes
    // (and that caller is checked here).
    // references.repository.ts has one more: the target table of the group-database references (products, categories, contacts).
    const dynamicAllowed = new Map([
      [join(SRC, 'db', 'indexes.ts'), Infinity],
      [join(SRC, 'db', 'databases.ts'), 1],
      [join(SRC, 'modules', 'groups', 'catalogs', 'references.repository.ts'), 1],
      // The session-bound database of a transaction forwards the name its repository passes (the repositories are checked here).
      [join(SRC, 'db', 'session-databases.ts'), 1],
    ]);
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      const all = [...text.matchAll(/\.collection(?:<[^>]*>)?\(/g)].length;
      const literal = [...text.matchAll(/\.collection(?:<[^>]*>)?\(\s*(['"`])([^'"`$]*)\1\s*[,)]/g)];
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

  it('keeps the collections of the legacy queue out of the common and group databases: its names are used only by the queue repository, through queue()', async () => {
    const queueOnly = Object.keys(COLLECTIONS.queue).filter((name) => !(name in COLLECTIONS.common) && !(name in COLLECTIONS.group));
    assert.deepEqual(queueOnly, ['documents']);
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const name of queueOnly) {
        const uses = [...text.matchAll(new RegExp(`(.{0,60})\\.collection(?:<[^>]*>)?\\(\\s*['"\`]${name}['"\`]`, 'g'))];
        if (file.endsWith('modules/error-documents/error-documents.repository.ts')) {
          assert.ok(uses.length > 0 && uses.every((use) => use[1]!.includes('.queue()')), `${file}: "${name}" must be read through queue()`);
        } else {
          assert.equal(uses.length, 0, `${file}: "${name}" belongs to the queue database only`);
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
