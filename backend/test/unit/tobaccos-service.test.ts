import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';
import { toTobaccoRow } from '../../src/modules/tobaccos/tobaccos.mapper.ts';
import { createTobaccosService } from '../../src/modules/tobaccos/tobaccos.service.ts';
import type { TobaccosRepository } from '../../src/modules/tobaccos/tobaccos.repository.ts';
import { principalOf } from '../helpers/principal.ts';
import { workbookOf } from '../helpers/xlsx.ts';

const HEADER = ['Categoria', 'Codice', 'Nome'];

function setup() {
  const entries: ActivityEntry[] = [];
  const replaced: unknown[][] = [];
  const asked: unknown[][] = [];
  const repository: TobaccosRepository = {
    list: async (params, category) => {
      asked.push([params.sort, params.limit, category]);
      return { items: [{ _id: new ObjectId(), code: 'A1', name: 'Alfa' }], page: { limit: params.limit, next: null } };
    },
    replaceAll: async (documents) => {
      replaced.push([...documents]);
      return { previous: 7 };
    },
  };
  let clock = 1000;
  const service = createTobaccosService({ repository, activityLog: { record: async (entry) => void entries.push(entry) }, now: () => (clock += 50) });
  return { service, entries, replaced, asked };
}

describe('the price list service', () => {
  it('lists with the default sort, any category, and the rows of the table', async () => {
    const { service, asked } = setup();
    const { items, page } = await service.list({ limit: 10 } as never);
    assert.deepEqual(asked, [['code', 10, null]]);
    assert.deepEqual([items.map((item) => item.code), page.next], [['A1'], null]);
    await service.list({ category: 'Sigarette', sort: '-price' } as never);
    assert.deepEqual(asked[1], ['-price', 50, 'Sigarette']);
  });

  it('imports, and logs the counts without an address when the client has none', async () => {
    const { service, entries, replaced } = setup();
    const result = await service.importList(principalOf('PSA'), workbookOf([HEADER, ['S', 'C1', 'Uno']]), { requestId: 'r1', ip: null, userAgent: null });
    assert.deepEqual(result, { inserted: 1, previous: 7, elapsedMs: 50 });
    assert.equal(replaced.length, 1);
    assert.deepEqual([entries[0]!.action, entries[0]!.metadata, 'ip' in entries[0]!], ['tobaccos.imported', { inserted: 1, previous: 7 }, false]);
    await service.importList(principalOf('PSA'), workbookOf([HEADER, ['S', 'C1', 'Uno']]), { requestId: 'r2', ip: '203.0.113.9', userAgent: null });
    assert.equal(entries[1]!.ip, '203.0.113.9');
  });

  it('reads with tight limits (29 columns), and leaves a trace of a refusal with its reason and never a content', async () => {
    const { service, entries, replaced } = setup();
    const client = { requestId: 'r', ip: '203.0.113.9', userAgent: null };
    await assert.rejects(() => service.importList(principalOf('PSA'), workbookOf([HEADER, ['S', 'C1', 'Uno', ...Array(27).fill(null), 'x']]), client), { code: 'VALIDATION_ERROR', details: [{ field: 'file', issue: 'incorrect' }] });
    await assert.rejects(() => service.importList(principalOf('PSA'), workbookOf([HEADER, ['S', 'C1', 'Uno', null, -1]]), { ...client, ip: null }), { code: 'VALIDATION_ERROR' });
    assert.deepEqual(entries.map((entry) => [entry.action, entry.outcome, entry.metadata, 'ip' in entry]), [
      ['tobaccos.imported', 'failure', { reason: 'file' }, true],
      ['tobaccos.imported', 'failure', { reason: 'rows' }, false],
    ]);
    assert.equal(replaced.length, 0);
  });

  it('rethrows what is not a refusal of the reader as it is, and writes nothing', async () => {
    const { service, entries, replaced } = setup();
    await assert.rejects(() => service.importList(principalOf('PSA'), null as never, { requestId: 'r', ip: null, userAgent: null }), TypeError);
    assert.deepEqual([replaced.length, entries.length], [0, 0]);
  });
});

describe('toTobaccoRow', () => {
  it('shows what the legacy stored, and an empty text or no number for anything else', () => {
    const _id = new ObjectId();
    assert.deepEqual(toTobaccoRow({ _id, code: 'A', name: 'N', shortName: 'S', category: 'C', priceKg: 1.5, price: 2, barcode: '800' }), { id: _id.toHexString(), code: 'A', name: 'N', shortName: 'S', category: 'C', priceKg: 1.5, price: 2, barcode: '800' });
    assert.deepEqual(toTobaccoRow({ _id, code: 5, name: null, priceKg: NaN, price: Infinity, barcode: '' }), { id: _id.toHexString(), code: '', name: '', shortName: '', category: '', priceKg: null, price: null, barcode: null });
    assert.equal(toTobaccoRow({ _id, barcode: 12 }).barcode, null);
  });
});
