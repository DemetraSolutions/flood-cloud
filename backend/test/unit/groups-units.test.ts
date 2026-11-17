import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { GROUPS_OWNED_CATALOGS, GROUPS_OWNED_FIELDS } from '../../src/db/collections.ts';
import { FEATURES, FEATURE_CATALOG, FEATURE_PROJECTION, featuresOf, isFeature } from '../../src/modules/groups/features.ts';
import { changesOf, forbiddenFields } from '../../src/modules/groups/group-changes.ts';
import { API_KEY_PATTERN, API_KEY_SET_PROJECTION, GROUP_PROJECTION, changeSnapshot, fromLegacy, toLegacyUpdate, toResponse } from '../../src/modules/groups/group.mapper.ts';
import { PROVIDERS } from '../../src/modules/groups/group.types.ts';
import type { GroupChanges, LegacyGroupDocument } from '../../src/modules/groups/group.types.ts';
import { patchGroupBody } from '../../src/modules/groups/groups.schemas.ts';
import { isLanguageCode } from '../../src/modules/groups/languages.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { requireFeature } from '../../src/shared/security/scope/require-feature.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import { fixtureId, legacyGroup } from '../helpers/legacy-fixtures.ts';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const read = (overrides = {}) => fromLegacy(legacyGroup(1, overrides) as LegacyGroupDocument);
const kinds = (overrides = {}) => read(overrides).anomalies.map((a) => `${a.kind}:${a.field}`);

describe('feature catalog', () => {
  it('describes every feature, projects them and reads only exact true flags', () => {
    assert.equal(FEATURES.length, 15);
    for (const feature of FEATURES) {
      assert.ok(FEATURE_CATALOG[feature].length > 10);
      assert.equal(FEATURE_PROJECTION[`settings.${feature}`], 1);
      assert.equal(isFeature(feature), true);
    }
    assert.equal(isFeature('nope'), false);
    assert.equal(isFeature(5), false);
    assert.equal(featuresOf({ cash: true, rooms: 'true', ordering: 1, warehouse: false }).cash, true);
    assert.deepEqual(Object.values(featuresOf({ rooms: 'true', ordering: 1 })).filter(Boolean), []);
    for (const settings of [undefined, null, 'x', [], 7]) {
      assert.deepEqual(Object.values(featuresOf(settings)).filter(Boolean), []);
    }
  });

  it('accepts only ISO 639-1 codes in lower case', () => {
    assert.deepEqual(['it', 'en', 'zu'].map(isLanguageCode), [true, true, true]);
    assert.deepEqual(['IT', 'xx', 'ita', '', 5].map(isLanguageCode), [false, false, false, false, false]);
  });
});

