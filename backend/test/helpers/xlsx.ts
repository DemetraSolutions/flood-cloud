import { crc32, deflateRawSync } from 'node:zlib';

/** One file of a test archive; the optional fields tamper with what the archive declares about it. */
export interface TestZipFile {
  readonly name: string;
  readonly data?: Buffer | string;
  /** Compression: deflate by default. */
  readonly method?: 'deflate' | 'stored';
  /** Overrides of the central directory. */
  readonly declared?: { method?: number; crc?: number; size?: number; compressedSize?: number; flags?: number; localOffset?: number; startDisk?: number };
  /** Name written in the local header when it differs from the directory. */
  readonly localName?: string;
  /** Extra field of the local header (bytes). */
  readonly localExtra?: Buffer;
}

/** Overrides of the end of the archive. */
export interface TestZipOptions {
  readonly comment?: Buffer;
  /** Number of entries the end record declares (the real number by default). */
  readonly declaredEntries?: number;
  /** Writes a ZIP64 end of central directory locator before the end record. */
  readonly zip64Locator?: boolean;
  readonly disk?: number;
  readonly directoryDisk?: number;
  readonly entriesOnDisk?: number;
  readonly directorySize?: number;
  readonly directoryOffset?: number;
  /** Bytes put between the last entry of the directory and its declared end. */
  readonly directoryPadding?: number;
}

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

/** Writes a ZIP archive with `node:zlib` only (nothing is committed as a binary file). */
export function zipOf(files: readonly TestZipFile[], options: TestZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data ?? '');
    const stored = file.method === 'stored';
    const body = stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(file.name);
    const localName = Buffer.from(file.localName ?? file.name);
    const extra = file.localExtra ?? Buffer.alloc(0);
    const crc = crc32(raw);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(stored ? 0 : 8), u16(0), u16(0), u32(crc), u32(body.length), u32(raw.length), u16(localName.length), u16(extra.length), localName, extra, body]);
    const declared = file.declared ?? {};
    directory.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(declared.flags ?? 0),
        u16(declared.method ?? (stored ? 0 : 8)),
        u16(0),
        u16(0),
        u32(declared.crc ?? crc),
        u32(declared.compressedSize ?? body.length),
        u32(declared.size ?? raw.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(declared.startDisk ?? 0),
        u16(0),
        u32(0),
        u32(declared.localOffset ?? offset),
        name,
      ]),
    );
    parts.push(local);
    offset += local.length;
  }
  const padding = Buffer.alloc(options.directoryPadding ?? 0);
  const central = Buffer.concat([...directory, padding]);
  const comment = options.comment ?? Buffer.alloc(0);
  const locator = options.zip64Locator === true ? Buffer.concat([u32(0x07064b50), u32(0), Buffer.alloc(8), u32(1)]) : Buffer.alloc(0);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(options.disk ?? 0),
    u16(options.directoryDisk ?? 0),
    u16(options.entriesOnDisk ?? options.declaredEntries ?? files.length),
    u16(options.declaredEntries ?? files.length),
    u32(options.directorySize ?? central.length),
    u32(options.directoryOffset ?? offset),
    u16(comment.length),
    comment,
  ]);
  return Buffer.concat([...parts, central, locator, end]);
}

/** A cell of a generated worksheet: text, a number, a boolean, or `null` for a gap. */
export type TestCell = string | number | boolean | null;

/** How a workbook is written. */
export interface WorkbookOptions {
  /** Text cells: shared strings (the default), inline strings, or formula results (`t="str"`). */
  readonly strings?: 'shared' | 'inline' | 'formula';
  /** Writes every cell with its reference (`A1`), or leaves the reference out (the default writes it). */
  readonly references?: boolean;
  /** Row numbers, when they are not 1, 2, 3…; one per row. */
  readonly rowNumbers?: readonly number[];
  /** Namespace prefix of the SpreadsheetML elements (`x`), as some producers write them. */
  readonly prefix?: string;
  /** The target of the relationship of the first sheet. */
  readonly target?: string;
  /** Extra files of the archive. */
  readonly extra?: readonly TestZipFile[];
  /** Replaces the XML of the sheet (the rows are then ignored). */
  readonly sheetXml?: string;
  /** Replaces the XML of the shared strings. */
  readonly sharedXml?: string;
  /** Leaves the shared strings out. */
  readonly noShared?: boolean;
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The name of a column from its number (1 is `A`). */
export function columnName(column: number): string {
  let name = '';
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

/** A small XLSX workbook generated at test time from rows of cells. */
export function workbookOf(rows: readonly (readonly TestCell[])[], options: WorkbookOptions = {}): Buffer {
  const p = options.prefix === undefined ? '' : `${options.prefix}:`;
  const shared: string[] = [];
  const sheetRows = rows.map((row, rowIndex) => {
    const number = options.rowNumbers?.[rowIndex] ?? rowIndex + 1;
    const cells = row
      .map((cell, columnIndex) => {
        if (cell === null) {
          return '';
        }
        const reference = options.references === false ? '' : ` r="${columnName(columnIndex + 1)}${number}"`;
        if (typeof cell === 'number') {
          return `<${p}c${reference}><${p}v>${cell}</${p}v></${p}c>`;
        }
        if (typeof cell === 'boolean') {
          return `<${p}c${reference} t="b"><${p}v>${cell ? 1 : 0}</${p}v></${p}c>`;
        }
        if (options.strings === 'inline') {
          return `<${p}c${reference} t="inlineStr"><${p}is><${p}t>${escapeXml(cell)}</${p}t></${p}is></${p}c>`;
        }
        if (options.strings === 'formula') {
          return `<${p}c${reference} t="str"><${p}f>A1</${p}f><${p}v>${escapeXml(cell)}</${p}v></${p}c>`;
        }
        shared.push(cell);
        return `<${p}c${reference} t="s"><${p}v>${shared.length - 1}</${p}v></${p}c>`;
      })
      .join('');
    return `<${p}row r="${number}">${cells}</${p}row>`;
  });
  const sheet = options.sheetXml ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}worksheet xmlns${options.prefix === undefined ? '' : `:${options.prefix}`}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><${p}sheetData>${sheetRows.join('')}</${p}sheetData></${p}worksheet>`;
  const sharedXml =
    options.sharedXml ??
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('')}</sst>`;
  const files: TestZipFile[] = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>\n<sheet name="Listino" sheetId="1" r:id="rId1"/>\n<sheet name="Altro" sheetId="2" r:id="rId2"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="x" Target="${options.target ?? 'worksheets/sheet1.xml'}"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData><row r="1"><c r="A1"><v>999</v></c></row></sheetData></worksheet>' },
    ...(options.noShared === true ? [] : [{ name: 'xl/sharedStrings.xml', data: sharedXml }]),
    ...(options.extra ?? []),
  ];
  return zipOf(files);
}
