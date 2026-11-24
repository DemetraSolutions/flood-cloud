import { ApiErrorRow } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';

/** The sheets of the workbook, as the import answers list them. */
export const SHEET_KEYS = ['products', 'variants', 'categories'] as const;

/** A sheet of the workbook. */
export type SheetKey = (typeof SHEET_KEYS)[number];

/**
 * Router link of the page of the group.
 *
 * @param groupId The group.
 */
export function catalogXlsxRoute(groupId: string): string[] {
  return ['/groups', groupId, 'tools', 'catalog-import-export'];
}

/** What an import did (or, on a check, would do) to the entries of a sheet. */
export interface SheetCounts {
  readonly inserted: number;
  readonly updated: number;
  /** Products moved to the trash, categories deleted. */
  readonly removed: number;
  readonly unchanged: number;
}

/** What `POST /v1/groups/{groupId}/catalog-import` answers. */
export interface ImportOutcome {
  /** `true` when nothing was written (the check). */
  readonly dryRun: boolean;
  readonly sheets: Readonly<Record<SheetKey, SheetCounts>>;
}

/** How the export writes the columns that accept an id or a name. */
export type ExportReferences = 'ids' | 'names';

/** The stable codes of the problems of a row, as the backend lists them (`catalog-xlsx.errors.ts`): each has its own text in the dictionary. */
export const ROW_ERROR_CODES = [
  'unknownColumn',
  'duplicateColumn',
  'unknownPlace',
  'ambiguousPlace',
  'tooManyRows',
  'invalidId',
  'duplicateId',
  'notFound',
  'trashed',
  'wrongSheet',
  'notImportable',
  'deleteWithoutId',
  'required',
  'invalidValue',
  'notFoundReference',
  'ambiguousName',
  'incompletePrice',
  'duplicatePriceList',
  'notRepresentable',
  'unknownStation',
  'invalid',
  'forbidden',
  'conflict',
  'tooSlow',
] as const;

/** A code of {@link ROW_ERROR_CODES}. */
export type RowErrorCode = (typeof ROW_ERROR_CODES)[number];

/** Codes whose server message ends with a fixed detail in parentheses (the field and the issue the catalog gave) that the dictionary text cannot know. */
const CODES_WITH_DETAIL: ReadonlySet<string> = new Set(['invalid', 'conflict']);

const KNOWN_CODES: ReadonlySet<string> = new Set(ROW_ERROR_CODES);

/** Dictionary key of the text of a known problem code (`notFoundReference` is `CATALOG_XLSX.ROW_ERROR.NOT_FOUND_REFERENCE`). */
export function rowErrorKey(code: RowErrorCode): string {
  return `CATALOG_XLSX.ROW_ERROR.${code.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

/**
 * The text of a problem of the file: translated from its code; the message of the server is the fallback for a code this version does not know, and the source of the detail of `invalid` and `conflict`.
 * The value is only ever text: the caller binds it with interpolation.
 *
 * @param i18n Translation service.
 * @param problem The problem as the server lists it.
 */
export function problemText(i18n: I18nService, problem: ApiErrorRow): string {
  if (!KNOWN_CODES.has(problem.code)) {
    return problem.message;
  }
  const text = i18n.t(rowErrorKey(problem.code as RowErrorCode));
  const detail = CODES_WITH_DETAIL.has(problem.code) ? /\(([^()]+)\)$/.exec(problem.message)?.[1] : undefined;
  return detail === undefined ? text : `${text} (${detail})`;
}

/** The sheets of an outcome in the order of the workbook, with their counts. */
export function sheetCounts(outcome: ImportOutcome): { key: SheetKey; counts: SheetCounts }[] {
  return SHEET_KEYS.map((key) => ({ key, counts: outcome.sheets[key] }));
}

/** The counts of all the sheets of an outcome added up. */
export function totalCounts(outcome: ImportOutcome): SheetCounts {
  return sheetCounts(outcome).reduce<SheetCounts>(
    (total, { counts }) => ({
      inserted: total.inserted + counts.inserted,
      updated: total.updated + counts.updated,
      removed: total.removed + counts.removed,
      unchanged: total.unchanged + counts.unchanged,
    }),
    { inserted: 0, updated: 0, removed: 0, unchanged: 0 },
  );
}
