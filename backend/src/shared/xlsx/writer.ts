import { Readable, pipeline } from 'node:stream';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { neutralizeFormula } from './formula.ts';

/** The media type of an XLSX file, for the `Content-Type` header of a download. */
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The longest name of a worksheet, in characters (the limit of Excel). */
export const MAX_SHEET_NAME_CHARS = 31;

/** The most rows of a worksheet, header included (the limit of Excel). */
const MAX_ROWS = 1_048_576;
/** The most columns of a worksheet (the limit of Excel: `XFD`). */
const MAX_COLUMNS = 16_384;
/** The narrowest and the widest column, in characters. */
const MIN_WIDTH = 12;
const MAX_WIDTH = 40;
/** Text is handed to the compressor in pieces of about this many characters. */
const PIECE_CHARS = 64 * 1024;
/** Without ZIP64 a size, an offset is 32 bits. */
const ZIP_MAX_BYTES = 0xffff_ffff;
/** An end record that declares 65 535 entries means ZIP64: one entry less is the most. */
const ZIP_MAX_ENTRIES = 0xfffe;
/** The entries that are not worksheets: content types, relationships, workbook, workbook relationships, styles. */
const FIXED_ENTRIES = 5;

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8. */
const ZIP_FLAGS = 0x0008 | 0x0800;
const ZIP_VERSION = 20;
const DEFLATED = 8;
/** 1980-01-01 00:00: the archive does not depend on the clock. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A worksheet to write. */
export interface XlsxSheet {
  /** The name of the tab: 1 to {@link MAX_SHEET_NAME_CHARS} characters, none of `[]:*?/\`, no apostrophe at the start or the end, unique in the workbook without regard to case. */
  readonly name: string;
  /** The header: row 1, in bold, frozen. At most 16 384 columns. */
  readonly columns: readonly string[];
  /** The data rows, one array of texts each, from row 2. They are pulled one at a time: a sheet is never held in memory. A row may hold more cells than `columns`, or fewer. */
  readonly rows: Iterable<readonly string[]> | AsyncIterable<readonly string[]>;
}

/** Options of {@link xlsxChunks}. */
export interface XlsxWriteOptions {
  /** The largest size, compressed or not, and the largest offset of the archive, in bytes. 4 GB minus 1 (the limit of ZIP without ZIP64) by default; tests inject a small one. */
  readonly maxZipBytes?: number;
}

/** What the archive knows while it is written. */
interface Archive {
  offset: number;
  readonly directory: Buffer[];
  readonly maxBytes: number;
}

/** Throws when a size or an offset would not fit the limit of the archive. */
function assertFits(value: number, limit: number): void {
  if (value > limit) {
    throw new RangeError('The workbook is too large for a ZIP archive without ZIP64');
  }
}