describe('reading a legacy group', () => {
  it('maps a complete document and never exposes what is legacy only', () => {
    const { group, anomalies } = read({
      dealerId: fixtureId('user', 1),
      demo: true,
      dataCluster: 'cluster1',
      settings: {
        languages: 'it;EN; it;',
        cash: true,
        email: true,
        stats: { openingTime: '06:30', compressProductsCategories: true, timeSlots: [{ start: 0, end: 5 }, { start: 22, end: 23 }] },
        integrations: { yellgo: { status: true, apiKey: 'secret-key' }, qodeup: { status: false }, mystery: { status: true, apiKey: 'other' } },
      },
    });
    assert.deepEqual(anomalies, []);
    assert.equal(group.id, fixtureId('group', 1).toHexString());
    assert.deepEqual([group.name, group.description, group.dealerId, group.status, group.trashed, group.demo, group.dataCluster], ['group-001', 'Fixture group 001', fixtureId('user', 1).toHexString(), 'active', false, true, 'cluster1']);
    assert.deepEqual(group.languages, ['it', 'en']);
    assert.deepEqual(group.statsSettings, { openingTime: '06:30', compressProductsCategories: true, timeSlots: [{ from: '00:00', to: '06:00' }, { from: '22:00', to: '24:00' }] });
    assert.equal(group.features.cash && group.features.email && !group.features.rooms, true);
    assert.deepEqual([group.integrations.yellgo, group.integrations.qodeup, group.integrations.easyappear], [{ enabled: true, apiKeySet: false }, { enabled: false, apiKeySet: false }, { enabled: false, apiKeySet: false }]);
    assert.deepEqual(group.createdAt, new Date('2024-01-15T10:00:00.000Z'));
    for (const includeCluster of [true, false]) {
      const text = JSON.stringify(toResponse(group, includeCluster));
      for (const secret of ['plain-key', 'secret-key', 'other', 'mystery', 'databaseHost', 'filesHost', '"apiKey"', 'basic', 'smtp', 'fixture-secret']) {
        assert.ok(!text.includes(secret), secret);
      }
      assert.equal(text.includes('cluster1'), includeCluster);
    }
    assert.equal(toResponse(group, true).createdAt, '2024-01-15T10:00:00.000Z');
  });

  it('reads an irregular document with its sound fields and reports each problem', () => {
    const { group, anomalies } = fromLegacy({
      _id: fixtureId('group', 7),
      name: 5,
      description: 3,
      dealerId: 'not-an-id',
      status: 'yes',
      trash: 'no',
      demo: 1,
      dataCluster: 4,
      insertDate: 'yesterday',
      settings: {
        languages: true,
        cash: 'yes',
        email: { host: 'h', password: 'p' },
        stats: { openingTime: '25:00', compressProductsCategories: 'x', timeSlots: [{ start: 1, end: 2 }, { start: 'a', end: 1 }, { start: 24, end: 1 }, { start: 1, end: 1.5 }, 7, null] },
        integrations: { yellgo: 'on', cooperto: { status: 'on' } },
      },
    } as LegacyGroupDocument);
    assert.deepEqual([group.name, group.description, group.dealerId, group.status, group.trashed, group.demo, group.dataCluster, group.createdAt, group.updatedAt], ['', null, null, 'suspended', false, false, null, null, null]);
    assert.deepEqual([group.features.cash, group.features.email, group.languages], [false, false, []]);
    assert.deepEqual(group.statsSettings, { openingTime: null, compressProductsCategories: false, timeSlots: [{ from: '01:00', to: '03:00' }] });
    assert.deepEqual([group.integrations.yellgo.enabled, group.integrations.cooperto.enabled], [false, false]);
    assert.deepEqual(
      anomalies.map((a) => `${a.kind}:${a.field}`).sort(),
      [
        'invalidReference:dealerId',
        'invalidTimeSlot:settings.stats.timeSlots',
        'invalidTimeSlot:settings.stats.timeSlots',
        'invalidTimeSlot:settings.stats.timeSlots',
        'invalidTimeSlot:settings.stats.timeSlots',
        'invalidTimeSlot:settings.stats.timeSlots',
        'invalidTime:settings.stats.openingTime',
        'invalidType:dataCluster',
        'invalidType:demo',
        'invalidType:description',
        'invalidType:name',
        'invalidType:settings.cash',
        'invalidType:settings.email',
        'invalidType:settings.integrations.cooperto.status',
        'invalidType:settings.integrations.yellgo',
        'invalidType:settings.languages',
        'invalidType:settings.stats.compressProductsCategories',
        'invalidType:status',
        'invalidType:trash',
      ].sort(),
    );
  });

  it('tolerates containers that are not objects, bad languages and a stats value of the wrong type', () => {
    assert.deepEqual(kinds({ settings: 'none' }), ['invalidType:settings']);
    assert.deepEqual(kinds({ settings: { stats: 'x', integrations: [] } }), ['invalidType:settings.stats', 'invalidType:settings.integrations']);
    assert.deepEqual(read({ settings: { languages: 'it;xx;;fr' } }).group.languages, ['it', 'fr']);
    assert.deepEqual(kinds({ settings: { languages: 'it;xx' } }), ['invalidLanguage:settings.languages']);
    assert.deepEqual(kinds({ settings: { stats: { timeSlots: 'all', openingTime: 630 } } }), ['invalidType:settings.stats.timeSlots', 'invalidTime:settings.stats.openingTime']);
    assert.deepEqual(read({ settings: { languages: '' } }).group.languages, []);
    assert.deepEqual(kinds({ description: null, settings: { languages: null, stats: null, integrations: null, cash: null } }), []);
    assert.deepEqual(fromLegacy({ _id: fixtureId('group', 8), status: true } as LegacyGroupDocument).anomalies, []);
  });

  it('projects only mapped fields: no API key, host, type, plan, places or integration key', () => {
    const keys = Object.keys(GROUP_PROJECTION);
    for (const forbidden of ['apiKey', 'databaseHost', 'filesHost', 'type', 'plan', 'places', 'expirationDate', 'settings.integrations']) {
      assert.ok(!keys.includes(forbidden), forbidden);
    }
    assert.ok(keys.includes('settings.integrations.yellgo.status') && !keys.some((k) => k.endsWith('apiKey')));
  });
});

