import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DEFAULT_XLSX_LIMITS } from '../../src/shared/xlsx/limits.ts';
import { restoreFormula } from '../../src/shared/xlsx/formula.ts';
import { readXlsx } from '../../src/shared/xlsx/reader.ts';
import type { CellValue } from '../../src/shared/xlsx/reader.ts';
import { openZip } from '../../src/shared/xlsx/zip.ts';
import { MAX_SHEET_NAME_CHARS, XLSX_CONTENT_TYPE, xlsxChunks } from '../../src/shared/xlsx/writer.ts';
import type { XlsxSheet } from '../../src/shared/xlsx/writer.ts';
import { columnName } from '../helpers/xlsx.ts';

const collect = async (sheets: readonly XlsxSheet[], options?: { maxZipBytes?: number }): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of xlsxChunks(sheets, options)) {
    parts.push(part);
  }
  return Buffer.concat(parts);
};
const sheetOf = (columns: string[], rows: string[][], name = 'Data'): XlsxSheet => ({ name, columns, rows });
const entryText = (file: Buffer, name: string, limits = DEFAULT_XLSX_LIMITS): string => openZip(file, limits).read(name).toString('utf8');
const cellsOf = (file: Buffer, limits = {}): CellValue[][] => readXlsx(file, limits).rows.map((row) => [...row.cells]);
const invalidName = (name: string, others: readonly string[] = []): Promise<void> =>
  assert.rejects(collect([...others.map((other) => sheetOf(['a'], [], other)), sheetOf(['a'], [], name)]), RangeError);

