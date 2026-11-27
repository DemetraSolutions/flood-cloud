import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adjustedUnitPrice, lineTotal, priceAfterPercent, taxableAmount, taxAmount } from '../../src/invoice/amounts.ts';
import { formatDecimal, parseDecimal } from '../../src/invoice/decimal.ts';
import type { Decimal } from '../../src/invoice/decimal.ts';
import type { ScontoMaggiorazione } from '../../src/invoice/model.ts';

function d(text: string): Decimal {
  const value = parseDecimal(text);
  assert.ok(value !== null);
  return value;
}

const show = (value: Decimal): string => formatDecimal(value, 2, 12);

describe('PrezzoTotale: the worked examples of the SdI checks list (version 2.1, pages 28 to 30)', () => {
  it('case 1: cascading discounts as amounts', () => {
    const discounts: ScontoMaggiorazione[] = [
      { Tipo: 'SC', Importo: d('10.05') },
      { Tipo: 'SC', Importo: d('5.25') },
      { Tipo: 'SC', Importo: d('4.70') },
    ];
    assert.equal(show(adjustedUnitPrice(d('500.00'), discounts)), '480.00');
    assert.equal(show(lineTotal(d('500.00'), d('100.00'), discounts)), '48000.00');
  });

  it('case 2: cascading discounts as percentages', () => {
    const discounts: ScontoMaggiorazione[] = [
      { Tipo: 'SC', Percentuale: d('8.50') },
      { Tipo: 'SC', Percentuale: d('5.15') },
      { Tipo: 'SC', Percentuale: d('3.00') },
    ];
    assert.equal(show(adjustedUnitPrice(d('500.00'), discounts)), '420.9205875');
    assert.equal(show(lineTotal(d('500.00'), d('100.00'), discounts)), '42092.05875');
  });

  it('case 3: amounts and percentages mixed, and only the amount of a block that has both', () => {
    const discounts: ScontoMaggiorazione[] = [
      { Tipo: 'SC', Percentuale: d('8.50') },
      { Tipo: 'SC', Percentuale: d('5.15'), Importo: d('23.56') },
      { Tipo: 'SC', Importo: d('15.00') },
      { Tipo: 'SC', Percentuale: d('2.00') },
    ];
    assert.equal(show(adjustedUnitPrice(d('500.00'), discounts)), '410.5612');
    assert.equal(show(lineTotal(d('500.00'), d('100.00'), discounts)), '41056.12');
  });
});

describe('line total', () => {
  it('adds a surcharge (MG) and counts a missing quantity as one', () => {
    assert.equal(show(lineTotal(d('10'), undefined, [{ Tipo: 'MG', Percentuale: d('10.00') }])), '11.00');
    assert.equal(show(lineTotal(d('10'), undefined, [{ Tipo: 'MG', Importo: d('2.5') }])), '12.50');
  });

  it('treats a block with neither amount nor percentage as no change', () => {
    assert.equal(show(lineTotal(d('10'), d('2'), [{ Tipo: 'SC' }])), '20.00');
  });

  it('rounds to eight decimals', () => {
    assert.equal(formatDecimal(lineTotal(d('0.333333333'), d('1'), []), 2, 12), '0.33333333');
  });

  it('applies a percentage discount to the unit price at eight decimals', () => {
    assert.equal(show(priceAfterPercent(d('10.333333'), d('5'))), '9.81666635');
    assert.equal(show(priceAfterPercent(d('2'), d('0'))), '2.00');
    assert.equal(show(priceAfterPercent(d('2'), d('100'))), '0.00');
  });
});

describe('VAT summary', () => {
  it('rounds the tax half away from zero (check 00421)', () => {
    assert.equal(show(taxAmount(d('1500.2448'), d('100.00'))), '1500.24');
    assert.equal(show(taxAmount(d('1500.2458'), d('100.00'))), '1500.25');
    assert.equal(show(taxAmount(d('15.12'), d('22.00'))), '3.33');
    assert.equal(show(taxAmount(d('-15.12'), d('22.00'))), '-3.33');
    assert.equal(show(taxAmount(d('100'), d('0.00'))), '0.00');
  });

  it('rounds the sum of the line totals to two decimals (check 00422)', () => {
    assert.equal(show(taxableAmount([d('26.50499915'), d('0.00500000')])), '26.51');
    assert.equal(show(taxableAmount([d('10.004'), d('-0.001')])), '10.00');
    assert.equal(show(taxableAmount([])), '0.00');
  });
});
