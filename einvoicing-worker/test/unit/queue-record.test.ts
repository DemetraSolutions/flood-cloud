import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decimal } from '../../src/invoice/decimal.ts';
import { readQueueRecord } from '../../src/invoice/queue-record.ts';
import type { QueueRecord } from '../../src/invoice/queue-record.ts';
import { baseRecord, fixtures, withValues } from '../fixtures/records.ts';

function read(record: unknown): QueueRecord {
  const result = readQueueRecord(record);
  assert.ok(result.ok, 'the record has problems');
  return result.value;
}

function issues(record: unknown): string[] {
  const result = readQueueRecord(record);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}:${issue.issue}`);
}

describe('readQueueRecord', () => {
  it('reads the base record into typed fields', () => {
    const record = read(baseRecord());
    assert.equal(record.date?.toISOString(), '2026-11-27T10:15:00.000Z');
    assert.equal(record.number, '42');
    assert.equal(record.documentType, 'TD01');
    assert.equal(record.progressive, '7');
    assert.deepEqual(record.total, decimal(3n, 0));
    assert.deepEqual(record.customerType, decimal(1n, 0));
    assert.equal(record.lines.length, 2);
    assert.equal(record.lines[0]?.name, 'Caffè espresso');
    assert.deepEqual(record.lines[0]?.price, decimal(81967213n, 8));
    assert.equal(record.company.discountLines, false);
    assert.equal(record.company.regime, 'RF01');
    assert.equal(record.counterpart.channel, 'CD');
    assert.equal(record.fullMeal.status, false);
    assert.equal(record.xml.paymentDetails.length, 0);
  });

  it('reads every optional block of the form data', () => {
    const record = read(fixtures['optional-blocks']?.());
    assert.equal(record.lines[0]?.otherData[0]?.TipoDato, 'ORDINE');
    assert.equal(record.lines[0]?.otherData[0]?.RiferimentoData?.toISOString(), '2026-11-01T12:00:00.000Z');
    assert.equal(record.xml.orders[0]?.CodiceCIG, 'ZA12345678');
    assert.equal(record.xml.transport.carrier.Denominazione, 'Corriere Veloce S.r.l.');
    assert.deepEqual(record.xml.transport.NumeroColli, decimal(2n, 0));
    assert.equal(record.xml.transport.IndirizzoResa.Comune, 'Napoli');
    assert.equal(record.xml.paymentConditions, 'TP02');
    assert.equal(record.xml.paymentDetails.length, 2);
    assert.equal(record.xml.paymentDetails[0]?.IBAN, 'it60 x054 2811 1010 0000 0123 456');
    assert.equal(record.xml.paymentDetails[1]?.ImportoPagamento, null);
  });

  it('reads the split payment flag, the discount type, the linked invoices and the rectified invoice', () => {
    const split = read(fixtures['public-administration-split-payment']?.());
    assert.equal(split.xml.splitPayment, true);
    assert.equal(split.xml.orders[0]?.IdDocumento, 'ORD-77');
    const credit = read(fixtures['credit-note']?.());
    assert.equal(credit.xml.linkedInvoices[0]?.IdDocumento, '41');
    const rectified = read(fixtures['simplified-td08-rectified']?.());
    assert.equal(rectified.xml.rectified.NumeroFR, '40');
    const typed = read(withValues(baseRecord(), { 'XML.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo': 'MG' }));
    assert.equal(typed.xml.discountType, 'MG');
  });

  it('reads a list of purchase orders and a single object alike', () => {
    const list = read(withValues(baseRecord(), { 'XML.FatturaElettronicaBody.DatiGenerali.DatiOrdineAcquisto': [{ IdDocumento: 'A' }, { IdDocumento: 'B' }] }));
    assert.deepEqual(list.xml.orders.map((order) => order.IdDocumento), ['A', 'B']);
  });

  it('reads an empty record as empty fields, not as problems', () => {
    const record = read({});
    assert.equal(record.date, null);
    assert.equal(record.number, '');
    assert.equal(record.lines.length, 0);
    assert.equal(record.company.name, '');
    assert.equal(read(null).company.code, '');
  });

  it('localizes the name of a line', () => {
    const lineName = (name: unknown): string => read({ records: [{ name }] }).lines[0]?.name ?? 'none';
    assert.equal(lineName('Plain'), 'Plain');
    assert.equal(lineName({ it: 'Italiano', en: 'English' }), 'Italiano');
    assert.equal(lineName({ en: 'English' }), 'English');
    assert.equal(lineName({ it: 5, en: 'English' }), 'English');
    assert.equal(lineName({ en: 5 }), '');
    assert.equal(lineName(undefined), '');
  });

  it('accepts numbers where codes are stored and numeric text where numbers are', () => {
    const record = read({ number: 12, company: { code: 1234567890 }, total: '10.50', records: [{ qt: '2', price: { price: '1.5', tax: 22 } }] });
    assert.equal(record.number, '12');
    assert.equal(record.company.code, '1234567890');
    assert.deepEqual(record.total, decimal(1050n, 2));
    assert.deepEqual(record.lines[0]?.qt, decimal(2n, 0));
  });

  it('reads dates from a Date, an ISO date-time and a plain date', () => {
    assert.equal(read({ date: new Date('2026-01-02T03:04:05Z') }).date?.toISOString(), '2026-01-02T03:04:05.000Z');
    assert.equal(read({ date: '2026-01-02T03:04:05+01:00' }).date?.toISOString(), '2026-01-02T02:04:05.000Z');
    assert.equal(read({ date: '2026-01-02' }).date?.toISOString(), '2026-01-02T12:00:00.000Z');
    assert.equal(read({ date: '' }).date, null);
  });
});

describe('readQueueRecord: problems', () => {
  it('reports a record that is not an object', () => {
    assert.deepEqual(issues('text'), ['record:invalid']);
    assert.deepEqual(issues([]), ['record:invalid']);
    assert.deepEqual(issues(new Date()), ['record:invalid']);
  });

  it('reports every field of the wrong type with its path and never the value', () => {
    const result = readQueueRecord({
      date: 'yesterday',
      number: { a: 1 },
      total: 'abc',
      customerType: true,
      discountPercentage: Number.NaN,
      records: 'not a list',
      sale: { fullMeal: { status: 'yes', quantity: [] } },
      company: { code: Number.NaN, settings: { global: { discountLines: 'si' } }, fattura_elettronica: 5 },
      counterpart: [],
      XML: { FatturaElettronicaBody: { DatiGenerali: { DatiTrasporto: { PesoLordo: 'heavy', DataOraRitiro: 7 } }, DatiPagamento: { DettaglioPagamento: 'x' } } },
    });
    assert.equal(result.ok, false);
    const paths = result.ok ? [] : result.issues.map((issue) => issue.path);
    for (const expected of [
      'date',
      'number',
      'total',
      'customerType',
      'discountPercentage',
      'records',
      'sale.fullMeal.status',
      'sale.fullMeal.quantity',
      'company.code',
      'company.settings.global.discountLines',
      'company.fattura_elettronica',
      'counterpart',
      'XML.FatturaElettronicaBody.DatiGenerali.DatiTrasporto.PesoLordo',
      'XML.FatturaElettronicaBody.DatiGenerali.DatiTrasporto.DataOraRitiro',
      'XML.FatturaElettronicaBody.DatiPagamento.DettaglioPagamento',
    ]) {
      assert.ok(paths.includes(expected), `${expected} in ${paths.join(', ')}`);
    }
    assert.ok(!JSON.stringify(result).includes('yesterday'));
    assert.ok(!JSON.stringify(result).includes('heavy'));
  });

  it('reports lines and their parts by index', () => {
    assert.deepEqual(issues({ records: [5, { price: 'x', qt: 'bad' }, { price: { taxData: 3 }, XML: { AltriDatiGestionali: [1, 'x'] } }] }).sort(), [
      'records[0]:invalid',
      'records[1].price:invalid',
      'records[1].qt:invalid',
      'records[2].XML.AltriDatiGestionali[0]:invalid',
      'records[2].XML.AltriDatiGestionali[1]:invalid',
      'records[2].price.taxData:invalid',
    ]);
  });

  it('reports a date that does not parse, in any of its forms', () => {
    assert.deepEqual(issues({ date: new Date(Number.NaN) }), ['date:invalid']);
    assert.deepEqual(issues({ date: '2026-13-45' }), ['date:invalid']);
    assert.deepEqual(issues({ date: '2026-02-30T99:00:00Z' }), ['date:invalid']);
    assert.deepEqual(issues({ date: 20260101 }), ['date:invalid']);
  });

  it('reports the blocks of the form data that have the wrong shape', () => {
    const general = 'XML.FatturaElettronicaBody.DatiGenerali';
    assert.deepEqual(
      issues({ XML: { FatturaElettronicaBody: { DatiGenerali: { DatiOrdineAcquisto: [1], DatiFattureCollegate: 'x', DatiTrasporto: { IndirizzoResa: 4, DatiAnagraficiVettore: 3 } } } } }).sort(),
      [
        `${general}.DatiFattureCollegate:invalid`,
        `${general}.DatiOrdineAcquisto[0]:invalid`,
        `${general}.DatiTrasporto.DatiAnagraficiVettore:invalid`,
        `${general}.DatiTrasporto.IndirizzoResa:invalid`,
      ],
    );
  });
});
