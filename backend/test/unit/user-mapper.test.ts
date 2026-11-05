import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { OWNED_PERMISSION_MODULES, fromLegacy, toLegacyDocument, toLegacyUpdate, toResponse } from '../../src/modules/users/user.mapper.ts';
import type { LegacyUserDocument, UserChanges } from '../../src/modules/users/user.types.ts';
import { dirtyScope, encryptLegacy, fixtureId, legacyEncryptionKey, legacyUser } from '../helpers/legacy-fixtures.ts';

/** A legacy user with the SA role (no scope needed), unless the test says otherwise. */
const doc = (n: number, overrides: Document = {}): Document => legacyUser(n, { role: 'SA', ...overrides });
const read = (document: Document) => fromLegacy(document as LegacyUserDocument);
const kinds = (document: Document): string[] => read(document).anomalies.map((anomaly) => `${anomaly.kind}:${anomaly.field ?? ''}`);
const company = fixtureId('company', 1);
const place = fixtureId('place', 1);
const place2 = fixtureId('place', 2);
const group = fixtureId('group', 1);
const dealer = fixtureId('user', 1);

/** Replays a `$set`/`$unset` update on a copy of a document the way MongoDB does (dotted paths included). */
function apply(document: Document, update: { $set: Record<string, unknown>; $unset?: Record<string, ''> }): Document {
  // A BSON round trip is a deep copy that keeps ObjectId and Date.
  const result = BSON.deserialize(BSON.serialize(document));
  const walk = (path: string, write: (target: Document, key: string) => void): void => {
    const parts = path.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) {
      target[part] ??= {};
      target = target[part] as Document;
    }
    write(target, parts.at(-1)!);
  };
  for (const [path, value] of Object.entries(update.$set)) {
    walk(path, (target, key) => (target[key] = value));
  }
  for (const path of Object.keys(update.$unset ?? {})) {
    walk(path, (target, key) => delete target[key]);
  }
  return result;
}

describe('fromLegacy: a regular document', () => {
  it('maps every field of the domain model', () => {
    const document = doc(5, { role: 'CA', groupId: group, dealerId: dealer, companyId: company });
    const { user, anomalies } = read(document);
    assert.deepEqual(anomalies, []);
    assert.deepEqual(user, {
      id: fixtureId('user', 5).toHexString(),
      username: 'user-005',
      firstName: 'Name005',
      lastName: 'Surname005',
      email: 'user-005@example.test',
      phone: '+39000000005',
      role: 'CA',
      groupId: group.toHexString(),
      dealerId: dealer.toHexString(),
      companyIds: [company.toHexString()],
      placeIds: [],
      status: 'active',
      trashed: false,
      language: 'it',
      hiddenInStats: false,
      permissions: {
        status: true,
        modules: { groups: { r: false, w: false }, users: { r: false, w: false }, companies: { r: false, w: false }, places: { r: false, w: false }, logs: { r: false, w: false } },
        canManagePermissions: true,
      },
      createdAt: new Date('2024-01-15T10:00:00.000Z'),
      updatedAt: new Date('2024-01-15T10:00:00.000Z'),
    });
  });

  it('keeps the core module flags, drops the other modules and never maps cash permissions', () => {
    const { user } = read(doc(1, { role: 'PSA', permissions: { status: false, users: { r: true, w: true }, logs: { r: true }, products: { r: true, w: true }, apps: { cash: { status: true } } } }));
    assert.deepEqual(Object.keys(user.permissions.modules).sort(), [...OWNED_PERMISSION_MODULES].sort());
    assert.deepEqual(user.permissions.modules['users'], { r: true, w: true });
    assert.deepEqual(user.permissions.modules['logs'], { r: true, w: false });
    assert.equal(user.permissions.status, false);
    assert.equal(user.permissions.canManagePermissions, false);
    assert.equal(JSON.stringify(user).includes('apps'), false);
  });

  it('is not able to manage permissions when the role is E or invalid, whatever the matrix says', () => {
    assert.equal(read(doc(1, { role: 'E', permissions: { status: true } })).user.permissions.canManagePermissions, false);
    assert.equal(read(doc(1, { role: 'API', permissions: { status: true } })).user.permissions.canManagePermissions, false);
    assert.equal(read(doc(1, { role: 'SA', permissions: { status: true } })).user.permissions.canManagePermissions, true);
  });

  it('reads language and hiddenInStats from settings, with defaults', () => {
    assert.equal(read(doc(1, { settings: { language: 'en', hiddenInStats: true } })).user.language, 'en');
    assert.equal(read(doc(1, { settings: { language: 'en', hiddenInStats: true } })).user.hiddenInStats, true);
    for (const settings of [undefined, null, 'x', [], {}, { language: '' }, { language: 5 }]) {
      const { user, anomalies } = read(doc(1, { settings }));
      assert.equal(user.language, 'it');
      assert.equal(user.hiddenInStats, false);
      assert.deepEqual(anomalies, []);
    }
    assert.deepEqual(kinds(doc(1, { settings: { hiddenInStats: 'yes' } })), ['invalidType:settings.hiddenInStats']);
  });

  it('uses the dates of the document, or null', () => {
    const { user } = read(doc(1, { insertDate: undefined, updateDate: 'yesterday' }));
    assert.equal(user.createdAt, null);
    assert.equal(user.updatedAt, null);
  });
});

