import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REPORTED_PROBLEMS, MAX_TOBACCOS, parseTobaccoSheet } from '../../src/modules/tobaccos/tobaccos.sheet.ts';
import type { CellValue, SheetRow } from '../../src/shared/xlsx/reader.ts';

const HEADER: SheetRow = { number: 1, cells: ['Categoria', 'Codice'] };

/** A valid row of the file; the cells given replace the ones of the same position. */
function row(number: number, ...overrides: Array<[number, CellValue]>): SheetRow {
  const cells: CellValue[] = ['Sigarette', `C${String(number)}`, `Prodotto ${String(number)}`, 'Prod', 12.5, 6.25, 20, 20, 'Una descrizione', '8000000000001', 10, '8000000000002', 1, ...Array<CellValue>(7).fill(null)];
  for (const [index, value] of overrides) {
    cells[index] = value;
  }
  return { number, cells };
}
/** The details of the 422 a list of rows gives. */
function problems(rows: readonly SheetRow[]): Array<{ field: string; issue: string }> {
  try {
    parseTobaccoSheet(rows);
  } catch (error) {
    assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
    return (error as { details: Array<{ field: string; issue: string }> }).details;
  }
  return assert.fail('expected a 422');
}

describe('parseTobaccoSheet', () => {
  it('maps the columns of the official file to the documents of the legacy', () => {
    const documents = parseTobaccoSheet([HEADER, row(2), row(3, [0, '  Trinciati  '], [3, null], [4, '1234,5'], [5, '7.5'], [6, null], [7, 3], [8, null], [9, ' 8000000000099 '], [10, '12'], [11, null], [12, 99])]);
    assert.deepEqual(documents[0], {
      category: 'Sigarette',
      code: 'C2',
      name: 'Prodotto 2',
      shortName: 'Prod',
      priceKg: 12.5,
      price: 6.25,
      unitWeight: 20,
      numPieces: 20,
      description: 'Una descrizione',
      barcodes: [
        { barcode: '8000000000001', quantity: 10 },
        { barcode: '8000000000002', quantity: 1 },
      ],
    });
    // A pair without a barcode is dropped with its quantity, a quantity that is empty is null, a comma is a decimal separator.
    assert.deepEqual(documents[1], {
      category: 'Trinciati',
      code: 'C3',
      name: 'Prodotto 3',
      shortName: '',
      priceKg: 1234.5,
      price: 7.5,
      unitWeight: null,
      numPieces: 3,
      description: '',
      barcodes: [{ barcode: '8000000000099', quantity: 12 }],
    });
  });

  it('reads codes and barcodes written as numbers, and skips the header, blank rows and rows with only blanks', () => {
    const documents = parseTobaccoSheet([HEADER, row(2, [1, 12345], [9, 8000000000123]), { number: 3, cells: ['  ', null, '\t'] }, row(5, [9, null], [11, null]), { number: 6, cells: [] }]);
    assert.deepEqual(documents.map((document) => [document.code, document.barcodes.length, document.barcodes[0]?.barcode]), [['12345', 2, '8000000000123'], ['C5', 0, undefined]]);
  });

  it('refuses a file with no product', () => {
    assert.deepEqual(problems([HEADER]), [{ field: 'file', issue: 'required' }]);
    assert.deepEqual(problems([]), [{ field: 'file', issue: 'required' }]);
  });

  it('reports the row and the field of every problem, checking every row before refusing', () => {
    const rows = [
      HEADER,
      row(2, [1, null], [2, null]),
      row(3, [1, 'C2']),
      row(4, [1, 'C2']),
      row(5, [1, 'bad;code'], [4, -1], [5, 'abc'], [6, '-3'], [7, 2.5]),
      row(6, [4, 2_000_000_000], [7, 1_000_000_001], [5, true], [0, false], [2, 'x'.repeat(201)], [3, 'x'.repeat(101)], [8, 'x'.repeat(1001)], [1, 'x'.repeat(41)]),
      row(7, [2, 'bad\u0000name'], [9, '123'], [11, 'abcdefgh'], [10, 1.5], [12, 100_001], [13, '123456789012345'], [14, 4]),
      row(8, [10, true], [12, 'x']),
    ];
    assert.deepEqual(problems(rows), [
      { field: 'rows[2].code', issue: 'required' },
      { field: 'rows[2].name', issue: 'required' },
      { field: 'rows[4].code', issue: 'taken' },
      { field: 'rows[5].code', issue: 'pattern' },
      { field: 'rows[5].priceKg', issue: 'minimum' },
      { field: 'rows[5].price', issue: 'type' },
      { field: 'rows[5].unitWeight', issue: 'minimum' },
      { field: 'rows[5].numPieces', issue: 'format' },
      { field: 'rows[6].code', issue: 'maxLength' },
      { field: 'rows[6].name', issue: 'maxLength' },
      { field: 'rows[6].category', issue: 'type' },
      { field: 'rows[6].shortName', issue: 'maxLength' },
      { field: 'rows[6].priceKg', issue: 'maximum' },
      { field: 'rows[6].price', issue: 'type' },
      { field: 'rows[6].numPieces', issue: 'maximum' },
      { field: 'rows[6].description', issue: 'maxLength' },
      { field: 'rows[7].name', issue: 'pattern' },
      { field: 'rows[7].barcodes[0].barcode', issue: 'format' },
      { field: 'rows[7].barcodes[0].quantity', issue: 'format' },
      { field: 'rows[7].barcodes[1].barcode', issue: 'format' },
      { field: 'rows[7].barcodes[1].quantity', issue: 'maximum' },
      { field: 'rows[7].barcodes[2].barcode', issue: 'maxLength' },
      { field: 'rows[8].barcodes[0].quantity', issue: 'type' },
      { field: 'rows[8].barcodes[1].quantity', issue: 'type' },
    ]);
  });

  it('stops at the most problems an answer reports', () => {
    const rows = [HEADER, ...Array.from({ length: 200 }, (_row, index) => row(index + 2, [1, null]))];
    assert.equal(problems(rows).length, MAX_REPORTED_PROBLEMS);
  });

  it('refuses a list with too many products', () => {
    const rows = [HEADER, ...Array.from({ length: MAX_TOBACCOS + 1 }, (_row, index) => ({ number: index + 2, cells: ['c', `code${String(index)}`, 'n'] as CellValue[] }))];
    assert.deepEqual(problems(rows), [{ field: 'file', issue: 'tooMany' }]);
    assert.equal(parseTobaccoSheet(rows.slice(0, MAX_TOBACCOS + 1)).length, MAX_TOBACCOS);
  });

  it('refuses a huge text in constant time, before any scan, and never takes it for a blank (regression: spaces cited by thousands of cells)', () => {
    const spaces = ' '.repeat(2_000_000);
    const started = Date.now();
    const rows = [HEADER, ...Array.from({ length: 200 }, (_row, index) => ({ number: index + 2, cells: Array<CellValue>(29).fill(spaces) }))];
    const found = problems(rows);
    assert.equal(found.length, 50);
    assert.equal(found[0]!.issue, 'maxLength');
    assert.ok(Date.now() - started < 1000, 'fast');
    // Each field refuses it on its own: a number written as a text, a barcode, a description.
    assert.deepEqual(problems([HEADER, row(2, [5, ' '.repeat(1_000_000)])]), [{ field: 'rows[2].price', issue: 'type' }]);
    assert.deepEqual(problems([HEADER, row(2, [8, 'x'.repeat(1_000_000)])]), [{ field: 'rows[2].description', issue: 'maxLength' }]);
    // A blank of ordinary length is still a blank.
    assert.equal(parseTobaccoSheet([HEADER, row(2), { number: 3, cells: [' '.repeat(900)] }]).length, 1);
  });

  it('keeps a single-line text to one line and without characters that reorder or hide text, except the description', () => {
    for (const [index, field] of [[0, 'category'], [2, 'name'], [3, 'shortName']] as const) {
      for (const bad of ['a\nb', 'a\tb', 'a\u202eb', 'a\u200bb', 'a\u2066b', 'a\ufeffb']) {
        assert.deepEqual(problems([HEADER, row(2, [index, bad])]), [{ field: `rows[2].${field}`, issue: 'pattern' }], `${field} ${JSON.stringify(bad)}`);
      }
    }
    assert.equal(parseTobaccoSheet([HEADER, row(2, [8, 'riga uno\nriga\tdue'])])[0]!.description, 'riga uno\nriga\tdue');
  });

  it('turns a negative zero into a zero', () => {
    assert.equal(Object.is(parseTobaccoSheet([HEADER, row(2, [4, -0])])[0]!.priceKg, 0), true);
  });
});
