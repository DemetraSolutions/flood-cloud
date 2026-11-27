import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { describe, it } from 'node:test';
import type { GroupStore } from '../../src/engine/groups.ts';
import { prepareInvoice } from '../../src/engine/prepare.ts';
import type { Prepared } from '../../src/engine/prepare.ts';
import { baseRecord, withValues } from '../fixtures/records.ts';
import { SELLER_A, sellerFields, T0 } from '../helpers/world.ts';

const TRANSMITTER = { IdPaese: 'IT', IdCodice: '01879020517' };

function groups(original: Document | null): { store: GroupStore; reads: unknown[][] } {
  const reads: unknown[][] = [];
  return {
    reads,
    store: {
      setSendStatus: async () => true,
      readOriginal: async (...args) => {
        reads.push(args);
        return original;
      },
    },
  };
}

const record = (values: Record<string, unknown> = {}): Document => ({ ...withValues(baseRecord(), { ...sellerFields(SELLER_A), ...values }), _id: new ObjectId(), groupId: new ObjectId() });

async function prepare(doc: Document, original: Document | null = null, lookup: 'unique' | 'duplicate' = 'unique'): Promise<{ result: Prepared; reads: unknown[][] }> {
  const { store, reads } = groups(original);
  const result = await prepareInvoice(doc, { transmitter: TRANSMITTER, groups: store, lookup: async () => lookup, now: T0 });
  return { result, reads };
}

const creditNote = (values: Record<string, unknown> = {}): Document => record({ type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: new ObjectId(), ...values });

describe('prepareInvoice', () => {
  it('turns a valid record into a file, its identifiers and the duplicate key, without reading a group', async () => {
    const doc = record();
    const { result, reads } = await prepare(doc);
    assert.ok(result.ok);
    assert.equal(result.file.queueId, (doc['_id'] as ObjectId).toHexString());
    assert.equal(result.file.sellerVat, `IT${SELLER_A}`);
    assert.deepEqual([result.file.number, result.file.date, result.file.progressive], ['42', '2026-11-27', '7']);
    assert.equal(result.key, `["IT${SELLER_A}","42","2026","other"]`);
    assert.equal(reads.length, 0);
  });

  it('returns the warnings of a valid record, and the identity and file of one that is refused', async () => {
    const ok = await prepare(creditNote(), null);
    assert.ok(ok.result.ok);
    assert.deepEqual(ok.result.warnings.map((issue) => issue.code), ['LINKED']);
    const refused = await prepare(record({ date: '2027-01-15T10:00:00.000Z' }));
    assert.ok(!refused.result.ok);
    assert.deepEqual(refused.result.document, { number: '42', date: '2027-01-15', documentType: 'TD01' });
    assert.equal(refused.result.xml, undefined, 'no file is built for a record with errors');
    const big = await prepare(record({ note: 'causale '.repeat(700_000) }));
    assert.ok(!big.result.ok);
    assert.ok((big.result.xml ?? '').length > 5_000_000, 'the oversized file is returned (the shadow report measures it)');
    const mapping = await prepare(record({ records: 'x' }));
    assert.ok(!mapping.result.ok);
    assert.deepEqual([mapping.result.document, mapping.result.xml], [undefined, undefined]);
  });

  it('identifies the seller of a simplified invoice too', async () => {
    const { result } = await prepare(record({ 'fattura_elettronica.tipo': 'TD07' }));
    assert.ok(result.ok);
    assert.equal(result.file.sellerVat, `IT${SELLER_A}`);
  });

  it('reports a duplicate as an error', async () => {
    const { result } = await prepare(record(), null, 'duplicate');
    assert.ok(!result.ok);
    assert.deepEqual(result.issues.map((issue) => issue.code), ['00404']);
  });

  it('refuses a file over 5 MB', async () => {
    const { result } = await prepare(record({ note: 'causale '.repeat(700_000) }));
    assert.ok(!result.ok);
    assert.ok(result.issues.some((issue) => issue.code === 'SIZE'), JSON.stringify(result.issues.map((issue) => issue.code)));
  });

  describe('the original of a credit note', () => {
    const cited = (result: Prepared): string => (result.ok ? result.file.xml : '');

    it('accepts a numeric or text number, an absent section and an invalid date', async () => {
      for (const original of [
        { number: 12, prefixSuffix: '', date: new Date('2026-11-20T10:00:00.000Z') },
        { number: '12', date: new Date('2026-11-20T10:00:00.000Z') },
        { number: '12', prefixSuffix: 7, date: new Date('nope') },
      ]) {
        const { result, reads } = await prepare(creditNote(), original);
        assert.match(cited(result), /<DatiFattureCollegate>\s*<IdDocumento>12<\/IdDocumento>/);
        assert.equal(reads.length, 1);
      }
      const { result } = await prepare(creditNote(), { number: 12, date: 'text' });
      assert.doesNotMatch(cited(result), /<DatiFattureCollegate>\s*<IdDocumento>12<\/IdDocumento>\s*<Data>/);
    });

    it('goes without the citation, with a warning, when the original is missing or has no usable number', async () => {
      for (const original of [null, {}, { number: '  ' }, { number: Number.POSITIVE_INFINITY }, { number: { $gt: 1 } }]) {
        const failing = creditNote({ date: '2027-01-15T10:00:00.000Z' });
        const { result } = await prepare(failing, original);
        assert.ok(!result.ok);
        assert.deepEqual(result.issues.map((issue) => `${issue.code}:${issue.severity}`), ['00403:error', 'LINKED:warning']);
        const ok = await prepare(creditNote(), original);
        assert.doesNotMatch(cited(ok.result), /DatiFattureCollegate/);
      }
    });

    it('does not warn for a simplified credit note, which has no such block, nor when the form carried the citation', async () => {
      const simplified = await prepare(creditNote({ 'fattura_elettronica.tipo': 'TD08', date: '2027-01-15T10:00:00.000Z' }), null);
      assert.ok(!simplified.result.ok);
      assert.ok(!simplified.result.issues.some((issue) => issue.code === 'LINKED'));
      const typed = creditNote({ XML: { FatturaElettronicaBody: { DatiGenerali: { DatiFattureCollegate: [{ IdDocumento: '41', Data: '2026-11-20' }] } } } });
      assert.match(cited((await prepare(typed, null)).result), /<IdDocumento>41<\/IdDocumento>/);
    });
  });
});