describe('fromLegacy: username', () => {
  it('takes userName, in second place username', () => {
    assert.equal(read(doc(1, { userName: 'Mario' })).user.username, 'Mario');
    assert.equal(read(doc(1, { userName: undefined, username: 'signup-name' })).user.username, 'signup-name');
    assert.equal(read(doc(1, { userName: '', username: 'signup-name' })).user.username, 'signup-name');
    assert.equal(read(doc(1, { userName: 'Mario', username: 'other' })).user.username, 'Mario');
  });

  it('reports a document without any username', () => {
    for (const overrides of [{ userName: undefined }, { userName: null, username: '' }, { userName: 5, username: [] }]) {
      const { user, anomalies } = read(doc(1, overrides));
      assert.equal(user.username, '');
      assert.deepEqual(anomalies, [{ kind: 'missingUsername', field: 'userName' }]);
    }
  });
});

describe('fromLegacy: role, status and trash', () => {
  it('maps the six roles', () => {
    for (const role of ['PSA', 'D', 'SA', 'CA', 'PA', 'E']) {
      assert.equal(read(doc(1, { role, companyId: company, placesId: [place] })).user.role, role);
    }
  });

  it('treats an absent role as E, without an anomaly', () => {
    for (const role of [undefined, null]) {
      const { user, anomalies } = read(doc(1, { role, placesId: [place] }));
      assert.equal(user.role, 'E');
      assert.deepEqual(anomalies, []);
    }
  });

  it('marks API and unknown roles as invalid and reports them', () => {
    for (const role of ['API', 'X', 'psa', '', 5, 'weird']) {
      const { user, anomalies } = read(doc(1, { role }));
      assert.equal(user.role, 'invalid', String(role));
      assert.deepEqual(anomalies, [{ kind: 'invalidRole', field: 'role' }]);
      assert.equal(user.permissions.canManagePermissions, false);
    }
  });

  it('maps a boolean status and treats anything else as disabled with an anomaly', () => {
    assert.equal(read(doc(1, { status: true })).user.status, 'active');
    assert.equal(read(doc(1, { status: false })).user.status, 'disabled');
    for (const status of ['true', 1, null, undefined, {}]) {
      const { user, anomalies } = read(doc(1, { status }));
      assert.equal(user.status, 'disabled', String(status));
      assert.deepEqual(anomalies, [{ kind: 'invalidStatus', field: 'status' }]);
    }
  });

  it('maps trash to trashed, only a true value trashing', () => {
    assert.equal(read(doc(1, { trash: true })).user.trashed, true);
    assert.equal(read(doc(1, { trash: false })).user.trashed, false);
    for (const trash of [undefined, null]) {
      assert.deepEqual(read(doc(1, { trash })).anomalies, []);
      assert.equal(read(doc(1, { trash })).user.trashed, false);
    }
    assert.deepEqual(kinds(doc(1, { trash: 'true' })), ['invalidType:trash']);
    assert.equal(read(doc(1, { trash: 'true' })).user.trashed, false);
  });
});

