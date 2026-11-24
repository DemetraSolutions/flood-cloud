import { I18nService } from '../../core/i18n/i18n.service';
import {
  catalogXlsxRoute,
  ImportOutcome,
  problemText,
  ROW_ERROR_CODES,
  rowErrorKey,
  sheetCounts,
  totalCounts,
} from './catalog-xlsx.types';

const i18n = { t: (key: string) => key } as unknown as I18nService;
const problem = (code: string, message = 'server message') => ({
  sheet: 'Prodotti',
  row: 2,
  column: 'NOME',
  code,
  message,
});

/** The codes of `backend/src/modules/catalog-xlsx/catalog-xlsx.errors.ts` (`ROW_ERROR_MESSAGES`), copied: a code the backend adds must be added here and then the dictionary test (i18n-keys) asks for its text. */
const BACKEND_CODES = [
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
];

const OUTCOME: ImportOutcome = {
  dryRun: true,
  sheets: {
    products: { inserted: 1, updated: 2, removed: 3, unchanged: 4 },
    variants: { inserted: 10, updated: 20, removed: 30, unchanged: 40 },
    categories: { inserted: 100, updated: 200, removed: 300, unchanged: 400 },
  },
};

describe('catalog-xlsx types', () => {
  it('knows every code of the backend', () => {
    expect([...ROW_ERROR_CODES]).toEqual(BACKEND_CODES);
  });

  it('makes the key of a code in upper snake case', () => {
    expect(rowErrorKey('notFoundReference')).toBe('CATALOG_XLSX.ROW_ERROR.NOT_FOUND_REFERENCE');
    expect(rowErrorKey('required')).toBe('CATALOG_XLSX.ROW_ERROR.REQUIRED');
  });

  describe('problemText', () => {
    it('translates a known code and ignores the message of the server', () => {
      expect(problemText(i18n, problem('required'))).toBe('CATALOG_XLSX.ROW_ERROR.REQUIRED');
      expect(problemText(i18n, problem('wrongSheet', 'A (b) (c)'))).toBe(
        'CATALOG_XLSX.ROW_ERROR.WRONG_SHEET',
      );
    });

    it('adds the detail the server gives for a refused value or a conflict', () => {
      expect(problemText(i18n, problem('invalid', 'The value is refused (name: tooLong)'))).toBe(
        'CATALOG_XLSX.ROW_ERROR.INVALID (name: tooLong)',
      );
      expect(problemText(i18n, problem('conflict', 'The change conflicts (in use)'))).toBe(
        'CATALOG_XLSX.ROW_ERROR.CONFLICT (in use)',
      );
      expect(problemText(i18n, problem('invalid', 'The value is refused'))).toBe(
        'CATALOG_XLSX.ROW_ERROR.INVALID',
      );
    });

    it('falls back to the message of the server for a code it does not know', () => {
      expect(problemText(i18n, problem('brandNew', 'Something new'))).toBe('Something new');
    });
  });

  it('lists the sheets of an outcome in the order of the workbook and adds them up', () => {
    expect(sheetCounts(OUTCOME).map((line) => line.key)).toEqual([
      'products',
      'variants',
      'categories',
    ]);
    expect(totalCounts(OUTCOME)).toEqual({ inserted: 111, updated: 222, removed: 333, unchanged: 444 });
  });

  it('makes the link of the page of a group', () => {
    expect(catalogXlsxRoute('g1')).toEqual(['/groups', 'g1', 'tools', 'catalog-import-export']);
  });
});