describe('XLSX writer', () => {
  it('exposes the content type and the limit of the sheet names', () => {
    assert.equal(XLSX_CONTENT_TYPE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(MAX_SHEET_NAME_CHARS, 31);
  });

  it('round-trips text through the reader: codes stay text, empty cells are null, unicode is kept', async () => {
    const file = await collect([sheetOf(['Code', 'Name', 'Note'], [['007', 'Caffè ☕', ''], ['', 'Ünï 😀 日本', 'x'], ['1e3', '0.50', '  padded  '], ['a', 'b', 'c', 'd (beyond the header)'], ['only']])]);
    assert.deepEqual(cellsOf(file), [
      ['Code', 'Name', 'Note'],
      ['007', 'Caffè ☕'],
      [null, 'Ünï 😀 日本', 'x'],
      ['1e3', '0.50', '  padded  '],
      ['a', 'b', 'c', 'd (beyond the header)'],
      ['only'],
    ]);
    assert.equal(cellsOf(file)[1]![0], '007');
    assert.match(entryText(file, 'xl/worksheets/sheet1.xml'), /<c r="A2" t="inlineStr"><is><t xml:space="preserve">007<\/t><\/is><\/c>/);
    assert.equal(openZip(file, DEFAULT_XLSX_LIMITS).has('xl/sharedStrings.xml'), false);
  });

  it('neutralizes formulas, also in the header, and restoreFormula gives the original back', async () => {
    const originals = ['=SUM(A1)', '+1', '-1', '@x', '\tx', '\rx', "'=x", 'plain', '-'];
    const file = await collect([sheetOf(['=HEAD', 'ok'], [originals])]);
    const [header, row] = cellsOf(file) as [string[], string[]];
    assert.equal(header[0], "'=HEAD");
    assert.equal(restoreFormula(header[0]!), '=HEAD');
    assert.deepEqual(
      row.map((value) => restoreFormula(value)),
      originals,
    );
    assert.equal(row[0], "'=SUM(A1)");
    assert.equal(row[6], "''=x");
    assert.equal(row[7], 'plain');
  });

  it('removes what XML forbids, repairs lone surrogates and keeps tab, LF and CR', async () => {
    const forbidden = 'a\u0000b\u0001c\u0008d\u000be\u000cf\u000eg\u001fh￾i￿j';
    const file = await collect([sheetOf(['H'], [[forbidden], ['x\ud800y'], ['l1\nl2\r\nl3\tt'], ['\u0001'], ['\u0001=x']])]);
    assert.deepEqual(cellsOf(file), [['H'], ['abcdefghij'], ['x�y'], ['l1\nl2\r\nl3\tt'], ["'=x"]]);
    const xml = entryText(file, 'xl/worksheets/sheet1.xml');
    assert.match(xml, /l1&#10;l2&#13;&#10;l3&#9;t/);
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it('escapes the markup characters', async () => {
    const file = await collect([sheetOf(['a&b'], [['<x a="1" b=\'2\'>&amp;</x>']])]);
    assert.deepEqual(cellsOf(file), [['a&b'], ['<x a="1" b=\'2\'>&amp;</x>']]);
    assert.match(entryText(file, 'xl/worksheets/sheet1.xml'), /&lt;x a=&quot;1&quot; b=&apos;2&apos;&gt;&amp;amp;&lt;\/x&gt;/);
  });

  it('writes the header in bold, frozen, with the widths of the columns clamped to 12..40', async () => {
    const long = 'x'.repeat(50);
    const file = await collect([sheetOf(['a', 'a medium header!!!', long, ''], [['1']])]);
    const xml = entryText(file, 'xl/worksheets/sheet1.xml');
    assert.match(xml, /<row r="1"><c r="A1" s="1" t="inlineStr">/);
    assert.match(xml, /<c r="B2"|<c r="A2" t="inlineStr">/);
    assert.doesNotMatch(xml, /<c r="A2" s=/);
    assert.match(xml, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    assert.match(xml, /<col min="1" max="1" width="12" customWidth="1"\/><col min="2" max="2" width="18" customWidth="1"\/><col min="3" max="3" width="40" customWidth="1"\/><col min="4" max="4" width="12" customWidth="1"\/>/);
    assert.match(entryText(file, 'xl/styles.xml'), /<cellXfs count="2"><xf [^>]*\/><xf [^>]*fontId="1"[^>]*\/><\/cellXfs>/);
    assert.match(entryText(file, 'xl/styles.xml'), /<font><b\/>/);
  });

  it('writes no <cols> for a sheet without columns', async () => {
    const file = await collect([sheetOf([], [['a']])]);
    assert.doesNotMatch(entryText(file, 'xl/worksheets/sheet1.xml'), /<cols>/);
    assert.deepEqual(cellsOf(file), [['a']]);
  });

  it('names the columns A, Z, AA, AZ, BA and XFD, up to 16 384 columns', async () => {
    const cells = Array.from({ length: 16_384 }, (_, index) => columnName(index + 1));
    const file = await collect([sheetOf([], [cells])]);
    const xml = entryText(file, 'xl/worksheets/sheet1.xml');
    for (const name of ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']) {
      assert.ok(xml.includes(`<c r="${name}2" t="inlineStr"><is><t xml:space="preserve">${name}</t>`), name);
    }
    assert.ok(!xml.includes('XFE'));
    const [row] = cellsOf(file, { maxColumns: 16_384 });
    assert.deepEqual(row, cells);
  });

  it('refuses more than 16 384 columns in the header or in a row', async () => {
    await assert.rejects(collect([sheetOf(Array.from({ length: 16_385 }, () => 'h'), [])]), RangeError);
    await assert.rejects(collect([sheetOf([], [Array.from({ length: 16_385 }, () => 'c')])]), RangeError);
  });

  it('accepts 1 048 576 rows with the header and refuses one more', async () => {
    const rows = function* (count: number): Generator<string[]> {
      for (let index = 0; index < count; index += 1) {
        yield [];
      }
    };
    const file = await collect([{ name: 'Big', columns: ['h'], rows: rows(1_048_575) }]);
    assert.ok(entryText(file, 'xl/worksheets/sheet1.xml', { ...DEFAULT_XLSX_LIMITS, maxEntryBytes: 1e9, maxTotalBytes: 1e9, maxRatio: 1e6 }).endsWith('<row r="1048576"></row></sheetData></worksheet>'));
    await assert.rejects(collect([{ name: 'Big', columns: ['h'], rows: rows(1_048_576) }]), RangeError);
  });

  it('takes the rows from a synchronous or an asynchronous iterable', async () => {
    const syncRows = new Set([['a', 'b'], ['c']]);
    const asyncRows = (async function* () {
      yield ['d'];
      await new Promise((resolve) => setImmediate(resolve));
      yield ['e', 'f'];
    })();
    assert.deepEqual(cellsOf(await collect([{ name: 'S', columns: ['h'], rows: syncRows }])), [['h'], ['a', 'b'], ['c']]);
    assert.deepEqual(cellsOf(await collect([{ name: 'A', columns: ['h'], rows: asyncRows }])), [['h'], ['d'], ['e', 'f']]);
  });

  it('writes several sheets in order', async () => {
    const file = await collect([sheetOf(['one'], [['1']], 'First'), sheetOf(['two'], [['2']], 'Second'), sheetOf(['three'], [], 'Third')]);
    const workbook = entryText(file, 'xl/workbook.xml');
    assert.match(workbook, /<sheet name="First" sheetId="1" r:id="rId1"\/><sheet name="Second" sheetId="2" r:id="rId2"\/><sheet name="Third" sheetId="3" r:id="rId3"\/>/);
    assert.match(entryText(file, 'xl/_rels/workbook.xml.rels'), /Id="rId3"[^>]*Target="worksheets\/sheet3.xml"\/><Relationship Id="rId4"[^>]*\/styles" Target="styles.xml"/);
    assert.match(entryText(file, 'xl/worksheets/sheet2.xml'), /<t xml:space="preserve">2<\/t>/);
    assert.match(entryText(file, 'xl/worksheets/sheet3.xml'), /<t xml:space="preserve">three<\/t>/);
    assert.match(entryText(file, '[Content_Types].xml'), /sheet3\.xml/);
    assert.match(entryText(file, '_rels/.rels'), /Target="xl\/workbook.xml"/);
    assert.deepEqual(cellsOf(file), [['one'], ['1']]);
  });

  it('validates the names of the sheets', async () => {
    await assert.rejects(collect([]), RangeError);
    await invalidName('');
    await invalidName('\u0001');
    await invalidName('x'.repeat(MAX_SHEET_NAME_CHARS + 1));
    for (const character of '[]:*?/\\') {
      await invalidName(`a${character}b`);
    }
    await invalidName("'quoted");
    await invalidName("quoted'");
    await invalidName('SHEET', ['sheet']);
    await invalidName('B\u0001', ['b']);
    const ok = ['x'.repeat(MAX_SHEET_NAME_CHARS), "it's", 'R&D <x> "q"', 'A\u0001B'];
    const workbook = entryText(await collect(ok.map((name) => sheetOf(['a'], [], name))), 'xl/workbook.xml');
    assert.match(workbook, /name="x{31}"/);
    assert.match(workbook, /name="it&apos;s"/);
    assert.match(workbook, /name="R&amp;D &lt;x&gt; &quot;q&quot;"/);
    assert.match(workbook, /name="AB"/);
  });

  it('refuses a workbook that would need more entries than ZIP without ZIP64', async () => {
    const sheets = Array.from({ length: 65_530 }, (_, index) => sheetOf([], [], `s${index}`));
    await assert.rejects(collect(sheets), RangeError);
  });

  it('refuses what does not fit ZIP without ZIP64 (injected threshold)', async () => {
    await assert.rejects(collect([sheetOf(['a'], [['b']])], { maxZipBytes: 100 }), RangeError);
    // Every entry is under 1 500 bytes, but the archive as a whole is longer: the offset is what overflows.
    const whole = await collect([sheetOf(['a'], [['b']])]);
    assert.ok(whole.length > 1_500);
    await assert.rejects(collect([sheetOf(['a'], [['b']])], { maxZipBytes: 1_500 }), RangeError);
  });

  it('writes a well-formed ZIP: data descriptors, UTF-8 flag, a central directory that agrees with the local headers', async () => {
    const file = await collect([sheetOf(['h'], [['v']], 'A'), sheetOf(['h'], [['v']], 'B')]);
    const end = file.length - 22;
    assert.equal(file.readUInt32LE(end), 0x06054b50);
    const count = file.readUInt16LE(end + 10);
    assert.equal(count, 7);
    assert.equal(file.readUInt16LE(end + 8), 7);
    assert.equal(file.readUInt16LE(end + 20), 0);
    let position = file.readUInt32LE(end + 16);
    assert.equal(position + file.readUInt32LE(end + 12), end);
    const names: string[] = [];
    const offsets: number[] = [];
    for (let index = 0; index < count; index += 1) {
      assert.equal(file.readUInt32LE(position), 0x02014b50);
      assert.equal(file.readUInt16LE(position + 6), 20);
      assert.equal(file.readUInt16LE(position + 8), 0x0808);
      assert.equal(file.readUInt16LE(position + 10), 8);
      const nameLength = file.readUInt16LE(position + 28);
      const offset = file.readUInt32LE(position + 42);
      offsets.push(offset);
      names.push(file.toString('utf8', position + 46, position + 46 + nameLength));
      // The local header: signature, flags, method, and no CRC and no sizes.
      assert.equal(file.readUInt32LE(offset), 0x04034b50);
      assert.equal(file.readUInt16LE(offset + 6), 0x0808);
      assert.equal(file.readUInt16LE(offset + 8), 8);
      assert.deepEqual([...file.subarray(offset + 14, offset + 26)], new Array(12).fill(0));
      assert.equal(file.toString('utf8', offset + 30, offset + 30 + nameLength), names[index]);
      // The descriptor ends the entry, just before the next local header (or the directory).
      const next = index + 1 < count ? undefined : file.readUInt32LE(end + 16);
      assert.ok(next === undefined || file.readUInt32LE(next - 16) === 0x08074b50);
      assert.equal(file.readUInt32LE(position + 20) > 0, true);
      position += 46 + nameLength;
    }
    assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    assert.equal(offsets[0], 0);
    for (let index = 1; index < count; index += 1) {
      assert.equal(file.readUInt32LE(offsets[index]! - 16), 0x08074b50);
    }
    // The reader checks every size and CRC-32 of the directory against the inflated data.
    const archive = openZip(file, DEFAULT_XLSX_LIMITS);
    for (const name of names) {
      assert.ok(archive.read(name).length > 0, name);
    }
  });

  it('streams in pieces and produces a file the reader accepts: 20 000 rows x 60 columns of distinct text', { timeout: 120_000 }, async () => {
    const random = randomBytes(20_000 * 60 * 6);
    const rows = function* (): Generator<string[]> {
      for (let row = 0; row < 20_000; row += 1) {
        const cells: string[] = [];
        for (let column = 0; column < 60; column += 1) {
          cells.push(random.toString('base64', (row * 60 + column) * 6, (row * 60 + column) * 6 + 6));
        }
        yield cells;
      }
    };
    const columns = Array.from({ length: 60 }, (_, index) => `Column ${index + 1}`);
    const parts: Buffer[] = [];
    let largest = 0;
    for await (const part of xlsxChunks([{ name: 'Big', columns, rows: rows() }])) {
      largest = Math.max(largest, part.length);
      parts.push(part);
    }
    assert.ok(largest <= 70_000, `piece of ${largest} bytes`);
    assert.ok(parts.length > 20);
    const limits = { maxFileBytes: 1e9, maxEntryBytes: 1e9, maxTotalBytes: 2e9, maxCellTextTotal: 1e9, maxRows: 25_000, maxColumns: 100 };
    const read = readXlsx(Buffer.concat(parts), limits);
    assert.equal(read.rows.length, 20_001);
    assert.equal(read.rows[0]!.cells.length, 60);
    assert.equal(read.rows[20_000]!.number, 20_001);
    assert.equal(read.rows[20_000]!.cells[59], random.toString('base64', (19_999 * 60 + 59) * 6, (19_999 * 60 + 59) * 6 + 6));
  });

  it('stops cleanly when the consumer returns early: the source of the rows is closed', { timeout: 30_000 }, async () => {
    let closed = false;
    const rows = (async function* (): AsyncGenerator<string[]> {
      try {
        for (let row = 0; ; row += 1) {
          yield [`row ${row}`, randomBytes(24).toString('hex')];
        }
      } finally {
        closed = true;
      }
    })();
    const generator = xlsxChunks([{ name: 'Endless', columns: ['a', 'b'], rows }]);
    for (let pulled = 0; pulled < 30; pulled += 1) {
      assert.equal((await generator.next()).done, false);
    }
    assert.equal(closed, false);
    assert.deepEqual(await generator.return(Buffer.alloc(0)), { done: true, value: Buffer.alloc(0) });
    for (let attempt = 0; attempt < 100 && !closed; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(closed, true);
    assert.equal((await generator.next()).done, true);
  });

  it('propagates the failure of the source of the rows', async () => {
    const rows = (async function* (): AsyncGenerator<string[]> {
      yield ['a'];
      throw new Error('source failed');
    })();
    await assert.rejects(collect([{ name: 'Broken', columns: ['a'], rows }]), /source failed/);
  });
});