describe('fromLegacy: scope (D-08) and the dirty scopes of production', () => {
  it('unions placeId and placesId and keeps the order and no duplicates', () => {
    const { user } = read(doc(1, { role: 'PA', placeId: place2, placesId: [place, place2, place] }));
    assert.deepEqual(user.placeIds, [place2.toHexString(), place.toHexString()]);
  });

  it('reads the dirty scopes of every role without anomalies', () => {
    for (const role of ['SA', 'E', 'PA', 'CA'] as const) {
      const { user, anomalies } = read(doc(1, { role, ...dirtyScope(role, { companyId: company, placeId: place }) }));
      assert.deepEqual(anomalies, [], role);
      assert.equal(user.companyIds.length, role === 'SA' || role === 'CA' ? 1 : 0);
      assert.equal(user.placeIds.length, 1);
    }
  });

  it('reports references that are not ObjectIds and ignores them', () => {
    const { user, anomalies } = read(doc(1, { role: 'PA', groupId: group.toHexString(), dealerId: 'x', companyId: company.toHexString(), placeId: 'p', placesId: [place, 'not-an-id'] }));
    assert.equal(user.groupId, null);
    assert.equal(user.dealerId, null);
    assert.deepEqual(user.companyIds, []);
    assert.deepEqual(user.placeIds, [place.toHexString()]);
    assert.deepEqual(anomalies.map((a) => a.field).sort(), ['companyId', 'dealerId', 'groupId', 'placeId', 'placesId']);
    assert.ok(anomalies.every((a) => a.kind === 'invalidReference'));
    assert.deepEqual(kinds(doc(1, { role: 'E', placesId: 'single' })), ['invalidReference:placesId', 'missingScope:placesId']);
  });

  it('reports a role without the scope it needs', () => {
    assert.deepEqual(kinds(doc(1, { role: 'CA' })), ['missingScope:companyId']);
    assert.deepEqual(kinds(doc(1, { role: 'PA' })), ['missingScope:placesId']);
    assert.deepEqual(kinds(doc(1, { role: 'E', placesId: undefined })), ['missingScope:placesId']);
    for (const role of ['PSA', 'D', 'SA']) {
      assert.deepEqual(kinds(doc(1, { role })), []);
    }
  });
});

describe('fromLegacy: personal data (D-05)', () => {
  it('reads plain data as is and empty values as null (no anomaly)', () => {
    const { user, anomalies } = read(doc(1, { email: '', telephone: undefined, name: null, surname: '' }));
    assert.deepEqual([user.email, user.phone, user.firstName, user.lastName], [null, null, null, null]);
    assert.deepEqual(anomalies, []);
  });

  it('does not decrypt values in the legacy format: null plus an anomaly', () => {
    const key = legacyEncryptionKey();
    const document = doc(1, {
      email: encryptLegacy('legacy-mail@example.test', key),
      telephone: encryptLegacy('+390000000', key),
      name: encryptLegacy('Legacy', key),
      surname: encryptLegacy('x'.repeat(40), key),
    });
    const { user, anomalies } = read(document);
    assert.deepEqual([user.email, user.phone, user.firstName, user.lastName], [null, null, null, null]);
    assert.deepEqual(anomalies.map((a) => `${a.kind}:${a.field}`).sort(), ['encryptedPersonalData:email', 'encryptedPersonalData:name', 'encryptedPersonalData:surname', 'encryptedPersonalData:telephone']);
    assert.equal(JSON.stringify(user).includes(String(document['email'])), false);
  });

  it('keeps hex-looking text that is not in the encrypted format', () => {
    assert.equal(read(doc(1, { name: 'abcdef' })).user.firstName, 'abcdef');
    assert.equal(read(doc(1, { name: `${'a'.repeat(31)}$${'b'.repeat(32)}` })).user.firstName, `${'a'.repeat(31)}$${'b'.repeat(32)}`);
  });

  it('reports a non-text value and reads it as null', () => {
    const { user, anomalies } = read(doc(1, { telephone: 12345 }));
    assert.equal(user.phone, null);
    assert.deepEqual(anomalies, [{ kind: 'invalidType', field: 'telephone' }]);
  });
});

describe('fromLegacy: secrets never come out', () => {
  it('maps nothing of password, pin, tokens, apps, services, shift time or avatar, whatever their values', () => {
    const sentinel = 'SENTINEL-SECRET-VALUE';
    const document = doc(1, {
      password: sentinel,
      pin: sentinel,
      tokens: [sentinel, { token: sentinel }],
      avatar: `data:image/png;base64,${sentinel}`,
      servicesId: [fixtureId('user', 9)],
      shiftTime: 99,
      description: sentinel,
      permissions: { status: true, users: { r: true, w: true }, apps: { cash: { status: sentinel, sub: sentinel } } },
    });
    const { user, anomalies } = read(document);
    assert.equal(JSON.stringify(user).includes(sentinel), false);
    assert.equal(JSON.stringify(anomalies).includes(sentinel), false);
    assert.equal(JSON.stringify(toResponse(user)).includes(sentinel), false);
    for (const field of ['password', 'pin', 'tokens', 'avatar', 'servicesId', 'shiftTime', 'description', 'apps']) {
      assert.equal(JSON.stringify(user).includes(`"${field}"`), false, field);
    }
  });
});

