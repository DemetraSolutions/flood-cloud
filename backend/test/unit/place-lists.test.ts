import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Int32, ObjectId } from 'mongodb';
import { PLACE_LISTS, itemKey, listAt, listForVersion, mergeList } from '../../src/shared/legacy-write/place-lists.ts';
import { defaultOf, listCodec, newItem } from '../../src/modules/places/place-lists.mapper.ts';
import { codecOf } from '../../src/modules/places/place-settings.mapper.ts';

describe('place lists: definitions and merge', () => {
  it('finds a list by its path and the id of an item, as text', () => {
    assert.equal(listAt('rooms'), PLACE_LISTS.rooms);
    assert.equal(listAt('unknown'), undefined);
    const id = new ObjectId();
    assert.deepEqual([itemKey({ id }), itemKey({ id: 'a' }), itemKey({ id: 3 }), itemKey('x'), itemKey({}), itemKey(null)], [id.toHexString(), 'a', undefined, undefined, undefined, undefined]);
  });

  it('merges fragments over the stored items: keys kept, objects and lists merged, ids never touched, the others removed', () => {
    const stored = [{ id: 'r1', name: 'A', pos: 1, view: { w: 8, subtables: { x: 1 } }, tables: [{ id: 't1', name: 'T', pos: 2 }, { id: 't2', name: 'U' }] }, 'junk', { id: 'gone' }];
    const merged = mergeList(stored, [{ id: 'r1', name: 'B', view: { w: 9 }, tables: [{ id: 't1', name: 'T1' }, { id: 't3', name: 'new' }] }, { id: 'r2', name: 'new' }], PLACE_LISTS.rooms);
    assert.deepEqual(merged, [{ id: 'r1', name: 'B', pos: 1, view: { w: 9, subtables: { x: 1 } }, tables: [{ id: 't1', name: 'T1', pos: 2 }, { id: 't3', name: 'new' }] }, { id: 'r2', name: 'new' }]);
    // A view the stored item lacks, or a stored list that is not a list, is just taken.
    assert.deepEqual(mergeList([{ id: 'r1' }], [{ id: 'r1', view: { w: 1 } }], PLACE_LISTS.rooms), [{ id: 'r1', view: { w: 1 } }]);
    assert.deepEqual(mergeList(undefined, [{ id: 'a' }], PLACE_LISTS.devices), [{ id: 'a' }]);
    assert.deepEqual(mergeList([{ id: 'r1', tables: 'x' }], [{ id: 'r1', tables: [{ id: 't' }] }], PLACE_LISTS.rooms), [{ id: 'r1', tables: [{ id: 't' }] }]);
  });

  it('cuts the devices to what the backend owns for the version, and leaves the whole lists and what is not a list', () => {
    assert.deepEqual(listForVersion(PLACE_LISTS.devices, [{ id: 'd', name: 'x', info: 1, other: 2 }, 5]), [{ id: 'd', name: 'x' }, 5]);
    assert.deepEqual(listForVersion(PLACE_LISTS.devices, 'broken'), 'broken');
    assert.deepEqual(listForVersion(PLACE_LISTS.rooms, [{ id: 'r', info: 1 }]), [{ id: 'r', info: 1 }]);
  });
});

describe('place lists: codecs', () => {
  it('has a default for every kind, and a new item without credentials', () => {
    assert.deepEqual(newItem(PLACE_LISTS.devices)['automaticCashPassword'], undefined);
    assert.equal(defaultOf({ t: 'secret', max: 1 }), false);
    assert.equal(defaultOf({ t: 'num', min: 0, max: 1 }), null);
    assert.deepEqual(newItem(PLACE_LISTS.rooms)['view'], { type: 'grid', status: false, h: 8, w: 8 });
  });

  it('reads a damaged list tolerantly and writes the fragment of a new item', () => {
    const codec = listCodec(PLACE_LISTS.devices);
    assert.deepEqual(codec.read('x'), []);
    const [device] = codec.read([{ id: 'd', name: 5, server: 'yes', printStations: ['a', 3], driver: 7, host: new Int32(1) }]) as Array<Record<string, unknown>>;
    assert.deepEqual([device!['name'], device!['server'], device!['printStations'], device!['driver'], device!['type'], device!['host']], ['', false, ['a'], '', 'desk', '']);
    const storages = listCodec(PLACE_LISTS.storages);
    assert.deepEqual(storages.write([{ id: 'legacy-text', name: 'A', cash: true, ecommerce: false }], []), [{ id: 'legacy-text', name: 'A', cash: true, ecommerce: false }]);
  });
});

describe('place settings: the codecs of the credentials and of the provider data', () => {
  it('never reads a credential, reads its flag, and reads and writes the maps and lists of TS Hospitality', () => {
    const secret = codecOf({ t: 'secret', max: 5 });
    assert.deepEqual([secret.read('x'), secret.write('y', undefined), secret.write(null, 'x')], [undefined, 'y', null]);
    const flag = codecOf({ t: 'secretFlag' });
    assert.deepEqual([flag.read('x'), flag.read(''), flag.read(null), flag.write(true, undefined)], [true, false, false, true]);
    const map = codecOf({ t: 'whole', name: 'tshCategoriesMap' });
    assert.deepEqual([map.read({ a: 'b', c: 1 }), map.read(null), map.write({ a: 'b' }, undefined)], [{ a: 'b' }, {}, { a: 'b' }]);
    const categories = codecOf({ t: 'whole', name: 'tshCategories' });
    assert.deepEqual([categories.read([{ id: 'a', name: 'B', x: 1 }, { id: 1 }, 'x']), categories.read(undefined), categories.write([{ id: 'a' }], undefined)], [[{ id: 'a', name: 'B' }], [], [{ id: 'a' }]]);
  });
});