/** Removes what XML 1.0 forbids (U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+FFFE, U+FFFF) and makes lone surrogates U+FFFD. */
function stripInvalid(text: string): string {
  return text.toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' };

/** Escapes a text for XML, writing tab, line feed and carriage return as numeric references so that no parser normalises them. */
function escapeXml(text: string): string {
  return text.replace(/[&<>"'\t\n\r]/g, (character) => ESCAPES[character]!);
}

const letterCache: string[] = [];

/** The name of a column from its index (0 is `A`, 26 is `AA`, 16 383 is `XFD`). */
function columnLetters(index: number): string {
  return (letterCache[index] ??= (() => {
    let name = '';
    for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
      name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
    }
    return name;
  })());
}

/** The XML of a cell: an inline string, so that a code such as `007` is always text. An empty text is no cell. */
function cellXml(row: number, column: number, text: string, header: boolean): string {
  const clean = stripInvalid(text);
  if (clean === '') {
    return '';
  }
  return `<c r="${columnLetters(column)}${row}"${header ? ' s="1"' : ''} t="inlineStr"><is><t xml:space="preserve">${escapeXml(neutralizeFormula(clean))}</t></is></c>`;
}

/** The XML of a row of cells. */
function rowXml(row: number, cells: readonly string[], header: boolean): string {
  if (cells.length > MAX_COLUMNS) {
    throw new RangeError(`A row cannot have more than ${MAX_COLUMNS} cells`);
  }
  let xml = `<row r="${row}">`;
  for (let column = 0; column < cells.length; column += 1) {
    xml += cellXml(row, column, cells[column]!, header);
  }
  return `${xml}</row>`;
}

/** The worksheet, as pieces of text of about {@link PIECE_CHARS}: the rows are pulled one at a time. */
async function* sheetPieces(sheet: XlsxSheet): AsyncGenerator<string> {
  let cols = '';
  for (let column = 0; column < sheet.columns.length; column += 1) {
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stripInvalid(sheet.columns[column]!).length));
    cols += `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`;
  }
  let pending =
    `${XML_DECLARATION}<worksheet xmlns="${MAIN_NAMESPACE}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols === '' ? '' : `<cols>${cols}</cols>`}<sheetData>${rowXml(1, sheet.columns, true)}`;
  let number = 1;
  for await (const cells of sheet.rows) {
    number += 1;
    if (number > MAX_ROWS) {
      throw new RangeError(`A worksheet cannot have more than ${MAX_ROWS} rows, the header included`);
    }
    pending += rowXml(number, cells, false);
    if (pending.length >= PIECE_CHARS) {
      yield pending;
      pending = '';
    }
  }
  yield `${pending}</sheetData></worksheet>`;
}

