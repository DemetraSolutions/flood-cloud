import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { describe, it } from 'node:test';
import { rawInvoiceRef } from '../../src/engine/ref.ts';

const id = new ObjectId();
const base = (values: Document = {}): Document => ({
  _id: id,
  company: { code: 'IT01234567890', invoicesPS: null },
  number: 42,
  prefixSuffix: 'A/',
  date: new Date('2026-12-31T23:30:00.000Z'),
  fattura_elettronica: { progressivo_invio: 7, tipo: 'TD01' },
  worker: { firstUploadAt: new Date('2026-12-31T22:00:00.000Z') },
  ...values,
});

describe('rawInvoiceRef', () => {
  it('reads the identity of a record without validating it', () => {
    assert.deepEqual(rawInvoiceRef(base()), { queueId: id.toHexString(), sellerVat: 'IT01234567890', number: '42', date: '2027-01-01', progressive: '7', documentType: 'TD01', since: Date.parse('2026-12-31T22:00:00.000Z') });
  });

  it('searches from the later of the first upload and the end of the last complete search, and carries the resume point', () => {
    const first = Date.parse('2026-12-31T22:00:00.000Z');
    const later = new Date(first + 3_600_000);
    assert.equal(rawInvoiceRef(base({ worker: { firstUploadAt: new Date(first), searchedUntil: later } }))?.since, later.getTime());
    assert.equal(rawInvoiceRef(base({ worker: { firstUploadAt: new Date(first), searchedUntil: new Date(first - 1) } }))?.since, first);
    assert.equal(rawInvoiceRef(base({ worker: { firstUploadAt: new Date(first), searchedUntil: 'x' } }))?.since, first);
    assert.equal(rawInvoiceRef(base())?.resume, undefined);
    assert.deepEqual(rawInvoiceRef(base({ worker: { firstUploadAt: new Date(first), findFrom: { slice: 2, page: 0 } } }))?.resume, { slice: 2, page: 0 });
    for (const bad of [{ slice: -1, page: 1 }, { slice: 1, page: -1 }, { slice: 1.5, page: 1 }, { slice: '1', page: 1 }, { slice: 1 }, 'x', null]) {
      assert.equal(rawInvoiceRef(base({ worker: { firstUploadAt: new Date(first), findFrom: bad } }))?.resume, undefined, JSON.stringify(bad));
    }
  });

  it('numbers like the mapper: section as prefix, as suffix, or none (a section that is not text is ignored)', () => {
    assert.equal(rawInvoiceRef(base({ company: { code: 'IT1', invoicesPS: 'prefix' } }))?.number, 'A/42');
    assert.equal(rawInvoiceRef(base({ company: { code: 'IT1', invoicesPS: 'suffix' } }))?.number, '42A/');
    assert.equal(rawInvoiceRef(base({ company: { code: 'IT1', invoicesPS: 'prefix' }, prefixSuffix: 5 }))?.number, '42');
  });

  it('accepts text numbers, a lower-case or numeric seller code and a date given as text', () => {
    const ref = rawInvoiceRef(base({ company: { code: 'it01234567890' }, number: ' 42 ', date: '2026-11-27T10:00:00.000Z', fattura_elettronica: { progressivo_invio: '7', tipo: 'TD01' } }));
    assert.deepEqual([ref?.sellerVat, ref?.number, ref?.date, ref?.progressive], ['IT01234567890', '42', '2026-11-27', '7']);
    assert.equal(rawInvoiceRef(base({ company: { code: 1879020517 } }))?.sellerVat, 'IT1879020517');
  });

  it('gives nothing when something is missing or unusable', () => {
    const missing: Document[] = [
      base({ _id: 'text' }),
      base({ company: undefined }),
      base({ company: { code: '' } }),
      base({ company: { code: 'IT' } }),
      base({ number: undefined }),
      base({ number: Number.NaN }),
      base({ date: undefined }),
      base({ date: 5 }),
      base({ date: new Date('x') }),
      base({ date: 'nope' }),
      base({ fattura_elettronica: undefined }),
      base({ fattura_elettronica: { progressivo_invio: '', tipo: 'TD01' } }),
      base({ fattura_elettronica: { progressivo_invio: '7' } }),
      base({ worker: undefined }),
      base({ worker: { firstUploadAt: 5 } }),
    ];
    for (const record of missing) {
      assert.equal(rawInvoiceRef(record), undefined, JSON.stringify(record));
    }
  });
});
