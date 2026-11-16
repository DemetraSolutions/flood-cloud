import { XlsxError } from './errors.ts';
import { DEFAULT_XLSX_LIMITS } from './limits.ts';
import type { XlsxLimits } from './limits.ts';
import { parseXml } from './xml.ts';
import type { XmlHandler } from './xml.ts';
import { openZip } from './zip.ts';

/** The value of a cell: text, a number, a boolean, or `null` when the cell is empty (or holds an error). */
export type CellValue = string | number | boolean | null;

/** A row of the worksheet that holds at least one value. */
export interface SheetRow {
  /** The row number in the worksheet, from 1. */
  readonly number: number;
  /** The cells from column A: `cells[0]` is column A, a gap is `null`. The array ends at the last cell that holds a value. */
  readonly cells: readonly CellValue[];
}

/** The first worksheet of a workbook. */
export interface Worksheet {
  /** The rows that hold a value, in order, with their worksheet numbers. */
  readonly rows: readonly SheetRow[];
}

const WORKBOOK = 'xl/workbook.xml';
const RELATIONSHIPS = 'xl/_rels/workbook.xml.rels';
const SHARED_STRINGS = 'xl/sharedStrings.xml';
const CELL_REFERENCE = /^([A-Z]{1,3})([0-9]{1,7})$/;

function text(buffer: Buffer): string {
  return buffer.toString('utf8');
}

/** The relationship id of the first sheet of the workbook. */
function firstSheetRelationship(xml: string, limits: XlsxLimits): string {
  let found: string | undefined;
  parseXml(
    xml,
    {
      open: (name, attributes) => {
        if (name === 'sheet' && found === undefined) {
          found = attributes.get('id');
        }
      },
      close: () => undefined,
      text: () => undefined,
    },
    limits.maxDepth,
  );
  if (found === undefined || found === '') {
    throw new XlsxError('missing');
  }
  return found;
}

/** The target of a relationship, as written. */
function relationshipTarget(xml: string, id: string, limits: XlsxLimits): string {
  let target: string | undefined;
  parseXml(
    xml,
    {
      open: (name, attributes) => {
        if (name === 'Relationship' && attributes.get('Id') === id && target === undefined) {
          target = attributes.get('Target');
        }
      },
      close: () => undefined,
      text: () => undefined,
    },
    limits.maxDepth,
  );
  if (target === undefined || target === '') {
    throw new XlsxError('missing');
  }
  return target;
}

