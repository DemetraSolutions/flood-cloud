import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { GROUPS_OWNED_CATALOGS } from '../../src/db/collections.ts';
import type { Catalog, CatalogState, ContainerChange } from '../../src/modules/groups/catalogs/catalog.ts';
import { buildCatalogUpdate } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { CURRENCY_SYMBOLS, currencies, symbolFromLegacy, symbolToLegacy } from '../../src/modules/groups/catalogs/currencies.ts';
import { fidelityCardRules } from '../../src/modules/groups/catalogs/fidelity-card-rules.ts';
import {
  SAFE_ID,
  choiceOf,
  cardTypesWhere,
  conflict,
  dateOf,
  flagOf,
  integerOf,
  invalid,
  isRecord,
  isoInstant,
  mergePatch,
  nestedOf,
  newElementId,
  numberOf,
  objectIdsOf,
  recordsOf,
  referenced,
  sameName,
  storedIds,
  stringsOf,
  textOf,
  valueAt,
} from '../../src/modules/groups/catalogs/kit.ts';
import type { CatalogAnomaly } from '../../src/modules/groups/catalogs/kit.ts';
import { measureUnits } from '../../src/modules/groups/catalogs/measure-units.ts';
import { priceLists } from '../../src/modules/groups/catalogs/price-lists.ts';
import { prizeCatalogues } from '../../src/modules/groups/catalogs/prize-catalogues.ts';
import { productFavorites } from '../../src/modules/groups/catalogs/product-favorites.ts';
import { CATALOGS, DETAIL_CATALOG_PATHS } from '../../src/modules/groups/catalogs/registry.ts';
import { taxes } from '../../src/modules/groups/catalogs/taxes.ts';
import { warehouseRules } from '../../src/modules/groups/catalogs/warehouse-rules.ts';
import { ACTION_CATALOG, ACTIVITY_ACTION_NAMES, GROUP_CATALOG_NAMES, GROUP_CATALOG_VERBS } from '../../src/shared/activity-log/catalog.ts';
import { INVALID, validate } from '../../src/shared/validation/schema.ts';
import type { AppError } from '../../src/shared/http/errors.ts';

const state = (raw: Record<string, unknown>): CatalogState => ({ raw: (path) => raw[path], newId: () => 'made-id' });
const read = <E extends object>(catalog: Catalog<E>, raw: Record<string, unknown>) => {
  const anomalies: CatalogAnomaly[] = [];
  return { elements: catalog.list(state(raw), anomalies), anomalies: anomalies.map((a) => `${a.kind}:${a.field}`) };
};
const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    const app = error as AppError;
    return `${app.code}:${(app.details ?? []).map((d) => `${d.field}=${d.issue}`).join(',')}`;
  }
  return 'ok';
};

