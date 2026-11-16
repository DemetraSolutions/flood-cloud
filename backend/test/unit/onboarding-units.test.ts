import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { FEATURES } from '../../src/modules/groups/features.ts';
import { PROVIDERS } from '../../src/modules/groups/group.types.ts';
import { endOfDayInRome, endOfYearInRome, legacyTax, newDepartmentDocuments, newGroupApiKey, newGroupDocument } from '../../src/modules/groups/onboarding.documents.ts';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { groupCreationDatabase, groupDatabaseFor, issueGroupCreationAccess } from '../../src/shared/security/scope/group-access.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { validEnv } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';

const C0 = 'cluster0';

describe('the access to the group of a new customer', () => {
  const psa = principalOf('PSA', { userId: fixtureId('user', 2) });
  const dealer = principalOf('D', { userId: fixtureId('user', 3), dealerGroupIds: [] });
  const opened: Array<[string, string]> = [];
  const databases = { commonCluster: C0, group: (id: ObjectId, clusterId: string) => (opened.push([id.toHexString(), clusterId]), { name: id.toHexString() }) } as never;

  it('is issued to a PSA and to a dealer with a new id on the cluster of the common database, and opens that database only for them', () => {
    for (const principal of [psa, dealer]) {
      const access = issueGroupCreationAccess(principal, databases);
      assert.deepEqual([access.clusterId, access.crossGroup, Object.isFrozen(access), Object.values(access.features).some(Boolean)], [C0, true, true, false]);
      assert.equal((groupCreationDatabase(principal, access, databases) as unknown as { name: string }).name, access.groupId.toHexString());
    }
    assert.notDeepEqual(issueGroupCreationAccess(psa, databases).groupId, issueGroupCreationAccess(psa, databases).groupId);
  });

  it('is refused to whoever cannot create groups (SA, CA, PA, E)', () => {
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      assert.throws(() => issueGroupCreationAccess(principalOf(role), databases), /without the permission to create groups/, role);
    }
  });

  it('opens nothing else: not a look-alike, not a verified access of an existing group, not the access of another user, not another cluster', async () => {
    const existing = (await accessFor(psa, fixtureId('group', 1)))!;
    const access = issueGroupCreationAccess(psa, databases);
    const before = opened.length;
    assert.throws(() => groupCreationDatabase(psa, { ...access }, databases), /group creation access/);
    assert.throws(() => groupCreationDatabase(dealer, access, databases), /group creation access/);
    assert.throws(() => groupCreationDatabase(psa, existing, databases), /group creation access/);
    assert.throws(() => groupCreationDatabase(psa, access, { commonCluster: 'cluster9', group: () => ({}) } as never), /group creation access/);
    // And the creation access is not a verified one: it opens no group database through the door of the existing groups.
    assert.throws(() => groupDatabaseFor(psa, access, databases), /verified group access/);
    assert.equal(opened.length, before);
  });
});

