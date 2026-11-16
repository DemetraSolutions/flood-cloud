/** The limits of the reader: every one is checked before the data it protects against is read or kept. */
export interface XlsxLimits {
  /** Largest file, in bytes. */
  readonly maxFileBytes: number;
  /** Most entries in the archive. */
  readonly maxEntries: number;
  /** Largest uncompressed entry, in bytes. */
  readonly maxEntryBytes: number;
  /** Largest sum of the uncompressed sizes of all the entries, in bytes. */
  readonly maxTotalBytes: number;
  /** Largest ratio between the uncompressed and the compressed size of an entry. */
  readonly maxRatio: number;
  /** Largest row number of the worksheet. */
  readonly maxRows: number;
  /** Largest column number of a cell that holds a value. */
  readonly maxColumns: number;
  /** Longest text of one cell, in characters (the limit of Excel). */
  readonly maxCellChars: number;
  /** Most characters of text all the cells of the worksheet may hold together, counting a shared string every time a cell cites it: a reference costs what the text it expands to. */
  readonly maxCellTextTotal: number;
  /** Deepest nesting of the elements of an XML document. */
  readonly maxDepth: number;
}

/** The limits of the platform: 10 MB file, 50 entries, 50 MB per entry, 100 MB in all, ratio 100, 100 000 rows, 50 columns, 32 767 characters a cell, 50 M characters of cell text in all. */
export const DEFAULT_XLSX_LIMITS: XlsxLimits = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxEntries: 50,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxRatio: 100,
  maxRows: 100_000,
  maxColumns: 50,
  maxCellChars: 32_767,
  maxCellTextTotal: 50 * 1024 * 1024,
  maxDepth: 32,
});