describe('writing a group', () => {
  it('stays inside the owned fields for every change', () => {
    const everything: GroupChanges = {
      name: 'N',
      description: null,
      demo: true,
      status: 'suspended',
      trashed: true,
      features: Object.fromEntries(FEATURES.map((f) => [f, true])),
      integrations: Object.fromEntries(PROVIDERS.map((p) => [p, { enabled: true, apiKey: 'k'.repeat(16) }])),
      languages: ['it', 'en'],
      statsSettings: { openingTime: '06:00', compressProductsCategories: true, timeSlots: [{ from: '00:00', to: '24:00' }] },
      publicApi: { enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000, groupRateLimitPerMinute: 600, groupDailyQuota: 50000 },
    };
    const { $set } = toLegacyUpdate(everything, NOW);
    for (const field of Object.keys($set)) {
      assert.ok(GROUPS_OWNED_FIELDS.includes(field), field);
    }
    // Everything but the catalogs, which have their own writes (and their paths are not in $set).
    assert.equal(Object.keys($set).length, GROUPS_OWNED_FIELDS.length - GROUPS_OWNED_CATALOGS.length);
    assert.equal(Object.keys($set).some((field) => GROUPS_OWNED_CATALOGS.some((root) => field === root || field.startsWith(`${root}.`))), false);
    assert.equal($set['settings.integrations.yellgo.apiKey'], 'k'.repeat(16));
    assert.deepEqual([$set['settings.languages'], $set['settings.stats.timeSlots'], $set['status'], $set['trash'], $set['updateDate']], ['it;en', [{ start: 0, end: 23 }], false, true, NOW]);
    for (const field of ['apiKey', 'databaseHost', 'filesHost', 'type', 'plan', 'expirationDate', 'places']) {
      assert.ok(!GROUPS_OWNED_FIELDS.includes(field));
      assert.ok(!(field in $set));
    }
    assert.deepEqual(toLegacyUpdate({ status: 'active', languages: [] }, NOW).$set, { status: true, 'settings.languages': null, updateDate: NOW });
    assert.deepEqual(toLegacyUpdate({}, NOW).$set, { updateDate: NOW });
  });

  it('writes the key of an integration, or null to remove it, and refuses a key that is not printable', () => {
    assert.deepEqual(toLegacyUpdate({ integrations: { yellgo: { apiKey: 'k'.repeat(16) }, qodeup: { apiKey: null, enabled: false } } }, NOW).$set, {
      'settings.integrations.yellgo.apiKey': 'k'.repeat(16),
      'settings.integrations.qodeup.apiKey': null,
      'settings.integrations.qodeup.status': false,
      updateDate: NOW,
    });
    for (const key of ['short', 'has space in it, long enough', 'x'.repeat(257)]) {
      assert.throws(() => toLegacyUpdate({ integrations: { yellgo: { apiKey: key } } }, NOW), /printable ASCII/);
    }
  });

  it('refuses what the callers should have validated', () => {
    assert.throws(() => toLegacyUpdate({ features: { nope: true } as never }, NOW), /feature/);
    assert.throws(() => toLegacyUpdate({ integrations: { nope: { enabled: true } } as never }, NOW), /integration/);
    assert.throws(() => toLegacyUpdate({ languages: ['xx'] }, NOW), /ISO 639-1/);
    for (const slot of [{ from: '00:30', to: '02:00' }, { from: '24:00', to: '24:00' }, { from: '00:00', to: '00:00' }]) {
      assert.throws(() => toLegacyUpdate({ statsSettings: { timeSlots: [slot] } }, NOW), /whole hours/);
    }
  });

  it('builds the response and the log snapshot from the group alone', () => {
    const { group } = read({ settings: { cash: true, integrations: { yellgo: { status: true, apiKey: 'k' } } } });
    assert.equal('dataCluster' in toResponse(group, false), false);
    assert.equal(toResponse({ ...group, createdAt: null, updatedAt: null }, true).updatedAt, null);
    const snapshot = changeSnapshot(group);
    assert.equal(JSON.stringify(snapshot).includes('apiKey'), false);
    assert.deepEqual((snapshot['enabledIntegrations'] as Record<string, boolean>)['yellgo'], true);
  });
});