/** The archive path of a target: relative to `xl/`, or absolute from the root of the archive; `..` can never climb out of the archive. */
function pathOf(target: string): string {
  const parts: string[] = [];
  for (const part of (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/')) {
    if (part === '..') {
      if (parts.pop() === undefined) {
        throw new XlsxError('unsafe');
      }
    } else if (part !== '' && part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** The shared strings, in order: the text of each `<si>`, without the phonetic runs. */
function sharedStrings(xml: string, limits: XlsxLimits): string[] {
  const strings: string[] = [];
  let current = '';
  let inside = false;
  let inText = false;
  let phonetic = 0;
  parseXml(
    xml,
    {
      open: (name) => {
        if (name === 'si') {
          inside = true;
          current = '';
        } else if (name === 'rPh') {
          phonetic += 1;
        } else if (name === 't' && inside && phonetic === 0) {
          inText = true;
        }
      },
      close: (name) => {
        if (name === 'si') {
          if (current.length > limits.maxCellChars) {
            throw new XlsxError('limit');
          }
          strings.push(current);
          inside = false;
        } else if (name === 'rPh') {
          phonetic -= 1;
        } else if (name === 't') {
          inText = false;
        }
      },
      text: (value) => {
        if (inText) {
          current += value;
        }
      },
    },
    limits.maxDepth,
  );
  return strings;
}

/** The column number (from 1) of a column name (`A` is 1, `AZ` is 52). */
function columnOf(letters: string): number {
  let column = 0;
  for (const letter of letters) {
    column = column * 26 + letter.charCodeAt(0) - 64;
  }
  return column;
}

/** The value of a finished cell. */
function valueOf(kind: string, raw: string, inline: string, shared: readonly string[]): CellValue {
  switch (kind) {
    case 's': {
      if (raw === '') {
        return null;
      }
      const index = Number(raw);
      if (!Number.isInteger(index) || index < 0 || index >= shared.length) {
        throw new XlsxError('malformed');
      }
      return shared[index]!;
    }
    case 'inlineStr':
      return inline;
    case 'str':
    case 'd':
      return raw;
    case 'b':
      if (raw !== '0' && raw !== '1') {
        throw new XlsxError('malformed');
      }
      return raw === '1';
    case 'e':
      return null;
    case 'n': {
      if (raw.trim() === '') {
        return null;
      }
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        throw new XlsxError('malformed');
      }
      return number;
    }
    default:
      throw new XlsxError('malformed');
  }
}

/** The rows of a worksheet. */
function sheetRows(xml: string, shared: readonly string[], limits: XlsxLimits): SheetRow[] {
  const rows: SheetRow[] = [];
  let rowNumber = 0;
  let cells: CellValue[] = [];
  let lastColumn = 0;
  let kind = 'n';
  let column = 0;
  let raw = '';
  let inline = '';
  let hasValue = false;
  let inV = false;
  let inInline = false;
  let inText = false;
  let phonetic = 0;
  let inRow = false;
  let textTotal = 0;
  const handler: XmlHandler = {
    open: (name, attributes) => {
      switch (name) {
        case 'row': {
          const declared = attributes.get('r');
          const number = declared === undefined ? rowNumber + 1 : /^[0-9]{1,9}$/.test(declared) ? Number(declared) : 0;
          // A row number that is not made of digits, is not above the previous one (rows only ascend) or is 0 is damage.
          if (number <= rowNumber) {
            throw new XlsxError('malformed');
          }
          if (number > limits.maxRows) {
            throw new XlsxError('limit');
          }
          rowNumber = number;
          inRow = true;
          cells = [];
          lastColumn = 0;
          break;
        }
        case 'c': {
          const reference = attributes.get('r');
          if (reference === undefined) {
            column = lastColumn + 1;
          } else {
            const parts = CELL_REFERENCE.exec(reference);
            if (parts === null || Number(parts[2]) !== rowNumber) {
              throw new XlsxError('malformed');
            }
            column = columnOf(parts[1]!);
          }
          if (column <= lastColumn || !inRow) {
            throw new XlsxError('malformed');
          }
          lastColumn = column;
          kind = attributes.get('t') ?? 'n';
          raw = '';
          inline = '';
          hasValue = false;
          break;
        }
        case 'v':
          inV = true;
          hasValue = true;
          break;
        case 'is':
          inInline = true;
          hasValue = true;
          break;
        case 'rPh':
          phonetic += 1;
          break;
        case 't':
          inText = inInline && phonetic === 0;
          break;
        default:
      }
    },
    close: (name) => {
      switch (name) {
        case 'v':
          inV = false;
          break;
        case 'is':
          inInline = false;
          break;
        case 'rPh':
          phonetic -= 1;
          break;
        case 't':
          inText = false;
          break;
        case 'c': {
          if (!hasValue) {
            break;
          }
          if (raw.length > limits.maxCellChars || inline.length > limits.maxCellChars) {
            throw new XlsxError('limit');
          }
          const value = valueOf(kind, raw, inline, shared);
          if (value !== null) {
            if (typeof value === 'string') {
              // A shared string cited by many cells counts every time: the rows hold what it expands to.
              textTotal += value.length;
              if (textTotal > limits.maxCellTextTotal) {
                throw new XlsxError('limit');
              }
            }
            if (column > limits.maxColumns) {
              throw new XlsxError('limit');
            }
            while (cells.length < column - 1) {
              cells.push(null);
            }
            cells.push(value);
          }
          break;
        }
        case 'row':
          inRow = false;
          if (cells.length > 0) {
            rows.push({ number: rowNumber, cells });
          }
          break;
        default:
      }
    },
    text: (value) => {
      if (inV) {
        raw += value;
      } else if (inText) {
        inline += value;
      }
    },
  };
  parseXml(xml, handler, limits.maxDepth);
  return rows;
}

/**
 * Reads the first worksheet of an XLSX workbook held in memory, with the Node standard library only (`node:zlib`) and no dependency.
 *
 * What it reads: `xl/workbook.xml` (the first `<sheet>`), `xl/_rels/workbook.xml.rels` (where that sheet is), `xl/sharedStrings.xml` (when there is one) and the sheet. Cells hold text (shared, inline or the
 * cached result of a formula), numbers, booleans; an empty cell and an error cell are `null`; dates are the numbers or the text the file holds. A cell reference may skip cells and rows. Everything else in the
 * archive (styles, drawings, other sheets, macros) is never inflated. A cell of the worksheet that holds no value does not count towards the limit of columns.
 *
 * Every refusal is an {@link XlsxError} whose message is fixed: nothing of the file is echoed. See `zip.ts` for the rules of the archive and `xml.ts` for the ones of the XML (no DTD, no entities).
 *
 * @param buffer The whole file.
 * @param overrides Limits that replace the defaults of {@link DEFAULT_XLSX_LIMITS} (tests use smaller ones).
 * @returns The rows of the first worksheet that hold a value.
 * @throws {XlsxError} When the file is not a workbook this reader accepts.
 */
export function readXlsx(buffer: Buffer, overrides: Partial<XlsxLimits> = {}): Worksheet {
  const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...overrides };
  const archive = openZip(buffer, limits);
  const id = firstSheetRelationship(text(archive.read(WORKBOOK)), limits);
  const path = pathOf(relationshipTarget(text(archive.read(RELATIONSHIPS)), id, limits));
  const shared = archive.has(SHARED_STRINGS) ? sharedStrings(text(archive.read(SHARED_STRINGS)), limits) : [];
  return { rows: sheetRows(text(archive.read(path)), shared, limits) };
}