describe('toLegacyUpdate', () => {
  const NOW = new Date('2026-11-02T10:00:00.000Z');

  it('writes only updateDate for no change', () => {
    assert.deepEqual(toLegacyUpdate({}, NOW), { $set: { updateDate: NOW } });
    assert.ok(toLegacyUpdate({}).$set['updateDate'] instanceof Date);
  });

  it('translates the profile fields to the legacy names', () => {
    const update = toLegacyUpdate(
      { username: 'new-name', firstName: 'Ann', lastName: 'Lee', email: 'ann@example.test', phone: '+39 06', language: 'en', hiddenInStats: true, status: 'disabled', trashed: true, role: 'PA', groupId: group.toHexString(), dealerId: dealer.toHexString() },
      NOW,
    );
    assert.deepEqual(update, {
      $set: {
        userName: 'new-name',
        name: 'Ann',
        surname: 'Lee',
        email: 'ann@example.test',
        telephone: '+39 06',
        'settings.language': 'en',
        'settings.hiddenInStats': true,
        status: false,
        trash: true,
        role: 'PA',
        groupId: group,
        dealerId: dealer,
        updateDate: NOW,
      },
    });
    assert.equal(toLegacyUpdate({ status: 'active' }, NOW).$set['status'], true);
    assert.deepEqual(toLegacyUpdate({ groupId: null, dealerId: null }, NOW).$set, { groupId: null, dealerId: null, updateDate: NOW });
  });

  it('removes a personal field instead of writing null', () => {
    const update = toLegacyUpdate({ firstName: null, lastName: null, email: null, phone: null }, NOW);
    assert.deepEqual(update, { $set: { updateDate: NOW }, $unset: { name: '', surname: '', email: '', telephone: '' } });
  });

  it('writes or removes the legacy password hash', () => {
    assert.deepEqual(toLegacyUpdate({ password: 'a'.repeat(128) }, NOW), { $set: { password: 'a'.repeat(128), updateDate: NOW } });
    assert.deepEqual(toLegacyUpdate({ password: null }, NOW), { $set: { updateDate: NOW }, $unset: { password: '' } });
  });

  it('aligns the legacy scope fields (D-08): first company, first place, all places', () => {
    const update = toLegacyUpdate({ companyIds: [company.toHexString()], placeIds: [place.toHexString(), place2.toHexString()] }, NOW);
    assert.deepEqual(update.$set, { companyId: company, placeId: place, placesId: [place, place2], updateDate: NOW });
    assert.ok(update.$set['companyId'] instanceof ObjectId);
    assert.deepEqual(toLegacyUpdate({ companyIds: [], placeIds: [] }, NOW).$set, { companyId: null, placeId: null, placesId: [], updateDate: NOW });
  });

  it('writes the matrix with targeted flags and never replaces permissions or touches apps', () => {
    const update = toLegacyUpdate({ permissions: { status: true, modules: { users: { r: true, w: false }, logs: { r: true } } } }, NOW);
    assert.deepEqual(update.$set, { 'permissions.status': true, 'permissions.users.r': true, 'permissions.users.w': false, 'permissions.logs.r': true, updateDate: NOW });
    assert.equal(Object.keys(update.$set).includes('permissions'), false);
    assert.deepEqual(toLegacyUpdate({ permissions: {} }, NOW).$set, { updateDate: NOW });
    assert.deepEqual(toLegacyUpdate({ permissions: { modules: { users: {} } } }, NOW).$set, { updateDate: NOW });
  });

  it('refuses permission modules outside the core allowlist, apps included', () => {
    for (const module of ['apps', 'products', '__proto__', 'constructor', 'apps.cash']) {
      assert.throws(() => toLegacyUpdate({ permissions: { modules: { [module]: { r: true } } } }, NOW), /not in the core allowlist/, module);
    }
  });

  it('never writes the API role or any other that is not one of the six', () => {
    for (const role of ['API', 'invalid', 'psa', '']) {
      assert.throws(() => toLegacyUpdate({ role: role as never }, NOW), /not one of the six roles/, role);
    }
  });

  it('refuses ids that are not hexadecimal', () => {
    assert.throws(() => toLegacyUpdate({ groupId: 'zz' }, NOW));
    assert.throws(() => toLegacyUpdate({ placeIds: ['zz'] }, NOW));
  });

  it('only produces fields the registry says the backend owns, for every kind of change', () => {
    const everything: UserChanges = {
      username: 'u', firstName: 'a', lastName: 'b', email: 'e@x.it', phone: '1', role: 'SA', groupId: group.toHexString(), dealerId: dealer.toHexString(),
      companyIds: [company.toHexString()], placeIds: [place.toHexString()], status: 'active', trashed: false, language: 'it', hiddenInStats: false,
      permissions: { status: true, modules: Object.fromEntries(OWNED_PERMISSION_MODULES.map((module) => [module, { r: true, w: true }])) },
    };
    const owned = new Set(COLLECTIONS.common.users.ownedFields);
    for (const changes of [everything, { firstName: null, lastName: null, email: null, phone: null }, {}]) {
      const update = toLegacyUpdate(changes, NOW);
      assert.deepEqual(Object.keys(update).filter((key) => key !== '$set' && key !== '$unset'), []);
      for (const field of [...Object.keys(update.$set), ...Object.keys(update.$unset ?? {})]) {
        assert.ok(owned.has(field), `${field} is not an owned field`);
      }
      assert.equal(Object.keys(update.$set).some((field) => Object.hasOwn(update.$unset ?? {}, field)), false);
    }
  });

  it('round trips: a read document, changed through the mapper and read again, shows the change and keeps the rest', () => {
    const document = doc(7, { role: 'PA', groupId: group, dealerId: dealer, companyId: company, placeId: place, placesId: [place], email: '', insertDate: new Date('2024-01-01T00:00:00.000Z') });
    const before = read(document).user;
    const changes: UserChanges = {
      firstName: 'Changed', email: 'new@example.test', phone: null, status: 'disabled', trashed: true, language: 'en', hiddenInStats: true,
      placeIds: [place2.toHexString(), place.toHexString()], companyIds: [],
      permissions: { status: false, modules: { users: { r: true, w: false }, places: { w: true } } },
    };
    const written = apply(document, toLegacyUpdate(changes, NOW));
    const after = read(written);
    assert.deepEqual(after.anomalies, []);
    assert.deepEqual(after.user, {
      ...before,
      firstName: 'Changed',
      email: 'new@example.test',
      phone: null,
      status: 'disabled',
      trashed: true,
      language: 'en',
      hiddenInStats: true,
      placeIds: [place2.toHexString(), place.toHexString()],
      companyIds: [],
      permissions: { ...before.permissions, status: false, canManagePermissions: false, modules: { ...before.permissions.modules, users: { r: true, w: false }, places: { r: false, w: true } } },
      updatedAt: NOW,
    });
    // The legacy-only data of the document is untouched.
    for (const field of ['password', 'pin', 'tokens', 'servicesId', 'shiftTime', 'description']) {
      assert.deepEqual(written[field], document[field], field);
    }
    assert.deepEqual((written['permissions'] as Document)['apps'], (document['permissions'] as Document)['apps']);
    assert.deepEqual((written['permissions'] as Document)['products'], { r: true, w: false });
    assert.equal(written['name'], 'Changed');
    assert.equal('telephone' in written, false);
  });
});