describe('the helpers that read a stored value', () => {
  it('give a value only for the right type', () => {
    assert.deepEqual([textOf('a'), textOf(1), flagOf(true), flagOf('true'), numberOf(1.5), numberOf(NaN), numberOf('1'), integerOf(2), integerOf(2.5)], ['a', null, true, false, 1.5, null, null, 2, null]);
    assert.deepEqual([dateOf(new Date('2026-01-01')), dateOf(new Date(NaN)), dateOf('2026-01-01')], ['2026-01-01T00:00:00.000Z', null, null]);
    assert.deepEqual([isRecord({}), isRecord([]), isRecord(null), isRecord(new Date()), isRecord(new ObjectId())], [true, false, false, false, false]);
    assert.equal(SAFE_ID.test('a-B_9'), true);
    assert.equal(SAFE_ID.test('a.b'), false);
    assert.match(newElementId(), /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(newElementId(), newElementId());
    assert.equal(sameName('Kg', 'kG'), true);
  });

  it('report what is wrong', () => {
    const anomalies: CatalogAnomaly[] = [];
    assert.deepEqual([choiceOf('a', ['a', 'b'], 'f', anomalies), choiceOf(undefined, ['a'], 'f', anomalies), choiceOf(null, ['a'], 'f', anomalies), anomalies.length], ['a', null, null, 0]);
    assert.deepEqual([choiceOf('z', ['a'], 'f', anomalies), choiceOf(3, ['a'], 'f', anomalies), anomalies.length], [null, null, 2]);
    const found: CatalogAnomaly[] = [];
    assert.deepEqual([stringsOf(undefined, 'f', found), stringsOf(null, 'f', found), stringsOf(['a'], 'f', found), found.length], [[], [], ['a'], 0]);
    assert.deepEqual([stringsOf('x', 'f', found), stringsOf(['a', 1], 'f', found), found.map((a) => a.kind)], [[], ['a'], ['invalidType', 'invalidElement']]);
    const id = new ObjectId();
    const more: CatalogAnomaly[] = [];
    assert.deepEqual([objectIdsOf(undefined, 'f', more), objectIdsOf(null, 'f', more), objectIdsOf([id], 'f', more), more.length], [[], [], [id.toHexString()], 0]);
    assert.deepEqual([objectIdsOf('x', 'f', more), objectIdsOf([id, 'x'], 'f', more), more.map((a) => a.kind)], [[], [id.toHexString()], ['invalidType', 'invalidElement']]);
    const nested: CatalogAnomaly[] = [];
    assert.deepEqual([nestedOf({ a: 1 }, 'f', nested), nestedOf(undefined, 'f', nested), nestedOf(null, 'f', nested), nested.length, nestedOf([], 'f', nested), nested.length], [{ a: 1 }, {}, {}, 0, {}, 1]);
  });

  it('walk a path, list the stored records and ids, and find the card types that match', () => {
    assert.deepEqual([valueAt({ a: { b: 3 } }, 'a.b'), valueAt({ a: 1 }, 'a.b'), valueAt({}, 'x'), valueAt(null, 'x')], [3, undefined, undefined, undefined]);
    assert.deepEqual(recordsOf([{ a: 1 }, 'x', null, [1]]), [{ a: 1 }]);
    assert.deepEqual(recordsOf({}), []);
    assert.deepEqual([...storedIds({ a: {}, b: {} }, 'map')], ['a', 'b']);
    assert.deepEqual([...storedIds([], 'map')], []);
    assert.deepEqual([...storedIds([{ id: 'x' }, { id: 5 }, 'y'], 'array')], ['x']);
    assert.deepEqual(cardTypesWhere([{ id: 'a', k: 1 }, { id: 'b' }, 'x'], (card) => card['k'] === 1), ['cardTypes.a']);
  });

  it('merge a patch into an element and build the errors', () => {
    assert.deepEqual(mergePatch({ a: 1, n: { x: 1, y: 2 }, l: [1, 2] }, { n: { y: 3 }, l: [3], z: null }), { a: 1, n: { x: 1, y: 3 }, l: [3], z: null });
    assert.deepEqual(mergePatch({ n: 1 }, { n: { a: 1 } }), { n: { a: 1 } });
    assert.equal(code(() => { throw conflict('f', 'taken'); }), 'CONFLICT:f=taken');
    assert.equal(code(() => { throw invalid('f', 'incorrect'); }), 'VALIDATION_ERROR:f=incorrect');
    assert.equal(code(() => { throw referenced(Array.from({ length: 25 }, (_unused, i) => `x${String(i)}`)); }).split(',').length, 20);
  });

  it('accept an instant as the normalized ISO text', () => {
    assert.equal(validate(isoInstant(), '2026-05-06', 'v'), '2026-05-06T00:00:00.000Z');
    assert.throws(() => validate(isoInstant(), '2026-05-06 10:00', 'v'));
    assert.equal(INVALID.toString(), 'Symbol(invalid)');
  });
});

describe('the activity log catalog', () => {
  it('has created, updated and deleted for each catalog of the group, as data events, and one name per catalog implemented', () => {
    for (const name of GROUP_CATALOG_NAMES) {
      for (const verb of GROUP_CATALOG_VERBS) {
        assert.deepEqual(ACTION_CATALOG.get(`group.${name}.${verb}`), { categories: ['data'], metadataKeys: ['changesTotal', 'changesTruncated'] });
        assert.ok(ACTIVITY_ACTION_NAMES.includes(`group.${name}.${verb}`));
      }
    }
    assert.deepEqual([...GROUP_CATALOG_NAMES].sort(), CATALOGS.map((catalog) => catalog.name).sort());
  });
});

describe('the registry', () => {
  it('has a catalog for every action name of the log, with unique segments and stored paths', () => {
    assert.equal(CATALOGS.length, 11);
    assert.equal(new Set(CATALOGS.map((catalog) => catalog.segment)).size, 11);
    assert.equal(new Set(CATALOGS.map((catalog) => catalog.path)).size, 11);
    for (const catalog of CATALOGS) {
      assert.ok(catalog.paths.includes(catalog.path));
      assert.ok(GROUPS_OWNED_CATALOGS.includes(catalog.path), catalog.path);
      assert.ok(catalog.limit > 0);
    }
    assert.deepEqual([...DETAIL_CATALOG_PATHS], ['priceLists', 'taxes', 'currencies', 'measureUnits', 'warehouseRules', 'fidelityCardRules']);
  });
});

describe('reading the stored catalogs', () => {
  it('reads a container of the wrong type, or over the limit, as far as it can and reports it', () => {
    assert.deepEqual(read(priceLists, { priceLists: [] }), { elements: [], anomalies: ['invalidType:priceLists'] });
    assert.deepEqual(read(priceLists, {}), { elements: [], anomalies: [] });
    assert.deepEqual(read(priceLists, { priceLists: null }), { elements: [], anomalies: [] });
    assert.deepEqual(read(taxes, { taxes: {} }), { elements: [], anomalies: ['invalidType:taxes'] });
    assert.deepEqual(read(taxes, { taxes: 'x' }).anomalies, ['invalidType:taxes']);
    const many = read(taxes, { taxes: Array.from({ length: 31 }, (_unused, i) => ({ id: `t${String(i)}`, value: 1 })) });
    assert.deepEqual([many.elements.length, many.anomalies], [31, ['overLimit:taxes']]);
    assert.deepEqual(read(measureUnits, { measureUnits: { a: 'text', b: { value: 'kg' }, c: {} } }), { elements: [{ id: 'b', value: 'kg' }, { id: 'c', value: '' }], anomalies: ['invalidElement:measureUnits'] });
  });

  it('reads a currency without a symbol as an empty symbol', () => {
    assert.deepEqual(read(currencies, { currencies: { EUR: { code: 'EUR' }, USD: { symbol: 5 } } }).elements, [{ code: 'EUR', symbol: '' }, { code: 'USD', symbol: '' }]);
  });

  it('reads the elements with irregular values', () => {
    assert.deepEqual(read(taxes, { taxes: [{ id: 'a' }, { value: 1 }, { id: 3, value: 7, natura: 'N1', department: 2.5 }] }), {
      elements: [
        { id: 'a', rate: 0, department: null, description: null, vatNature: null },
        { id: '3', rate: 7, department: null, description: null, vatNature: 'N1' },
      ],
      anomalies: ['invalidElement:taxes'],
    });
    assert.deepEqual(read(priceLists, { priceLists: { a: { status: 'yes' }, b: { name: 'B', status: true, default: true } } }).elements, [
      { id: 'a', name: '', enabled: false, isDefault: false },
      { id: 'b', name: 'B', enabled: true, isDefault: true },
    ]);
    const rules = read(warehouseRules, { warehouseRules: { a: { type: 'L' }, b: { type: 'D', name: 'N', cashD: true, cashL: true, quantity: '+', value: '-', counterpart: 'indoor', useLoadUnit: true, default: true } } });
    assert.deepEqual(rules.elements.map((rule) => [rule.type, rule.name, rule.cashLoad, rule.cashUnload, rule.useLoadUnit, rule.isDefault]), [['load', '', false, false, false, false], ['unload', 'N', true, true, true, true]]);
    const prizes = read(prizeCatalogues, { 'fidelity.prizeCatalogues': [{ id: 'c', prizes: [{ name: 'no id' }, { id: 'p', medias: { images: { main: {} } } }, { id: 'q', medias: 'x' }, { id: 'r', medias: { images: { main: null } } }] }] });
    assert.deepEqual([prizes.elements[0]!.prizes.map((prize) => [prize.id, prize.imageSet]), prizes.anomalies], [[['p', true], ['q', false], ['r', false]], ['invalidElement:fidelity.prizeCatalogues.c.prizes']]);
    const favorites = read(productFavorites, { productsFavorites: [{ id: 'f' }, { id: 'g', name: 'G', favorites: [{ _id: 'x' }] }] });
    assert.deepEqual([favorites.elements.map((favorite) => [favorite.name, favorite.products.length]), favorites.anomalies], [[['', 0], ['G', 0]], ['invalidElement:productsFavorites.g.favorites']]);
  });

  it('lists a loyalty rule for each currency, even when the stored rules are irregular', () => {
    assert.deepEqual(read(fidelityCardRules, { currencies: { EUR: {}, USD: {} }, fidelityCardRules: { EUR: { value: 2, discountPercentage: 'x' }, USD: 'text' } }).elements, [
      { currency: 'EUR', pointValue: 2, discountPercentage: null },
      { currency: 'USD', pointValue: null, discountPercentage: null },
    ]);
    assert.deepEqual(read(fidelityCardRules, { currencies: ['EUR'] }).elements, []);
    assert.deepEqual(read(fidelityCardRules, { currencies: 'x', fidelityCardRules: 'y' }).elements, []);
  });
});

describe('writing to irregular containers', () => {
  it('creates in a container that is missing or of the wrong type, replacing a garbage one, and the first list is the default', () => {
    for (const raw of [{}, { priceLists: null }, { priceLists: [] }, { priceLists: 'x' }]) {
      const outcome = priceLists.create({ name: 'First' }, state(raw));
      assert.equal(outcome.after!.isDefault, true);
      assert.deepEqual(outcome.changes.map((change) => change.path), ['priceLists']);
      assert.deepEqual(code(() => priceLists.create({ name: 'First', isDefault: false }, state(raw))), 'VALIDATION_ERROR:isDefault=incorrect');
    }
    assert.equal(priceLists.create({ name: 'Second' }, state({ priceLists: { a: { id: 'a', name: 'A', status: true, default: true } } })).after!.isDefault, false);
  });

  it('keeps garbage entries, finds only records by id and refuses an id that is not a path segment', () => {
    const raw = { taxes: ['junk', null, { id: 'a', value: 1 }] };
    const outcome = taxes.patch('a', { rate: 5 }, state(raw));
    assert.deepEqual(outcome.changes[0]!.next, ['junk', null, { id: 'a', value: 5 }]);
    assert.equal(code(() => taxes.patch('junk', { rate: 5 }, state(raw))), 'NOT_FOUND:');
    assert.equal(code(() => taxes.remove('a.b', state(raw))), 'NOT_FOUND:');
    assert.equal(code(() => measureUnits.patch('a', { value: 'x' }, state({ measureUnits: { a: 'text' } }))), 'NOT_FOUND:');
    assert.deepEqual(taxes.remove('a', state(raw)).changes[0]!.next, ['junk', null]);
  });

  it('changes nothing, and says so, when the request repeats what is stored', () => {
    assert.deepEqual(taxes.patch('a', { rate: 1 }, state({ taxes: [{ id: 'a', value: 1, department: null, description: null, natura: null }] })).changes, []);
    const outcome = currencies.patch('EUR', { symbol: '€' }, state({ currencies: { EUR: { code: 'EUR', symbol: '&euro;' } }, fidelityCardRules: {} }));
    assert.deepEqual(outcome.changes, []);
    const odd = currencies.patch('EUR', { symbol: '€' }, state({ currencies: { EUR: { code: 'EUR', symbol: '&#8364;' } } }));
    assert.deepEqual(odd.changes, []);
  });

  it('keeps the loyalty rules in step with the currencies, and rebuilds them when they are missing or garbage', () => {
    const created = currencies.create({ code: 'USD', symbol: '$' }, state({ currencies: { EUR: { code: 'EUR', symbol: '&euro;' } }, fidelityCardRules: { USD: { code: 'USD', value: 3, discountPercentage: 2 } } }));
    // The rule that is already there is kept as it is: the container does not change.
    assert.deepEqual(created.changes.map((change) => change.path), ['currencies']);
    const fromGarbage = currencies.create({ code: 'USD', symbol: '$' }, state({ currencies: 'x', fidelityCardRules: 'y' }));
    assert.deepEqual(fromGarbage.changes.map((change) => [change.path, change.next]), [['currencies', { USD: { code: 'USD', symbol: '$' } }], ['fidelityCardRules', { USD: { code: 'USD', value: null, discountPercentage: null } }]]);
    const removed = currencies.remove('EUR', state({ currencies: { EUR: { code: 'EUR', symbol: 'e' }, USD: { code: 'USD', symbol: '$' } }, fidelityCardRules: 5 }));
    assert.deepEqual(removed.changes.map((change) => [change.path, change.next]), [['currencies', { USD: { code: 'USD', symbol: '$' } }], ['fidelityCardRules', {}]]);
    assert.equal(code(() => currencies.create({ code: 'EUR', symbol: '€' }, state({ currencies: { EUR: { code: 'EUR', symbol: 'e' } } }))), 'CONFLICT:code=taken');
  });

  it('replaces a loyalty rule over irregular stored data, and refuses unknown or unsafe currencies', () => {
    const base = { currencies: { EUR: { code: 'EUR' } } };
    assert.deepEqual(fidelityCardRules.patch('EUR', { pointValue: 1, discountPercentage: 2 }, state({ ...base, fidelityCardRules: 'garbage' })).changes[0]!.next, { EUR: { code: 'EUR', value: 1, discountPercentage: 2 } });
    assert.deepEqual(fidelityCardRules.patch('EUR', { pointValue: 1, discountPercentage: 2 }, state({ ...base, fidelityCardRules: { EUR: 'x', USD: { keep: 1 } } })).changes[0]!.next, { EUR: { code: 'EUR', value: 1, discountPercentage: 2 }, USD: { keep: 1 } });
    assert.deepEqual(fidelityCardRules.patch('EUR', { pointValue: null, discountPercentage: null }, state({ ...base, fidelityCardRules: { EUR: { code: 'EUR', value: null, discountPercentage: null } } })).changes, []);
    assert.equal(code(() => fidelityCardRules.patch('JPY', { pointValue: 1, discountPercentage: 1 }, state(base))), 'NOT_FOUND:');
    assert.equal(code(() => fidelityCardRules.patch('a.b', { pointValue: 1, discountPercentage: 1 }, state({ currencies: { 'a.b': {} } }))), 'NOT_FOUND:');
    assert.equal(code(() => fidelityCardRules.patch('EUR', { pointValue: 1, discountPercentage: 1 }, state({ currencies: 'x' }))), 'NOT_FOUND:');
  });

  it('refuses to create over a duplicated id and to exceed the limit, whatever the container looks like', () => {
    assert.equal(code(() => measureUnits.create({ value: 'x' }, state({ measureUnits: Object.fromEntries(Array.from({ length: 50 }, (_unused, i) => [`u${String(i)}`, { id: `u${String(i)}`, value: `v${String(i)}` }])) }))), 'VALIDATION_ERROR:(body)=tooMany');
  });
});

describe('the currency symbols', () => {
  it('convert the known entities in both directions and leave the others alone', () => {
    for (const [entity, character] of CURRENCY_SYMBOLS) {
      assert.equal(symbolFromLegacy(entity), character);
    }
    assert.deepEqual([symbolToLegacy('€'), symbolToLegacy('£'), symbolToLegacy('₹'), symbolToLegacy('$'), symbolToLegacy('CHF'), symbolFromLegacy('&weird;'), symbolFromLegacy('$')], ['&euro;', '&pound;', '&#8377;', '$', 'CHF', '&weird;', '$']);
    assert.equal(symbolFromLegacy(symbolToLegacy('€')), '€');
  });
});

describe('the update of the catalogs', () => {
  const map = (old: unknown, next: unknown, path = 'priceLists'): ContainerChange => ({ path, kind: 'map', old, next });

  it('writes a map element by element: new elements whole, changed ones by field, removed ones unset', () => {
    const update = buildCatalogUpdate([
      map({ a: { id: 'a', name: 'A', keep: 1 }, b: { id: 'b' }, c: 'text', d: { x: 1 } }, { a: { id: 'a', name: 'New', keep: 1 }, b: { id: 'b' }, c: { id: 'c' }, d: 'now text', e: { id: 'e' } }),
    ]);
    assert.deepEqual(update.set, { 'priceLists.a.name': 'New', 'priceLists.c': { id: 'c' }, 'priceLists.d': 'now text', 'priceLists.e': { id: 'e' } });
    assert.deepEqual(update.unset, {});
    assert.deepEqual(buildCatalogUpdate([map({ a: { id: 'a' }, b: { id: 'b' } }, { a: { id: 'a' } })]).unset, { 'priceLists.b': '' });
    assert.deepEqual(buildCatalogUpdate([map({ a: 'same' }, { a: 'same' })]), { set: {}, unset: {} });
  });

  it('replaces a whole container when it is an array, is not an object, or has a key that cannot be a path segment', () => {
    assert.deepEqual(buildCatalogUpdate([{ path: 'taxes', kind: 'array', old: [], next: [{ id: 'a' }] }]).set, { taxes: [{ id: 'a' }] });
    assert.deepEqual(buildCatalogUpdate([map(undefined, { a: {} })]).set, { priceLists: { a: {} } });
    assert.deepEqual(buildCatalogUpdate([map([], { a: {} })]).set, { priceLists: { a: {} } });
    for (const key of ['a.b', '$x', '']) {
      assert.deepEqual(buildCatalogUpdate([map({ [key]: {} }, { [key]: { x: 1 } })]).set, { priceLists: { [key]: { x: 1 } } });
    }
  });

  it('writes nothing outside the owned catalogs', () => {
    for (const path of ['apiKey', 'databaseHost', 'filesHost', 'places', 'type', 'plan', 'expirationDate', 'settings', 'fidelity', 'settings.integrations']) {
      assert.throws(() => buildCatalogUpdate([{ path, kind: 'array', old: [], next: [] }]), /not an owned catalog path/, path);
    }
    for (const path of GROUPS_OWNED_CATALOGS) {
      assert.deepEqual(Object.keys(buildCatalogUpdate([{ path, kind: 'array', old: [], next: [1] }]).set), [path]);
    }
    assert.throws(() => buildCatalogUpdate([map({ a: { x: 1 } }, {}, 'places')]), /not an owned catalog path/);
    assert.throws(() => buildCatalogUpdate([map({}, { a: {} }, 'apiKey')]), /not an owned catalog path/);
  });
});

describe('the bodies', () => {
  const problems = (catalog: Catalog, body: unknown, part: 'createSchema' | 'patchSchema' = 'createSchema'): string[] => {
    try {
      validate(catalog[part]!, body, '(body)');
    } catch (error) {
      return (error as AppError).details!.map((d) => `${d.field}:${d.issue}`);
    }
    return [];
  };

  it('are closed: unknown and operator keys are refused, in every catalog', () => {
    for (const catalog of CATALOGS) {
      for (const part of ['createSchema', 'patchSchema'] as const) {
        if (catalog[part] === undefined) {
          continue;
        }
        assert.ok(problems(catalog, { $set: 1, name: 'x', pad: 1 }, part).includes('pad:unknown'), `${catalog.name} ${part}`);
        assert.ok(problems(catalog, { 'a.b': 1 }, part).includes('(key):forbiddenKey'), catalog.name);
        assert.ok(problems(catalog, [], part).includes('(body):type'), catalog.name);
      }
    }
  });

  it('never accept the id of an element from the client (it is made by the server, or is the code of a currency) nor a prototype key', () => {
    for (const catalog of CATALOGS) {
      for (const part of ['createSchema', 'patchSchema'] as const) {
        if (catalog[part] === undefined) {
          continue;
        }
        for (const key of ['id', '_id']) {
          assert.ok(problems(catalog, { [key]: 'chosen' }, part).includes(`${key}:unknown`), `${catalog.name} ${part} ${key}`);
        }
        // JSON.parse makes `__proto__` an own key, as body-parser does.
        assert.ok(problems(catalog, JSON.parse('{"__proto__":{"polluted":true}}'), part).includes('(key):forbiddenKey'), `${catalog.name} ${part}`);
      }
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});
