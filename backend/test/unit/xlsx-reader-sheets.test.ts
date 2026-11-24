import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsxSheets } from '../../src/shared/xlsx/reader.ts';
import { workbookOf, zipOf } from '../helpers/xlsx.ts';
import type { TestZipFile } from '../helpers/xlsx.ts';

const refused = (reason: string) => ({ name: 'XlsxError', reason });
const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const sheetXml = (value: string): string => `<worksheet ${MAIN}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`;

interface Book {
  /** The `<sheet>` elements, as written. */
  readonly sheets: readonly string[];
  /** The `<Relationship>` elements, as written (default: one for each of rId1..rIdN to sheetN.xml). */
  readonly rels?: readonly string[];
  readonly files?: readonly TestZipFile[];
  readonly shared?: string;
  readonly noRels?: boolean;
}

const sheetTag = (name: string, id: string): string => `<sheet name="${name}" sheetId="1" r:id="${id}"/>`;
const relTag = (id: string, target: string): string => `<Relationship Id="${id}" Type="x" Target="${target}"/>`;

function book(options: Book): Buffer {
  const files: TestZipFile[] = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: `<workbook ${MAIN} ${REL_NS}><sheets>${options.sheets.join('')}</sheets></workbook>` },
    ...(options.noRels === true ? [] : [{ name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${(options.rels ?? []).join('')}</Relationships>` }]),
    ...(options.shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: options.shared }]),
    ...(options.files ?? []),
  ];
  return zipOf(files);
}

/** A workbook of three sheets: Prodotti, Varianti, Categorie, each with one inline text. */
const three = (extra: Partial<Book> = {}): Buffer =>
  book({
    sheets: [sheetTag('Prodotti', 'rId1'), sheetTag('Varianti', 'rId2'), sheetTag('Categorie', 'rId3')],
    rels: [relTag('rId1', 'worksheets/p.xml'), relTag('rId2', 'worksheets/v.xml'), relTag('rId3', 'worksheets/c.xml')],
    files: [
      { name: 'xl/worksheets/p.xml', data: sheetXml('P') },
      { name: 'xl/worksheets/v.xml', data: sheetXml('V') },
      { name: 'xl/worksheets/c.xml', data: sheetXml('C') },
    ],
    ...extra,
  });

const textOf = (sheets: ReturnType<typeof readXlsxSheets>, name: string): unknown => sheets.get(name)?.rows[0]?.cells[0];

describe('readXlsxSheets', () => {
  it('reads the sheets that are asked for, by name, whatever their order', () => {
    const found = readXlsxSheets(three(), ['Categorie', 'Prodotti']);
    assert.deepEqual([...found.keys()].sort(), ['Categorie', 'Prodotti']);
    assert.equal(textOf(found, 'Prodotti'), 'P');
    assert.equal(textOf(found, 'Categorie'), 'C');
    assert.deepEqual(found.get('Prodotti'), { rows: [{ number: 1, cells: ['P'] }] });
    // The order of the names asked for does not matter, nor does the order of the sheets in the workbook.
    const reversed = book({
      sheets: [sheetTag('Categorie', 'rId3'), sheetTag('Prodotti', 'rId1')],
      rels: [relTag('rId1', 'worksheets/p.xml'), relTag('rId3', 'worksheets/c.xml')],
      files: [{ name: 'xl/worksheets/p.xml', data: sheetXml('P') }, { name: 'xl/worksheets/c.xml', data: sheetXml('C') }],
    });
    const again = readXlsxSheets(reversed, ['Prodotti', 'Varianti', 'Categorie']);
    assert.deepEqual([...again.keys()], ['Categorie', 'Prodotti']);
  });

  it('compares the names exactly: case and spaces count', () => {
    assert.equal(readXlsxSheets(three(), ['prodotti', 'Prodotti ', ' Prodotti']).size, 0);
  });

  it('leaves a sheet that the workbook does not have out of the result', () => {
    const found = readXlsxSheets(three(), ['Prodotti', 'Assente']);
    assert.deepEqual([...found.keys()], ['Prodotti']);
    assert.equal(found.has('Assente'), false);
  });

  it('answers an empty map, without opening the relationships, when no sheet asked for exists', () => {
    assert.equal(readXlsxSheets(three(), ['Nope']).size, 0);
    assert.equal(readXlsxSheets(three(), []).size, 0);
    // No relationships file at all: it is never needed when nothing is wanted.
    assert.equal(readXlsxSheets(book({ sheets: [sheetTag('A', 'rId1')], noRels: true }), ['B']).size, 0);
  });

  it('inflates only the sheets that are asked for', () => {
    const corrupt = { name: 'xl/worksheets/v.xml', data: sheetXml('V'), declared: { crc: 12345 } };
    const bomb = { name: 'xl/worksheets/c.xml', data: sheetXml('C'), declared: { size: 3 } };
    const bad = three({
      files: [{ name: 'xl/worksheets/p.xml', data: sheetXml('P') }, corrupt, bomb],
    });
    assert.equal(textOf(readXlsxSheets(bad, ['Prodotti']), 'Prodotti'), 'P');
    assert.throws(() => readXlsxSheets(bad, ['Varianti']), refused('malformed'));
    assert.throws(() => readXlsxSheets(bad, ['Categorie']), refused('limit'));
    // A sheet that is not in the archive at all matters only when it is asked for.
    const lacking = book({ sheets: [sheetTag('Prodotti', 'rId1'), sheetTag('Varianti', 'rId2')], rels: [relTag('rId1', 'worksheets/p.xml'), relTag('rId2', 'worksheets/gone.xml')], files: [{ name: 'xl/worksheets/p.xml', data: sheetXml('P') }] });
    assert.equal(textOf(readXlsxSheets(lacking, ['Prodotti']), 'Prodotti'), 'P');
    assert.throws(() => readXlsxSheets(lacking, ['Varianti']), refused('missing'));
  });

  it('does not inflate the shared strings when no wanted sheet exists, and reads them when one does', () => {
    const shared = `<sst ${MAIN}><si><t>shared text</t></si></sst>`;
    const cell = `<worksheet ${MAIN}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const withShared = (sharedXml: string): Buffer => book({ sheets: [sheetTag('S', 'rId1')], rels: [relTag('rId1', 'worksheets/s.xml')], files: [{ name: 'xl/worksheets/s.xml', data: cell }], shared: sharedXml });
    assert.equal(textOf(readXlsxSheets(withShared(shared), ['S']), 'S'), 'shared text');
    // Damaged shared strings: only a read that needs them fails.
    assert.equal(readXlsxSheets(withShared('<sst'), ['Other']).size, 0);
    assert.throws(() => readXlsxSheets(withShared('<sst'), ['S']), refused('malformed'));
    // No shared strings: a text index then points nowhere.
    assert.throws(() => readXlsxSheets(book({ sheets: [sheetTag('S', 'rId1')], rels: [relTag('rId1', 'worksheets/s.xml')], files: [{ name: 'xl/worksheets/s.xml', data: cell }] }), ['S']), refused('malformed'));
  });

  it('refuses a workbook that declares the same sheet name twice, even when it is not asked for', () => {
    const twice = book({ sheets: [sheetTag('Dup', 'rId1'), sheetTag('Dup', 'rId2')], rels: [relTag('rId1', 'a.xml'), relTag('rId2', 'b.xml')] });
    assert.throws(() => readXlsxSheets(twice, ['Dup']), refused('malformed'));
    assert.throws(() => readXlsxSheets(twice, ['Other']), refused('malformed'));
  });

  it('refuses a <sheet> that has no name, no id or an empty id', () => {
    assert.throws(() => readXlsxSheets(book({ sheets: ['<sheet sheetId="1" r:id="rId1"/>'] }), ['X']), refused('malformed'));
    assert.throws(() => readXlsxSheets(book({ sheets: ['<sheet name="X" sheetId="1"/>'] }), ['X']), refused('malformed'));
    assert.throws(() => readXlsxSheets(book({ sheets: ['<sheet name="X" r:id=""/>'] }), ['X']), refused('malformed'));
    // The check applies to the sheets that are not asked for, too.
    assert.throws(() => readXlsxSheets(book({ sheets: [sheetTag('Y', 'rId1'), '<sheet name="Z"/>'] }), ['Y']), refused('malformed'));
  });

  it('accepts a name that is empty', () => {
    const empty = book({ sheets: ['<sheet name="" r:id="rId1"/>'], rels: [relTag('rId1', 's.xml')], files: [{ name: 'xl/s.xml', data: sheetXml('E') }] });
    assert.equal(textOf(readXlsxSheets(empty, ['']), ''), 'E');
  });

  it('refuses a workbook that declares more than 64 sheets, before reading any of them', () => {
    const many = (count: number): Buffer =>
      book({
        sheets: Array.from({ length: count }, (_, index) => sheetTag(`S${String(index)}`, `rId${String(index)}`)),
        rels: Array.from({ length: count }, (_, index) => relTag(`rId${String(index)}`, `worksheets/s${String(index)}.xml`)),
        files: Array.from({ length: count }, (_, index) => ({ name: `xl/worksheets/s${String(index)}.xml`, data: sheetXml(String(index)) })),
      });
    // Zip entries are capped at 50 by default: the reader is given room for the archive.
    const limits = { maxEntries: 200 };
    const sixtyFour = readXlsxSheets(many(64), ['S0', 'S63'], limits);
    assert.deepEqual([...sixtyFour.keys()], ['S0', 'S63']);
    assert.throws(() => readXlsxSheets(many(65), ['S0'], limits), refused('limit'));
    assert.throws(() => readXlsxSheets(many(65), ['nothing'], limits), refused('limit'));
  });

  it('refuses a sheet that has no relationship, or one with an empty target', () => {
    const none = book({ sheets: [sheetTag('A', 'rId9')], rels: [relTag('rId1', 'a.xml')] });
    assert.throws(() => readXlsxSheets(none, ['A']), refused('missing'));
    const empty = book({ sheets: [sheetTag('A', 'rId1')], rels: [relTag('rId1', '')] });
    assert.throws(() => readXlsxSheets(empty, ['A']), refused('missing'));
    // The sheet that has no relationship matters only when it is wanted.
    const mixed = book({ sheets: [sheetTag('A', 'rId1'), sheetTag('B', 'rId2')], rels: [relTag('rId1', 'a.xml')], files: [{ name: 'xl/a.xml', data: sheetXml('A') }] });
    assert.equal(textOf(readXlsxSheets(mixed, ['A']), 'A'), 'A');
    assert.throws(() => readXlsxSheets(mixed, ['A', 'B']), refused('missing'));
  });

  it('reads a relationship edge case the way the first valid one says', () => {
    const rels = [
      '<Relationship Type="x" Target="ignored-no-id.xml"/>',
      '<Relationship Id="rId1" Type="x"/>',
      '<Other Id="rId1" Target="not-a-relationship.xml"/>',
      relTag('rId1', 'good.xml'),
      relTag('rId1', 'second-with-same-id.xml'),
    ];
    const edge = book({ sheets: [sheetTag('A', 'rId1')], rels, files: [{ name: 'xl/good.xml', data: sheetXml('good') }, { name: 'xl/second-with-same-id.xml', data: sheetXml('second') }, { name: 'xl/not-a-relationship.xml', data: sheetXml('other') }] });
    assert.equal(textOf(readXlsxSheets(edge, ['A']), 'A'), 'good');
    // A relationship with no Target is not a relationship: the sheet has none.
    assert.throws(() => readXlsxSheets(book({ sheets: [sheetTag('A', 'rId1')], rels: ['<Relationship Id="rId1" Type="x"/>'] }), ['A']), refused('missing'));
  });

  it('resolves absolute and relative targets inside the archive', () => {
    const file = { name: 'xl/worksheets/s.xml', data: sheetXml('S') };
    for (const target of ['worksheets/s.xml', '/xl/worksheets/s.xml', './worksheets/s.xml', '../xl/worksheets/s.xml', 'worksheets//s.xml', 'worksheets/./s.xml']) {
      const found = readXlsxSheets(book({ sheets: [sheetTag('A', 'rId1')], rels: [relTag('rId1', target)], files: [file] }), ['A']);
      assert.equal(textOf(found, 'A'), 'S', target);
    }
  });

  it('refuses a target that climbs out of the archive', () => {
    for (const target of ['../../evil.xml', '../../../x', '/../x.xml', 'a/../../../x']) {
      const evil = book({ sheets: [sheetTag('A', 'rId1')], rels: [relTag('rId1', target)], files: [{ name: 'evil.xml', data: sheetXml('evil') }] });
      assert.throws(() => readXlsxSheets(evil, ['A']), refused('unsafe'), target);
    }
  });

  it('applies the limits it is given and refuses what the archive refuses', () => {
    assert.throws(() => readXlsxSheets(three(), ['Prodotti'], { maxRows: 0 }), refused('limit'));
    assert.throws(() => readXlsxSheets(Buffer.from('not a zip at all'), ['Prodotti']), refused('notZip'));
    assert.throws(() => readXlsxSheets(zipOf([{ name: 'other.txt', data: 'x' }]), ['Prodotti']), refused('missing'));
    assert.throws(() => readXlsxSheets(book({ sheets: [sheetTag('A', 'rId1')], noRels: true }), ['A']), refused('missing'));
  });

  it('reads the workbooks the generic helper builds, picking the sheet by its name', () => {
    const workbook = workbookOf([['a', 1]]);
    assert.deepEqual(readXlsxSheets(workbook, ['Listino']).get('Listino')?.rows, [{ number: 1, cells: ['a', 1] }]);
    assert.deepEqual(readXlsxSheets(workbook, ['Altro']).get('Altro')?.rows, [{ number: 1, cells: [999] }]);
    assert.equal(readXlsxSheets(workbook, ['Prodotti']).size, 0);
  });
});