describe('toResponse', () => {
  it('exposes exactly the allowlisted fields, with ISO dates and string ids', () => {
    const { user } = read(doc(3, { role: 'PA', groupId: group, dealerId: dealer, placesId: [place] }));
    const response = toResponse(user);
    assert.deepEqual(Object.keys(response).sort(), [
      'companyIds', 'createdAt', 'dealerId', 'email', 'firstName', 'groupId', 'hiddenInStats', 'id', 'language', 'lastName', 'permissions', 'phone', 'placeIds', 'role', 'status', 'trashed', 'updatedAt', 'username',
    ]);
    assert.deepEqual(Object.keys(response.permissions).sort(), ['canManagePermissions', 'modules', 'status']);
    assert.equal(response.createdAt, '2024-01-15T10:00:00.000Z');
    assert.equal(response.id, fixtureId('user', 3).toHexString());
    assert.equal(typeof response.groupId, 'string');
    assert.deepEqual(response.placeIds, [place.toHexString()]);
    assert.notEqual(response.placeIds, user.placeIds);
    assert.equal(JSON.parse(JSON.stringify(response)).createdAt, response.createdAt);
  });

  it('keeps null dates and shows an invalid role as such', () => {
    const response = toResponse(read(doc(3, { role: 'API', insertDate: undefined, updateDate: undefined })).user);
    assert.equal(response.createdAt, null);
    assert.equal(response.updatedAt, null);
    assert.equal(response.role, 'invalid');
  });

  it('carries no secret even when the document is full of them', () => {
    const sentinel = 'SENTINEL-SECRET-VALUE';
    const text = JSON.stringify(toResponse(read(doc(3, { password: sentinel, pin: sentinel, tokens: [{ token: sentinel }], permissions: { apps: { cash: { status: sentinel } } } })).user));
    assert.equal(text.includes(sentinel), false);
  });
});

