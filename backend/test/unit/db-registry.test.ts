import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { COLLECTIONS, CONTACTS_OWNED_FIELDS, DOCUMENTS_OWNED_FIELDS, GROUPS_INSERT_ONLY_FIELDS, QUEUE_DOCUMENTS_OWNED_FIELDS, PRODUCTS_CATEGORIES_OWNED_FIELDS, PRODUCTS_CATEGORIES_OWNED_TREES, GROUPS_OWNED_FIELDS, SALES_OWNED_FIELDS, USERS_OWNED_FIELDS, WAREHOUSE_OWNED_FIELDS, registeredCollectionNames, validateRegistry } from '../../src/db/collections.ts';
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
    assert.deepEqual(Object.keys(COLLECTIONS.group).sort(), ['calendar', 'companies', 'contacts', 'contacts_groups', 'document_counters', 'documents', 'email_templates', 'fidelity_cards', 'fidelity_cards_movements', 'files', 'places', 'products', 'products_attributes', 'products_brands', 'products_categories', 'products_departments', 'sales', 'sales_tombstones', 'table_reservation', 'warehouse']);
    for (const [name, spec] of [...Object.entries(COLLECTIONS.common), ...Object.entries(COLLECTIONS.group)]) {
      const isMirror = ['companies', 'places'].includes(name) && COLLECTIONS.common[name as 'companies' | 'places'] === spec;
      const expected = isMirror
        ? 'mirror'
        : ['activityEvents', 'apiKeys', 'apiUsage', 'billingClosures', 'dealers', 'document_counters', 'idempotencyKeys', 'rateLimits', 'sales_tombstones', 'sessions', 'settings', 'storeActivationCodes', 'storeKeys', 'syncIssues', 'userCredentials'].includes(name)
          ? 'new'
          : name === 'users' || name === 'groups' || name === 'reserve_with_google' || name === 'tobaccos' || name === 'countries' || (['companies', 'contacts', 'contacts_groups', 'email_templates', 'fidelity_cards', 'fidelity_cards_movements', 'files', 'places', 'products', 'products_attributes', 'products_brands', 'products_categories', 'products_departments', 'sales', 'warehouse', 'documents'].includes(name) && !isMirror)
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
    // The contacts (step K1): the two containers are owned leaf by leaf, and what the legacy keeps dead or denormalized there is never owned.
    assert.deepEqual([...COLLECTIONS.group.contacts_groups.ownedFields].sort(), ['discountPercentage', 'insertDate', 'name', 'priceListId', 'updateDate']);
    assert.equal(COLLECTIONS.group.contacts.ownedFields, CONTACTS_OWNED_FIELDS);
    for (const field of ['fidelities', 'services', 'account.email', 'account.telephone', 'fattura_elettronica.pec', 'fattura_elettronica.richiedi_dati_ordine_acquisto', 'trash', 'trashDate', 'cGroupId', 'contactCode', 'companyLists']) {
      assert.ok(CONTACTS_OWNED_FIELDS.includes(field), field);
    }
    for (const field of ['account', 'account.password', 'account.tokens', 'password', 'tokens', 'cGroup', 'associatedCompany', 'fattura_elettronica', 'fidelities.points', 'fidelities.code']) {
      assert.equal(CONTACTS_OWNED_FIELDS.includes(field), false, field);
    }
    // The advanced cards (step F1): the code is written only at creation, the credit and the points only move with `$inc`, and the history is only inserted.
    assert.deepEqual([...COLLECTIONS.group.fidelity_cards.ownedFields].sort(), ['balance', 'cardTypeId', 'code', 'insertDate', 'pointsCollections', 'status', 'updateDate']);
    assert.deepEqual([...COLLECTIONS.group.fidelity_cards_movements.ownedFields].sort(), ['apiKeyId', 'balance', 'cardCode', 'cardId', 'date', 'points', 'pointsCollectionId', 'saleId', 'storeKeyId', 'type', 'userId']);
    // The sales (step VS4a): written in the shape of the legacy, on the owned fields, with the container of this backend; `status` (only to mark a sale gathered by a deferred invoice, step VS5) is owned, the unique key index is never declared here.
    assert.equal(COLLECTIONS.group.sales.ownership, 'legacy-write');
    assert.equal(COLLECTIONS.group.sales.ownedFields, SALES_OWNED_FIELDS);
    for (const field of ['userId', 'timestampId', 'customer', 'products', 'refund', 'fiscalState', 'sType', 'fiscalReceiptInfo', 'finalTotalCheckout', 'floodCloud', 'updateDate']) {
      assert.ok(SALES_OWNED_FIELDS.includes(field), field);
    }
    assert.ok(SALES_OWNED_FIELDS.includes('status'));
    for (const field of ['_id', 'floodCloud.key', 'metadata']) {
      assert.equal(SALES_OWNED_FIELDS.includes(field), false, field);
    }
    assert.equal('indexes' in COLLECTIONS.group.sales, false);
    for (const name of ['calendar', 'table_reservation'] as const) {
      assert.deepEqual(COLLECTIONS.group[name], { ownership: 'legacy-read' }, name);
    }
    // The invoices of the sales (step VS5): whole documents in the legacy shape, then only `sendStatus` changes; the queue record is the document plus the dealer and the fields of the sale, and nothing the consumer owns.
    assert.equal(COLLECTIONS.group.documents.ownership, 'legacy-write');
    assert.equal(COLLECTIONS.group.documents.ownedFields, DOCUMENTS_OWNED_FIELDS);
    for (const field of ['number', 'prefixSuffix', 'type', 'company', 'counterpart', 'records', 'saleId', 'saleTimestampId', 'fattura_elettronica', 'XML', 'sendStatus', 'groupId', 'insertDate']) {
      assert.ok(DOCUMENTS_OWNED_FIELDS.includes(field), field);
    }
    for (const field of ['_id', 'sent', 'hubId', 'error', 'worker', 'dealerId', 'sale']) {
      assert.equal(DOCUMENTS_OWNED_FIELDS.includes(field), false, field);
    }
    assert.deepEqual([...QUEUE_DOCUMENTS_OWNED_FIELDS].filter((field) => !DOCUMENTS_OWNED_FIELDS.includes(field)), ['dealerId', 'sale']);
    for (const field of ['sent', 'hubId', 'error', 'worker']) {
      assert.equal(QUEUE_DOCUMENTS_OWNED_FIELDS.includes(field), false, field);
    }
    assert.equal('indexes' in COLLECTIONS.group.documents, false);
    // The warehouse movements (step VS1): only inserted, in the legacy shape, with the origin, the operator and the store key; the unique index of the origin is created at run time and never declared.
    assert.equal(COLLECTIONS.group.warehouse.ownership, 'legacy-write');
    assert.equal(COLLECTIONS.group.warehouse.ownedFields, WAREHOUSE_OWNED_FIELDS);
    for (const field of ['type', 'rule', 'records', 'saleId', 'documentId', 'origin', 'userId', 'storeKeyId']) {
      assert.ok(WAREHOUSE_OWNED_FIELDS.includes(field), field);
    }
    assert.equal('indexes' in COLLECTIONS.group.warehouse, false);
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
    assert.deepEqual([...registeredCollectionNames()].sort(), ['activityEvents', 'apiKeys', 'apiUsage', 'billingClosures', 'calendar', 'companies', 'contacts', 'contacts_groups', 'countries', 'dealers', 'document_counters', 'documents', 'email_templates', 'fidelity_cards', 'fidelity_cards_movements', 'files', 'groups', 'idempotencyKeys', 'places', 'products', 'products_attributes', 'products_brands', 'products_categories', 'products_departments', 'rateLimits', 'reserve_with_google', 'sales', 'sales_tombstones', 'sessions', 'settings', 'storeActivationCodes', 'storeKeys', 'syncIssues', 'table_reservation', 'tobaccos', 'userCredentials', 'users', 'warehouse']);
  });

  it('registers the documents of the legacy send queue as written only with the fields this backend owns, with no index, and refuses anything else there', () => {
    assert.deepEqual(COLLECTIONS.queue, { documents: { ownership: 'legacy-write', ownedFields: QUEUE_DOCUMENTS_OWNED_FIELDS } });
    const bad: CollectionRegistry = {
      common: {},
      group: {},
      queue: {
        a: { ownership: 'legacy-write' },
        b: { ownership: 'legacy-read', indexes: [{ name: 'x_1', key: { x: 1 } }] },
        c: { ownership: 'legacy-read' },
        d: { ownership: 'legacy-write', ownedFields: ['x'] },
        e: { ownership: 'legacy-read', ownedFields: ['x'] },
        f: { ownership: 'new' },
        g: { ownership: 'legacy-write', ownedFields: [] },
      },
    };
    assert.throws(() => validateRegistry(bad), (error: Error) => {
      for (const where of ['queue.a', 'queue.b', 'queue.e', 'queue.f', 'queue.g']) {
        assert.ok(error.message.includes(where), where);
      }
      assert.ok(!error.message.includes('queue.c') && !error.message.includes('queue.d'));
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

  it('keeps the collections of the legacy queue out of the common and group databases, except the one name both have: `documents` is read from the queue only by the queue repository, through queue()', async () => {
    const queueNames = Object.keys(COLLECTIONS.queue);
    assert.deepEqual(queueNames, ['documents']);
    // The group database has a `documents` collection of its own (the invoices and receipts of the legacy): the contacts repository reads it, through the group access, to refuse the deletion of a contact a document names.
    const groupToo = queueNames.filter((name) => name in COLLECTIONS.group);
    assert.deepEqual(groupToo, ['documents']);
    assert.equal(queueNames.filter((name) => name in COLLECTIONS.common).length, 0);
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const name of queueNames) {
        const uses = [...text.matchAll(new RegExp(`(.{0,60})\\.collection(?:<[^>]*>)?\\(\\s*['"\`]${name}['"\`]`, 'g'))];
        const viaQueue = uses.filter((use) => use[1]!.includes('.queue()'));
        if (file.endsWith('modules/error-documents/error-documents.repository.ts')) {
          assert.ok(uses.length > 0 && viaQueue.length === uses.length, `${file}: "${name}" must be read through queue()`);
        } else {
          assert.equal(viaQueue.length, 0, `${file}: "${name}" of the queue is read only by the queue repository`);
          // The name of the group database, in the files that may read it.
          if (file.endsWith('modules/contacts/contacts.repository.ts')) {
            assert.ok(uses.length > 0 && uses.every((use) => /\bdb$/.test(use[1]!)), `${file}: "${name}" is read from the group database`);
          } else if (file.endsWith('modules/sales/sales.repository.ts')) {
            // The detail of a sale reads the state of sending of its invoice document (step VS6): one `findOne` in the group database.
            assert.equal(uses.length, 1, file);
            assert.ok(/groupDatabaseFor\(principal, access, databases\)$/.test(uses[0]![1]!), `${file}: "${name}" is read from the group database`);
          } else if (file.endsWith('modules/sales/sales.invoice.repository.ts')) {
            // The invoices of the sales (step VS5) are inserted in the group database (and only their `sendStatus` is moved there).
            assert.ok(uses.length > 0 && uses.every((use) => /groupDatabaseFor\(caller, access, databases\)$/.test(use[1]!)), `${file}: "${name}" is written in the group database`);
          } else if (file.endsWith('db/databases.ts')) {
            // The one way into the queue (step VS5): the inbox that inserts a record, built here and nowhere else.
            assert.equal(uses.length, 1);
            assert.ok(uses[0]![1]!.includes('queueDatabaseName(context)'));
          } else if (file.endsWith('modules/document-numbering/numbering.repository.ts') || file.endsWith('modules/document-numbering/numbering.indexes.ts')) {
            // The numbering (step VS3) finds the documents of a company in the group database and creates the two supporting indexes there (checked in the test of the numbering below).
            assert.ok(uses.length > 0, `${file}: "${name}" is read from the group database`);
          } else {
            assert.equal(uses.length, 0, `${file}: "${name}" is not read here`);
          }
        }
      }
    }
  });

  it('opens the advanced cards only in their repository, and only to read them in the contacts repository; never writes the history but by insertion', async () => {
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      const cards = [...text.matchAll(/\.collection(?:<[^>]*>)?\(\s*['"`]fidelity_cards['"`]\s*\)\s*\.(\w+)\(/g)].map((match) => match[1]);
      const any = [...text.matchAll(/\.collection(?:<[^>]*>)?\(\s*['"`]fidelity_cards['"`]/g)].length;
      const history = [...text.matchAll(/\.collection(?:<[^>]*>)?\(\s*['"`]fidelity_cards_movements['"`]/g)].length;
      if (file.endsWith('modules/contacts/contacts.repository.ts')) {
        assert.ok(any > 0 && cards.length === any && cards.every((method) => method === 'find' || method === 'findOne'), `${file}: the cards are only read`);
        assert.equal(history, 0);
      } else if (file.endsWith('modules/fidelity-cards/fidelity-cards.indexes.ts') || file.endsWith('modules/groups/onboarding.repository.ts')) {
        // Only the unique index on the code: the one the legacy creates on every group.
        assert.ok(!/\.collection\(\s*'fidelity_cards'\s*\)\s*\.(?!createIndex\()/.test(text) && !/fidelity_cards_movements/.test(text), `${file}: only the index of the code`);
      } else if (file.endsWith('modules/fidelity-cards/fidelity-cards.repository.ts')) {
        assert.ok(any > 0 && history > 0);
        assert.ok(!/history\(principal, access\)\s*\.(update|replace|findOneAndUpdate|bulkWrite)/.test(text), 'the history is never changed');
      } else {
        assert.equal(any + history, 0, `${file} does not open the cards`);
      }
    }
  });

  it('reads the legacy collections that name a contact only from the contacts repository, and never writes them', async () => {
    const names = ['sales', 'documents', 'calendar', 'table_reservation', 'warehouse'];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const name of names) {
        const any = [...text.matchAll(new RegExp(`\\.collection(?:<[^>]*>)?\\(\\s*['"\`]${name}['"\`]`, 'g'))];
        const found = [...text.matchAll(new RegExp(`\\.collection(?:<[^>]*>)?\\(\\s*['"\`]${name}['"\`]\\s*\\)\\s*\\.find\\(`, 'g'))];
        if (file.endsWith('modules/contacts/contacts.repository.ts')) {
          // Every occurrence, whatever follows it, is a `find`.
          assert.ok(any.length > 0 && found.length === any.length, `${file}: "${name}" is only found`);
        } else if (name === 'sales' && (file.endsWith('modules/sales/sales.repository.ts') || file.endsWith('modules/sales/sales.indexes.ts'))) {
          // The sales (step V1): the repository only reads them, the index guard only creates the index of the purchases of a customer (the one exception decided by the user).
          assert.equal(any.length, 1, file);
        } else if (name === 'sales' && file.endsWith('modules/public-sales/public-sales.repository.ts')) {
          // The sales of the public API (step VS4b): one accessor, only `find` and `findOne`.
          assert.equal(any.length, 1, file);
          assert.equal(/\.(?:insert|update|delete|replace|bulkWrite|aggregate|findOneAnd)/.test(text), false, `${file}: reads only`);
        } else if (name === 'sales' && (file.endsWith('modules/sales/sales.write.repository.ts') || file.endsWith('modules/sales/sales.key-index.ts'))) {
          // The writes of the sales (step VS4a): the repository of the writes reads, inserts, changes the owned fields and deletes a sale that is not fiscal; the guard of the key creates the unique index of `floodCloud.key` and the one of `timestampId`.
          assert.ok(any.length > 0, file);
        } else if (name === 'warehouse' && (file.endsWith('modules/stock/stock.repository.ts') || file.endsWith('modules/stock/stock.indexes.ts'))) {
          // The warehouse movements (step VS1): the repository of the stock reads them and inserts whole documents, the index guard creates the unique index of the origins.
          assert.ok(any.length > 0, file);
        } else if (name === 'documents' && (file.endsWith('modules/document-numbering/numbering.repository.ts') || file.endsWith('modules/document-numbering/numbering.indexes.ts'))) {
          // The numbering of the fiscal documents (step VS3): the repository only finds the highest number and progressive of a year (checked below), the index guard creates the two supporting indexes.
          assert.ok(any.length > 0, file);
        } else if (name === 'documents' && file.endsWith('modules/sales/sales.repository.ts')) {
          // The detail of a sale (step VS6): a single read of the document of its invoice.
          assert.equal(any.length, 1, file);
          assert.equal(found.length, 0, file);
        } else if (name === 'documents' && (file.endsWith('modules/sales/sales.invoice.repository.ts') || file.endsWith('db/databases.ts'))) {
          // The invoices of the sales (step VS5): the repository of the invoices inserts them and moves their `sendStatus` (checked below); `databases.ts` builds the inbox of the send queue.
          assert.ok(any.length > 0, file);
        } else if (!file.endsWith('modules/error-documents/error-documents.repository.ts')) {
          assert.equal(any.length, 0, `${file}: "${name}" is not used here`);
        }
      }
    }
  });

  it('only reads the sales: no write, no other index than the purchases of a customer, no other module opens them', async () => {
    const repository = await readFile(join(SRC, 'modules', 'sales', 'sales.repository.ts'), 'utf8');
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\b(insert|update|replace|delete|bulkWrite|createIndex|createIndexes|dropIndex|drop|rename|findOneAnd|createCollection|\$out|\$merge)/i.test(code(repository).replace(/\bupdateDate\b/g, '')), 'the repository of the sales only reads');
    const indexes = code(await readFile(join(SRC, 'modules', 'sales', 'sales.indexes.ts'), 'utf8'));
    assert.deepEqual([...indexes.matchAll(/\.(createIndex(?:es)?|dropIndex(?:es)?|insert\w*|update\w*|delete\w*|replace\w*|bulkWrite|drop|rename\w*)\(/g)].map((match) => match[1]), ['createIndex']);
    assert.ok(indexes.includes("createIndex({ ...SALES_CUSTOMER_INDEX.key }, { ...SALES_CUSTOMER_INDEX.options })"));
    // Only the sales module (the service takes the type of the guard), the composition root and the onboarding of a group (which uses the function of the index) reach the indexes of the sales.
    const users: string[] = [];
    for (const file of await sourceFiles()) {
      if (/sales\.indexes\.ts['"]/.test(await readFile(file, 'utf8'))) {
        users.push(relative(SRC, file).split('\\').join('/'));
      }
    }
    assert.deepEqual(users.sort(), ['composition.ts', 'modules/groups/onboarding.repository.ts', 'modules/sales/sales.service.ts']);
  });

  it('writes the invoice documents only from the repository of the invoices of the sales: an insert and the move of `sendStatus`, nothing else', async () => {
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const repository = code(await readFile(join(SRC, 'modules', 'sales', 'sales.invoice.repository.ts'), 'utf8'));
    assert.deepEqual([...repository.matchAll(/\.(insert\w*|update\w*|replace\w*|delete\w*|bulkWrite|findOneAnd\w+|createIndex\w*|drop\w*)\(/g)].map((match) => match[1]), ['insertOne', 'updateOne']);
    assert.ok(repository.includes("{ $set: { sendStatus: to } }") && repository.includes('sendStatus: from'));
    const writers: string[] = [];
    for (const file of await sourceFiles()) {
      if (/\.collection\(\s*'documents'\s*\)\s*\.(?:insert|update|replace|delete|bulkWrite|findOneAnd)/.test(code(await readFile(file, 'utf8'))) || /documents\(caller, access\)\s*\.(?:insert|update|replace|delete|bulkWrite|findOneAnd)/.test(code(await readFile(file, 'utf8')))) {
        writers.push(relative(SRC, file).split('\\').join('/'));
      }
    }
    // `db/databases.ts` is the inbox of the send queue (a database of its own, with the same collection name).
    assert.deepEqual(writers, ['db/databases.ts', 'modules/sales/sales.invoice.repository.ts']);
  });

  it('only reads the documents from the numbering, and writes only the counters of its own collection, with one atomic update', async () => {
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const repository = code(await readFile(join(SRC, 'modules', 'document-numbering', 'numbering.repository.ts'), 'utf8'));
    const documents = [...repository.matchAll(/\.collection\(\s*'documents'\s*\)\s*\.(\w+)\(/g)].map((match) => match[1]);
    assert.deepEqual(documents, ['find', 'find', 'find'], 'the documents are only found');
    assert.deepEqual([...repository.matchAll(/\.(insert\w*|update\w*|replace\w*|delete\w*|bulkWrite|findOneAnd\w+|createIndex\w*|drop\w*)\(/g)].map((match) => match[1]), ['findOneAndUpdate'], 'the only write is the atomic update of a counter');
    const counters = [...repository.matchAll(/\.collection\(\s*'document_counters'\s*\)/g)];
    assert.equal(counters.length, 2, 'the counters are found once and moved once');
    // Only the numbering module reaches the counters, and the indexes of the documents are created only by its guard.
    const reach = [];
    for (const file of await sourceFiles()) {
      if (/\.collection\(\s*'document_counters'/.test(code(await readFile(file, 'utf8')))) {
        reach.push(relative(SRC, file).split('\\').join('/'));
      }
    }
    assert.deepEqual(reach.sort(), ['modules/document-numbering/numbering.indexes.ts', 'modules/document-numbering/numbering.repository.ts']);
  });

  it('moves the stock of the products only from the repository of the stock service, with `$inc`, and only inserts the warehouse movements there', async () => {
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const file of await sourceFiles()) {
      const text = code(await readFile(file, 'utf8'));
      const quantity = /\.value`\]?/.test(text) && /quantity\.__/.test(text);
      assert.equal(quantity, file.endsWith('modules/stock/stock.repository.ts'), `${file}: only the stock repository writes the quantity of a storage`);
    }
    const repository = code(await readFile(join(SRC, 'modules', 'stock', 'stock.repository.ts'), 'utf8'));
    assert.ok(repository.includes('$inc: { [`quantity.__'));
    assert.ok(!/\$set|\$unset|replaceOne|findOneAnd|deleteOne|deleteMany|bulkWrite|\.drop\(/.test(repository), 'the stock repository only increments the stock and inserts the movements');
    assert.deepEqual([...repository.matchAll(/\.(insert\w*|update\w*)\(/g)].map((match) => match[1]), ['updateOne', 'insertOne']);
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