describe('the modification body', () => {
  const body = (value: unknown) => validate(patchGroupBody, value, '(body)');
  const problems = (value: unknown): string[] => {
    try {
      body(value);
    } catch (error) {
      return (error as AppError).details!.map((d) => `${d.field}:${d.issue}`);
    }
    return [];
  };

  it('accepts every field and checks languages, times and slots', () => {
    const full = {
      name: 'Acme',
      description: null,
      languages: ['it', 'en'],
      statsSettings: { openingTime: '06:00', compressProductsCategories: false, timeSlots: [{ from: '00:00', to: '01:00' }] },
      features: { cash: true },
      integrations: { yellgo: { enabled: true } },
      demo: false,
    };
    assert.deepEqual(body(full), full);
    assert.deepEqual(problems({ languages: ['it', 'it'] }), ['languages.1:incorrect']);
    assert.deepEqual(problems({ languages: ['IT'] }), ['languages.0:enum']);
    assert.deepEqual(problems({ languages: Array.from({ length: 11 }, () => 'it') }), ['languages:tooMany']);
    assert.deepEqual(problems({ statsSettings: { openingTime: '24:00' } }), ['statsSettings.openingTime:pattern']);
    assert.deepEqual(problems({ statsSettings: { timeSlots: [{ from: '00:30', to: '25:00' }] } }), ['statsSettings.timeSlots.0.from:pattern', 'statsSettings.timeSlots.0.to:pattern']);
    assert.deepEqual(problems({ statsSettings: { timeSlots: Array.from({ length: 49 }, () => ({ from: '00:00', to: '01:00' })) } }), ['statsSettings.timeSlots:tooMany']);
    assert.deepEqual(problems({ features: { teleport: true } }), ['features.teleport:unknown']);
    assert.deepEqual(problems({ features: { cash: 'yes' } }), ['features.cash:type']);
    assert.deepEqual(problems({ integrations: { yellgo: { enabled: true, apiKey: 'k' } } }), ['integrations.yellgo.apiKey:minLength']);
    assert.deepEqual(problems({ integrations: { yellgo: { apiKey: 'has a space inside it' } } }), ['integrations.yellgo.apiKey:pattern']);
    assert.deepEqual(problems({ integrations: { yellgo: { apiKey: 'k'.repeat(257) } } }), ['integrations.yellgo.apiKey:maxLength']);
    assert.deepEqual(problems({ integrations: { yellgo: { apiKey: 'k'.repeat(16) }, qodeup: { apiKey: null } } }), []);
    assert.deepEqual(problems({ status: false, trash: true }), ['status:unknown', 'trash:unknown']);
    assert.deepEqual(problems({ name: '' }), ['name:minLength']);
    assert.deepEqual(problems({ description: '' }), ['description:minLength']);
  });
});