describe('toLegacyDocument', () => {
  const NOW = new Date('2026-11-05T09:00:00.000Z');
  const modules = { groups: { r: false, w: false }, users: { r: true, w: true }, companies: { r: true, w: false }, places: { r: true, w: true }, logs: { r: true, w: false } };
  const base = {
    id: fixtureId('user', 700),
    username: 'new.user',
    firstName: 'Ada',
    lastName: null,
    email: null,
    phone: '+39 06 1234',
    role: 'CA' as const,
    groupId: group.toHexString(),
    dealerId: dealer.toHexString(),
    companyIds: [company.toHexString()],
    placeIds: [place.toHexString(), place2.toHexString()],
    status: 'active' as const,
    language: 'it',
    permissions: { status: true, modules },
    legacyPasswordHash: 'a'.repeat(128),
  };

  it('builds a complete legacy document of the owned fields, with the types the legacy writes', () => {
    const document = toLegacyDocument(base, NOW);
    assert.deepEqual(Object.keys(document).sort(), [
      '_id', 'companyId', 'dealerId', 'groupId', 'insertDate', 'name', 'password', 'permissions', 'placeId', 'placesId', 'role', 'settings', 'status', 'telephone', 'tokens', 'trash', 'updateDate', 'userName',
    ]);
    assert.deepEqual(document, {
      _id: base.id,
      userName: 'new.user',
      name: 'Ada',
      telephone: '+39 06 1234',
      password: 'a'.repeat(128),
      role: 'CA',
      groupId: group,
      dealerId: dealer,
      companyId: company,
      placeId: place,
      placesId: [place, place2],
      permissions: { status: true, groups: { r: false, w: false }, users: { r: true, w: true }, companies: { r: true, w: false }, places: { r: true, w: true }, logs: { r: true, w: false } },
      settings: { language: 'it', hiddenInStats: false },
      status: true,
      trash: false,
      tokens: [],
      insertDate: NOW,
      updateDate: NOW,
    });
    const owned = new Set(COLLECTIONS.common.users.ownedFields);
    const leaves = (value: Document, prefix = ''): string[] =>
      Object.entries(value).flatMap(([key, item]) => (item !== null && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype ? leaves(item as Document, `${prefix}${key}.`) : [`${prefix}${key}`]));
    assert.deepEqual(leaves(document).filter((path) => path !== '_id' && !owned.has(path)), []);
    assert.deepEqual(read(document).anomalies, []);
  });

  it('leaves out the null personal values and the legacy hash when there is none, and writes null scope references', () => {
    const document = toLegacyDocument({ ...base, firstName: null, phone: null, legacyPasswordHash: null, role: 'SA', companyIds: [], placeIds: [], groupId: null, dealerId: null, status: 'disabled' }, NOW);
    for (const field of ['name', 'surname', 'email', 'telephone', 'password']) {
      assert.ok(!(field in document), field);
    }
    assert.deepEqual([document['companyId'], document['placeId'], document['placesId'], document['groupId'], document['dealerId'], document['status']], [null, null, [], null, null, false]);
  });

  it('refuses a role that is not one of the six, a module outside the core and an id that is not hexadecimal', () => {
    assert.throws(() => toLegacyDocument({ ...base, role: 'API' as never }, NOW), /not one of the six roles/);
    assert.throws(() => toLegacyDocument({ ...base, permissions: { status: false, modules: { products: { r: true, w: true } } } }, NOW), /not in the core allowlist/);
    assert.throws(() => toLegacyDocument({ ...base, groupId: 'zz' }, NOW));
  });
});