/** A small document, as one piece. */
async function* whole(text: string): AsyncGenerator<string> {
  yield text;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/**
 * Writes one entry of the archive: the local header (sizes and CRC are 0, a data descriptor follows the data), the deflated content pulled piece by piece, the descriptor. The record of the central
 * directory is kept in `archive`. The compressor and its source are destroyed whatever happens, so a consumer that stops early leaks nothing.
 */
async function* entry(archive: Archive, name: string, pieces: AsyncIterable<string>): AsyncGenerator<Buffer> {
  const nameBytes = Buffer.from(name, 'utf8');
  const localOffset = archive.offset;
  const header = Buffer.concat([u32(LOCAL_SIGNATURE), u16(ZIP_VERSION), u16(ZIP_FLAGS), u16(DEFLATED), u16(DOS_TIME), u16(DOS_DATE), u32(0), u32(0), u32(0), u16(nameBytes.length), u16(0), nameBytes]);
  archive.offset += header.length;
  yield header;
  let crc = 0;
  let size = 0;
  let compressed = 0;
  async function* bytes(): AsyncGenerator<Buffer> {
    for await (const piece of pieces) {
      const chunk = Buffer.from(piece, 'utf8');
      crc = crc32(chunk, crc);
      size += chunk.length;
      assertFits(size, archive.maxBytes);
      yield chunk;
    }
  }
  const source = Readable.from(bytes(), { objectMode: false });
  const deflate = createDeflateRaw({ chunkSize: 64 * 1024 });
  try {
    // A failure of the source or of the compressor destroys the chain and is thrown by the iteration: the callback has nothing to add.
    for await (const chunk of pipeline(source, deflate, () => undefined)) {
      const part: Buffer = chunk;
      compressed += part.length;
      assertFits(compressed, archive.maxBytes);
      archive.offset += part.length;
      yield part;
    }
  } finally {
    source.destroy();
    deflate.destroy();
  }
  const descriptor = Buffer.concat([u32(DESCRIPTOR_SIGNATURE), u32(crc), u32(compressed), u32(size)]);
  archive.offset += descriptor.length;
  assertFits(archive.offset, archive.maxBytes);
  archive.directory.push(
    Buffer.concat([
      u32(CENTRAL_SIGNATURE),
      u16(ZIP_VERSION),
      u16(ZIP_VERSION),
      u16(ZIP_FLAGS),
      u16(DEFLATED),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(compressed),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      nameBytes,
    ]),
  );
  yield descriptor;
}

/** Checks the worksheets before anything is written. */
function validate(sheets: readonly XlsxSheet[]): string[] {
  if (sheets.length === 0) {
    throw new RangeError('A workbook needs at least one worksheet');
  }
  if (sheets.length + FIXED_ENTRIES > ZIP_MAX_ENTRIES) {
    throw new RangeError('The workbook has too many worksheets for a ZIP archive without ZIP64');
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const sheet of sheets) {
    const name = stripInvalid(sheet.name);
    if (name.length === 0 || name.length > MAX_SHEET_NAME_CHARS) {
      throw new RangeError(`A worksheet name has 1 to ${MAX_SHEET_NAME_CHARS} characters`);
    }
    if (/[[\]:*?/\\]/.test(name)) {
      throw new RangeError('A worksheet name cannot contain any of [ ] : * ? / \\');
    }
    if (name.startsWith("'") || name.endsWith("'")) {
      throw new RangeError('A worksheet name cannot start or end with an apostrophe');
    }
    if (seen.has(name.toLowerCase())) {
      throw new RangeError('The worksheet names must be unique, without regard to case');
    }
    seen.add(name.toLowerCase());
    if (sheet.columns.length > MAX_COLUMNS) {
      throw new RangeError(`A worksheet cannot have more than ${MAX_COLUMNS} columns`);
    }
    names.push(name);
  }
  return names;
}

const STYLES =
  `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NAMESPACE}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * Streams a whole `.xlsx` file as it is built: only the pieces in flight are in memory, never a worksheet. The consumer sets the pace (an async generator yields when it asks), and a consumer that stops early
 * (`return()`) makes the compressor and the row source close. Every cell is an inline string, so a code, a barcode or an id such as `007` is text; an empty text is no cell; a text a spreadsheet could read as a
 * formula gets {@link neutralizeFormula}'s apostrophe (undone by `restoreFormula` when the file is read back). Row 1 is the header (bold, frozen).
 *
 * The archive uses data descriptors, UTF-8 names and no ZIP64. Nothing is written before the generator is first pulled; the checks run then, so every refusal is a rejection of the first `next()`.
 *
 * @param sheets The worksheets, in order.
 * @param options Tests inject a small `maxZipBytes`.
 * @yields The bytes of the file, in pieces of at most about 64 KB.
 * @throws {RangeError} No worksheet, a bad or repeated name, more than 16 384 columns or cells in a row, more than 1 048 576 rows, or a file that would need ZIP64.
 */
export async function* xlsxChunks(sheets: readonly XlsxSheet[], options: XlsxWriteOptions = {}): AsyncGenerator<Buffer> {
  const names = validate(sheets);
  const archive: Archive = { offset: 0, directory: [], maxBytes: options.maxZipBytes ?? ZIP_MAX_BYTES };
  const indexes = sheets.map((_, index) => index + 1);
  yield* entry(
    archive,
    '[Content_Types].xml',
    whole(
      `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        indexes.map((number) => `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ),
  );
  yield* entry(archive, '_rels/.rels', whole(`${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIP_TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`));
  yield* entry(
    archive,
    'xl/workbook.xml',
    whole(
      `${XML_DECLARATION}<workbook xmlns="${MAIN_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}"><sheets>` +
        names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
  );
  yield* entry(
    archive,
    'xl/_rels/workbook.xml.rels',
    whole(
      `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
        indexes.map((number) => `<Relationship Id="rId${number}" Type="${RELATIONSHIP_TYPE}/worksheet" Target="worksheets/sheet${number}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${RELATIONSHIP_TYPE}/styles" Target="styles.xml"/></Relationships>`,
    ),
  );
  yield* entry(archive, 'xl/styles.xml', whole(STYLES));
  for (const [index, sheet] of sheets.entries()) {
    yield* entry(archive, `xl/worksheets/sheet${index + 1}.xml`, sheetPieces(sheet));
  }
  const directory = Buffer.concat(archive.directory);
  yield Buffer.concat([directory, u32(END_SIGNATURE), u16(0), u16(0), u16(archive.directory.length), u16(archive.directory.length), u32(directory.length), u32(archive.offset), u16(0)]);
}
