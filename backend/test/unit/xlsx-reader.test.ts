import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../src/shared/http/errors.ts';
import { XLSX_MESSAGES, XLSX_REASONS, XlsxError, xlsxErrorToAppError } from '../../src/shared/xlsx/errors.ts';
import { readXlsx } from '../../src/shared/xlsx/reader.ts';
import { columnName, workbookOf, zipOf } from '../helpers/xlsx.ts';
import type { WorkbookOptions } from '../helpers/xlsx.ts';

const refused = (reason: string) => ({ name: 'XlsxError', reason });
const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const sheet = (rows: string): string => `<worksheet ${MAIN}><sheetData>${rows}</sheetData></worksheet>`;
const readSheet = (xml: string, options: WorkbookOptions = {}, limits = {}) => readXlsx(workbookOf([], { ...options, sheetXml: xml }), limits);

describe('XLSX reader', () => {
  it('reads text, numbers and booleans of the first worksheet, with the numbers of the rows', () => {
    const { rows } = readXlsx(workbookOf([['Categoria', 'Codice', 3.5], ['A', null, true, -2, 1e21]]));
    assert.deepEqual(rows, [
      { number: 1, cells: ['Categoria', 'Codice', 3.5] },
      { number: 2, cells: ['A', null, true, -2, 1e21] },
    ]);
  });

  it('reads inline strings, formula results and prefixed elements', () => {
    assert.deepEqual(readXlsx(workbookOf([['x', 1]], { strings: 'inline', noShared: true })).rows[0]!.cells, ['x', 1]);
    assert.deepEqual(readXlsx(workbookOf([['x', 1]], { strings: 'formula' })).rows[0]!.cells, ['x', 1]);
    assert.deepEqual(readXlsx(workbookOf([['x', 1]], { prefix: 'x' })).rows[0]!.cells, ['x', 1]);
  });

  it('skips cells and rows: gaps are null, empty rows are left out, rows keep their numbers', () => {
    const xml = sheet('<row r="2"><c r="C2"><v>1</v></c></row><row r="5"/><row r="7"><c r="B7" s="1"/><c r="D7" t="n"><v>  </v></c><c r="E7" t="e"><v>#N/A</v></c><c r="F7" t="inlineStr"/></row><row r="9"><c r="A9" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r><rPh><t>ignored</t></rPh></is></c></row>');
    assert.deepEqual(readSheet(xml).rows, [
      { number: 2, cells: [null, null, 1] },
      { number: 9, cells: ['ab'] },
    ]);
  });

  it('numbers rows and cells that carry no reference one after the other', () => {
    const { rows } = readXlsx(workbookOf([['a', 'b'], ['c']], { references: false }));
    assert.deepEqual(rows, [
      { number: 1, cells: ['a', 'b'] },
      { number: 2, cells: ['c'] },
    ]);
    assert.deepEqual(readSheet(sheet('<row><c><v>1</v></c></row><row r="4"><c><v>2</v></c></row><row><c><v>3</v></c></row>')).rows.map((row) => row.number), [1, 4, 5]);
  });

  it('reads the phonetic runs out of the shared strings and keeps the rich text', () => {
    const shared = `<sst ${MAIN}><si><r><t>Ra</t></r><r><t>w</t></r><rPh sb="0"><t>ignored</t></rPh></si><si/></sst>`;
    const xml = sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v/></c></row>');
    assert.deepEqual(readSheet(xml, { sharedXml: shared }).rows[0]!.cells, ['Raw', '']);
  });

  it('reads a workbook without shared strings, a target with a path and the text and date types', () => {
    const xml = sheet('<row r="1"><c r="A1" t="str"><v>t</v></c><c r="B1" t="d"><v>2026-01-02</v></c></row>');
    assert.deepEqual(readSheet(xml, { noShared: true, target: '/xl/worksheets/sheet1.xml' }).rows[0]!.cells, ['t', '2026-01-02']);
    assert.deepEqual(readSheet(xml, { target: '../xl/./worksheets/sheet1.xml' }).rows[0]!.cells, ['t', '2026-01-02']);
  });

  it('refuses a damaged shared string index, boolean, number or type', () => {
    for (const cell of ['<c r="A1" t="s"><v>7</v></c>', '<c r="A1" t="s"><v>x</v></c>', '<c r="A1" t="b"><v>2</v></c>', '<c r="A1"><v>abc</v></c>', '<c r="A1"><v>Infinity</v></c>', '<c r="A1" t="z"><v>1</v></c>']) {
      assert.throws(() => readSheet(sheet(`<row r="1">${cell}</row>`)), refused('malformed'), cell);
    }
  });

  it('refuses rows and cells that are out of order, outside a row or that do not agree with their row', () => {
    for (const rows of ['<row r="2"/><row r="1"/>', '<row r="1"/><row r="1"/>', '<row r="0"/>', '<row r="x"/>', '<row r="1e1"/>', '<row r=""/>', '<row r="1"><c r="B1"><v>1</v></c><c r="A1"><v>1</v></c></row>', '<row r="1"><c r="A2"><v>1</v></c></row>', '<row r="1"><c r="1A"><v>1</v></c></row>', '<c r="A1"><v>1</v></c>']) {
      assert.throws(() => readSheet(sheet(rows)), refused('malformed'), rows);
    }
  });

  it('refuses a worksheet with too many rows or columns, and counts only the cells that hold a value', () => {
    assert.throws(() => readSheet(sheet('<row r="101"/>'), {}, { maxRows: 100 }), refused('limit'));
    assert.throws(() => readSheet(sheet('<row r="1"><c r="D1"><v>1</v></c></row>'), {}, { maxColumns: 3 }), refused('limit'));
    assert.deepEqual(readSheet(sheet('<row r="1"><c r="A1"><v>1</v></c><c r="Z1"/></row>'), {}, { maxColumns: 3 }).rows[0]!.cells, [1]);
    assert.equal(readSheet(sheet('<row r="100"><c r="A100"><v>1</v></c></row>'), {}, { maxRows: 100 }).rows[0]!.number, 100);
  });

  it('refuses a workbook that has no sheet or whose relationship does not lead to one', () => {
    const files = (workbook: string, rels: string, extra = '') => zipOf([
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: rels },
      { name: 'xl/worksheets/sheet1.xml', data: sheet('') },
      ...(extra === '' ? [] : [{ name: extra, data: '<a/>' }]),
    ]);
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
    assert.doesNotThrow(() => readXlsx(files('<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>', rels)));
    assert.throws(() => readXlsx(files('<workbook><sheets/></workbook>', rels)), refused('missing'));
    assert.throws(() => readXlsx(files('<workbook><sheets><sheet r:id=""/></sheets></workbook>', rels)), refused('missing'));
    assert.throws(() => readXlsx(files('<workbook><sheets><sheet r:id="rId9"/></sheets></workbook>', rels)), refused('missing'));
    assert.throws(() => readXlsx(files('<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>', '<Relationships><Relationship Id="rId1" Target=""/></Relationships>')), refused('missing'));
    assert.throws(() => readXlsx(files('<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>', '<Relationships><Relationship Id="rId1" Target="worksheets/none.xml"/></Relationships>')), refused('missing'));
    assert.throws(() => readXlsx(files('<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>', '<Relationships><Relationship Id="rId1" Target="../../../etc/passwd"/></Relationships>')), refused('unsafe'));
    assert.throws(() => readXlsx(zipOf([{ name: 'other.txt', data: 'x' }])), refused('missing'));
  });

  it('refuses a DOCTYPE, an entity and broken XML in any part', () => {
    assert.throws(() => readSheet('<!DOCTYPE worksheet [<!ENTITY a "b">]><worksheet/>'), refused('unsafe'));
    assert.throws(() => readSheet(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>&a;</t></is></c></row>')), refused('malformed'));
    assert.throws(() => readSheet('<worksheet><sheetData>'), refused('malformed'));
    assert.throws(() => readSheet(sheet(''), { sharedXml: '<!DOCTYPE sst><sst/>' }), refused('unsafe'));
    assert.throws(() => readXlsx(workbookOf([], { extra: [{ name: 'xl/workbook.xml', data: 'x' }] })), refused('unsafe'));
  });

  it('refuses archives that exceed the limits: bombs, ratios, too many rows', () => {
    const bomb = workbookOf([], { sheetXml: `<worksheet>${' '.repeat(3_000_000)}<sheetData/></worksheet>` });
    assert.throws(() => readXlsx(bomb), refused('limit'));
    assert.throws(() => readXlsx(bomb, { maxRatio: 100_000, maxEntryBytes: 1000 }), refused('limit'));
    const rows = Array.from({ length: 20 }, (_row, index) => [`r${index}`]);
    assert.throws(() => readXlsx(workbookOf(rows), { maxRows: 10 }), refused('limit'));
    assert.throws(() => readXlsx(Buffer.from('not a workbook, just text, long enough to look at')), refused('notZip'));
  });

  it('refuses a cell of more than 32 767 characters, wherever the text comes from', () => {
    const noise = (length: number): string => randomBytes(length / 2).toString('hex');
    const long = noise(32_768);
    assert.throws(() => readXlsx(workbookOf([[long]])), refused('limit'));
    assert.throws(() => readXlsx(workbookOf([[long]], { strings: 'inline', noShared: true })), refused('limit'));
    assert.throws(() => readXlsx(workbookOf([[long]], { strings: 'formula', noShared: true })), refused('limit'));
    assert.equal(readXlsx(workbookOf([[noise(32_766) + 'x']])).rows[0]!.cells[0]!.toString().length, 32_767);
  });

  it('counts a shared string every time a cell cites it: the text the rows hold is bounded (a billion laughs of spaces)', () => {
    // One string of 30 000 spaces cited by 10 000 cells expands to 300 million characters.
    const shared = `<sst ${MAIN}><si><t>${' '.repeat(30_000)}</t></si></sst>`;
    const cells = Array.from({ length: 50 }, (_cell, index) => `<c r="${columnName(index + 1)}1" t="s"><v>0</v></c>`).join('');
    const bomb = sheet(Array.from({ length: 200 }, (_row, index) => `<row r="${index + 1}">${cells.replaceAll('1"', `${index + 1}"`)}</row>`).join(''));
    const started = Date.now();
    assert.throws(() => readSheet(bomb, { sharedXml: shared }), refused('limit'));
    assert.ok(Date.now() - started < 1500, 'refused fast');
    assert.throws(() => readSheet(sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c></row>'), { sharedXml: `<sst><si><t>${'y'.repeat(600)}</t></si></sst>` }, { maxCellTextTotal: 1000 }), refused('limit'));
  });

  it('sees a cell only inside its row', () => {
    assert.throws(() => readSheet(sheet('<row r="1"><c r="A1"><v>1</v></c></row><c r="A1"><v>2</v></c>')), refused('malformed'));
  });

  it('refuses characters XML does not allow, raw or as references', () => {
    for (const text of ['a\u0001b', 'a&#1;b', 'a&#xFFFE;b', 'a&#xFFFF;b', 'a\uffffb']) {
      assert.throws(() => readSheet(sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>`)), refused('malformed'), text);
    }
    assert.throws(() => readSheet(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[a\u0002]]></t></is></c></row>')), refused('malformed'));
    assert.equal(readSheet(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>a&#9;&#10;&#13;b</t></is></c></row>')).rows[0]!.cells[0], 'a\t\n\rb');
  });

  it('turns a refusal into a 422 with a fixed message that holds nothing of the file', () => {
    for (const reason of XLSX_REASONS) {
      const mapped = xlsxErrorToAppError(new XlsxError(reason))!;
      assert.equal(mapped.code, 'VALIDATION_ERROR');
      assert.equal(mapped.status, 422);
      assert.equal(mapped.message, XLSX_MESSAGES[reason]);
      assert.deepEqual(mapped.details, [{ field: 'file', issue: 'incorrect' }]);
    }
    assert.equal(xlsxErrorToAppError(new Error('boom')), null);
    assert.equal(xlsxErrorToAppError(new AppError('NOT_FOUND')), null);
  });

  it('names columns the way a spreadsheet does', () => {
    assert.deepEqual([1, 26, 27, 52, 703].map(columnName), ['A', 'Z', 'AA', 'AZ', 'AAA']);
    const wide = Array.from({ length: 703 }, (_cell, index) => (index === 702 ? 'last' : null));
    assert.deepEqual(readXlsx(workbookOf([wide]), { maxColumns: 1000 }).rows[0]!.cells.at(-1), 'last');
  });
});