describe('integrations in the reading and in the changes', () => {
  it('reads the capitalized easyAppear only when easyappear is missing or null, and the keys set from what the database computed', () => {
    const states = (integrations: unknown, apiKeySet?: unknown) => read({ settings: { integrations }, apiKeySet }).group.integrations;
    assert.deepEqual(states({ easyAppear: { status: true } }).easyappear, { enabled: true, apiKeySet: false });
    assert.deepEqual(states({ easyappear: null, easyAppear: { status: true } }).easyappear.enabled, true);
    assert.deepEqual(states({ easyappear: { status: false }, easyAppear: { status: true } }).easyappear.enabled, false);
    assert.deepEqual(states({ easyAppear: { status: true } }).yellgo, { enabled: false, apiKeySet: false });
    const keys = states({ yellgo: { status: true } }, { yellgo: true, qodeup: 'yes', cooperto: false });
    assert.deepEqual([keys.yellgo.apiKeySet, keys.qodeup.apiKeySet, keys.cooperto.apiKeySet], [true, false, false]);
    assert.deepEqual(states({}, 'nope').yellgo.apiKeySet, false);
  });

  it('computes in the database whether each key is set, and never projects a key', () => {
    assert.deepEqual(Object.keys(API_KEY_SET_PROJECTION).sort(), PROVIDERS.map((provider) => `apiKeySet.${provider}`).sort());
    assert.ok(!Object.keys(GROUP_PROJECTION).some((key) => key.endsWith('apiKey')));
    assert.ok('settings.integrations.easyAppear.status' in GROUP_PROJECTION);
    assert.ok(API_KEY_PATTERN.test('x'.repeat(16)) && !API_KEY_PATTERN.test('x y'.repeat(8)));
  });

  it('counts a key as a change when it is new, or removed while there was one', () => {
    const without = read({ settings: {} }).group;
    const withKey = read({ settings: {}, apiKeySet: { yellgo: true } }).group;
    const body = (apiKey: string | null | undefined, enabled?: boolean) => validate(patchGroupBody, { integrations: { yellgo: { ...(apiKey === undefined ? {} : { apiKey }), ...(enabled === undefined ? {} : { enabled }) } } }, '(body)');
    const key = 'k'.repeat(16);
    assert.deepEqual(changesOf(without, body(key)), { integrations: { yellgo: { apiKey: key } } });
    assert.deepEqual(changesOf(withKey, body(key)), { integrations: { yellgo: { apiKey: key } } });
    assert.deepEqual(changesOf(without, body(null)), {});
    assert.deepEqual(changesOf(withKey, body(null)), { integrations: { yellgo: { apiKey: null } } });
    assert.deepEqual(changesOf(without, body(null, true)), { integrations: { yellgo: { enabled: true } } });
    assert.deepEqual(changesOf(without, body(key, true)), { integrations: { yellgo: { enabled: true, apiKey: key } } });
    assert.deepEqual(changesOf(without, body(undefined)), {});
    assert.deepEqual(changesOf(without, body(undefined, false)), {});
    assert.deepEqual(changeSnapshot(withKey)['integrationKeysConfigured'], Object.fromEntries(PROVIDERS.map((provider) => [provider, provider === 'yellgo'])));
  });
});

describe('what a request changes and who may send it', () => {
  const { group } = read({ settings: { cash: true, languages: 'it;en', stats: { openingTime: '06:00', timeSlots: [{ start: 0, end: 0 }] }, integrations: { yellgo: { status: true } } } });
  const patch = (value: unknown) => validate(patchGroupBody, value, '(body)');

  it('reports only real differences', () => {
    assert.deepEqual(
      changesOf(group, patch({ name: 'group-001', description: 'Fixture group 001', languages: ['it', 'en'], statsSettings: { openingTime: '06:00', compressProductsCategories: false, timeSlots: [{ from: '00:00', to: '01:00' }] }, features: { cash: true, rooms: false }, integrations: { yellgo: { enabled: true } }, demo: false })),
      {},
    );
    assert.deepEqual(
      changesOf(group, patch({ name: 'New', description: null, languages: ['en'], statsSettings: { openingTime: null, compressProductsCategories: true, timeSlots: [] }, features: { cash: false, rooms: true }, integrations: { yellgo: { enabled: false }, qodeup: { enabled: true } }, demo: true })),
      {
        name: 'New',
        description: null,
        languages: ['en'],
        statsSettings: { openingTime: null, compressProductsCategories: true, timeSlots: [] },
        features: { cash: false, rooms: true },
        integrations: { yellgo: { enabled: false }, qodeup: { enabled: true } },
        demo: true,
      },
    );
  });

  it('allows each role its fields (D-13) and nothing to a role that is not listed', () => {
    const all = patch({ name: 'N', description: null, languages: [], statsSettings: {}, features: {}, integrations: {}, demo: true });
    assert.deepEqual(forbiddenFields('PSA', all), []);
    assert.deepEqual(forbiddenFields('D', all), ['demo']);
    assert.deepEqual(forbiddenFields('SA', all), ['features', 'integrations', 'demo']);
    assert.deepEqual(forbiddenFields('CA', patch({ name: 'N' })), ['name']);
    assert.deepEqual(forbiddenFields('SA', patch({ name: 'N' })), []);
  });
});

describe('requireFeature', () => {
  const run = (features: Record<string, boolean>) => {
    let continued = false;
    const res = { locals: { groupAccess: { features } } } as unknown as Response;
    try {
      requireFeature('cash')({} as Request, res, () => void (continued = true));
    } catch (error) {
      return (error as AppError).code;
    }
    return continued ? 'next' : 'stopped';
  };

  it('lets the request through only when the feature is on', () => {
    assert.equal(run({ cash: true }), 'next');
    assert.equal(run({ cash: false }), 'FEATURE_DISABLED');
    assert.equal(run({}), 'FEATURE_DISABLED');
    assert.equal(new AppError('FEATURE_DISABLED').status, 403);
  });
});

