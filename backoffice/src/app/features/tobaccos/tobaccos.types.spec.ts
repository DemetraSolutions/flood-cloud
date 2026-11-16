import { checkWorkbook, importProblems, MAX_IMPORT_BYTES } from './tobaccos.types';

const file = (name: string, size: number) => ({ name, size }) as File;

describe('checkWorkbook', () => {
  it('accepts an .xlsx file of any case up to 10 MB', () => {
    expect(checkWorkbook(file('listino.xlsx', 1000))).toBeNull();
    expect(checkWorkbook(file('LISTINO.XLSX', MAX_IMPORT_BYTES))).toBeNull();
  });

  it('refuses another extension, an empty file and a file that is too large', () => {
    expect(checkWorkbook(file('listino.xls', 1000))).toBe('type');
    expect(checkWorkbook(file('listino.csv', 1000))).toBe('type');
    expect(checkWorkbook(file('xlsx', 1000))).toBe('type');
    expect(checkWorkbook(file('listino.xlsx', 0))).toBe('empty');
    expect(checkWorkbook(file('listino.xlsx', MAX_IMPORT_BYTES + 1))).toBe('size');
  });
});

describe('importProblems', () => {
  it('reads the row, the column and the reason of the cells the server refused', () => {
    expect(
      importProblems([
        { field: 'rows[12].price', issue: 'minimum' },
        { field: 'rows[3].code', issue: 'taken' },
        { field: 'rows[7].barcodes[0].barcode', issue: 'format' },
        { field: 'rows[7].barcodes[2].quantity', issue: 'maximum' },
      ]),
    ).toEqual([
      { row: 12, columnKey: 'TOBACCOS.COLUMN.PRICE', columnParams: {}, issue: 'minimum' },
      { row: 3, columnKey: 'TOBACCOS.COLUMN.CODE', columnParams: {}, issue: 'taken' },
      { row: 7, columnKey: 'TOBACCOS.IMPORT.BARCODE', columnParams: { n: 1 }, issue: 'format' },
      { row: 7, columnKey: 'TOBACCOS.IMPORT.QUANTITY', columnParams: { n: 3 }, issue: 'maximum' },
    ]);
  });

  it('leaves out what is not a cell of the list: the file as a whole, unknown columns, anything odd', () => {
    expect(
      importProblems([
        { field: 'file', issue: 'incorrect' },
        { field: 'rows[1].constructor', issue: 'type' },
        { field: 'rows[1].other', issue: 'type' },
        { field: 'rows[x].code', issue: 'type' },
        { field: '(body)', issue: 'required' },
      ]),
    ).toEqual([]);
  });
});