describe('the documents of a new customer', () => {
  const now = new Date('2026-11-16T10:00:00.000Z');
  const groupId = new ObjectId();
  const ids = { priceList: 'pl', measureUnit: 'mu', loadRule: 'r1', unloadRule: 'r2', returnRule: 'r3' };
  const taxes = [
    { id: 't1', rate: 10, department: 1 },
    { id: 't2', rate: 4, department: 4 },
  ];

  it('builds the group with every key the readers need and the features of the form over the defaults', () => {
    const document = newGroupDocument({ id: groupId, name: 'G', dealerId: null, demo: false, features: { rooms: true, cash: false }, taxes, ids, filesHost: 'https://files.example.test', apiKey: 'k', now });
    const settings = document['settings'] as Document;
    assert.deepEqual(
      FEATURES.filter((feature) => settings[feature] === true),
      ['rooms', 'productsVariants'],
    );
    assert.equal(FEATURES.every((feature) => typeof settings[feature] === 'boolean'), true);
    assert.deepEqual(Object.keys(settings['integrations'] as Document), [...PROVIDERS]);
    assert.deepEqual([document['filesHost'], document['apiKey'], document['dealerId'], document['type'], document['places']], ['https://files.example.test', 'k', null, null, []]);
    assert.deepEqual(document['taxes'], taxes.map(legacyTax));
    assert.deepEqual(Object.keys(document['warehouseRules'] as Document), ['r1', 'r2', 'r3']);
    assert.equal('plan' in document, false);
    assert.deepEqual(newGroupDocument({ id: groupId, name: 'G', dealerId: groupId, demo: true, features: {}, taxes, ids, filesHost: '', apiKey: 'k', now })['dealerId'], groupId);
  });

  it('builds a department for each tax rate, with the code of its department and a copy of the tax', () => {
    const departments = newDepartmentDocuments(groupId, taxes, now);
    assert.deepEqual(departments.map((department) => [department['code'], department['tax'], (department['name'] as Document)['it'], department['groupId']]), [
      [1, legacyTax(taxes[0]!), 'Reparto 1', groupId],
      [4, legacyTax(taxes[1]!), 'Reparto 4', groupId],
    ]);
    assert.equal(new Set(departments.map((department) => (department['_id'] as ObjectId).toHexString())).size, 2);
    assert.deepEqual(legacyTax(taxes[0]!), { id: 't1', value: 10, department: 1, description: null, natura: null });
  });

  it('makes an api key of 256 random bits in hexadecimal', () => {
    const keys = new Set(Array.from({ length: 20 }, newGroupApiKey));
    assert.equal(keys.size, 20);
    for (const key of keys) {
      assert.match(key, /^[0-9a-f]{64}$/);
    }
  });

  it('ends the year at 23:59:59 in Rome, winter time, with the year of Italy', () => {
    assert.equal(endOfYearInRome(new Date('2026-06-15T12:00:00Z')).toISOString(), '2026-12-31T22:59:59.000Z');
    assert.equal(endOfYearInRome(new Date('2026-12-31T22:59:59Z')).toISOString(), '2026-12-31T22:59:59.000Z');
    // At 23:30 UTC of the last day it is already the next year in Rome.
    assert.equal(endOfYearInRome(new Date('2026-12-31T23:30:00Z')).toISOString(), '2027-12-31T22:59:59.000Z');
    assert.equal(endOfYearInRome(new Date('2027-01-01T00:30:00Z')).toISOString(), '2027-12-31T22:59:59.000Z');
  });
});

describe('the end of a day in Rome', () => {
  it('is 23:59:59 local: 21:59:59 UTC in summer time, 22:59:59 UTC in winter time, and on the days the time changes', () => {
    assert.equal(endOfDayInRome(new Date('2030-07-10T00:00:00Z')).toISOString(), '2030-07-10T21:59:59.000Z');
    assert.equal(endOfDayInRome(new Date('2030-12-31T00:00:00Z')).toISOString(), '2030-12-31T22:59:59.000Z');
    assert.equal(endOfDayInRome(new Date('2030-03-31T00:00:00Z')).toISOString(), '2030-03-31T21:59:59.000Z');
    assert.equal(endOfDayInRome(new Date('2030-10-27T00:00:00Z')).toISOString(), '2030-10-27T22:59:59.000Z');
  });
});

describe('GROUP_FILES_HOST', () => {
  const reasonOf = (value: string): string | undefined => {
    try {
      loadConfig(validEnv({ GROUP_FILES_HOST: value }));
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      return error.issues.find((issue) => issue.variable === 'GROUP_FILES_HOST')?.reason;
    }
    return undefined;
  };

  it('is empty when unset, and an https URL without trailing slash otherwise', () => {
    assert.equal(loadConfig(validEnv()).groupFilesHost, '');
    assert.equal(loadConfig(validEnv({ GROUP_FILES_HOST: '' })).groupFilesHost, '');
    assert.equal(loadConfig(validEnv({ GROUP_FILES_HOST: 'https://files.example.test' })).groupFilesHost, 'https://files.example.test');
    assert.equal(loadConfig(validEnv({ GROUP_FILES_HOST: 'https://files.example.test/base//' })).groupFilesHost, 'https://files.example.test/base');
  });

  it('refuses http, credentials, a query, a fragment and what is not a URL', () => {
    for (const bad of ['http://files.example.test', 'https://user:pass@files.example.test', 'https://files.example.test/?a=1', 'https://files.example.test/#x', 'files.example.test', 'ftp://x']) {
      assert.match(reasonOf(bad) ?? '', /must be an https URL without credentials, query or fragment/, bad);
    }
  });
});
