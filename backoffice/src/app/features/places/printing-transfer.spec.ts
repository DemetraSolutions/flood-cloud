import { FIELDS, Scalars } from './place-fields';
import { toModel } from './place-model';
import { exportPrinting, importPrinting, MAX_IMPORT_BYTES } from './printing-transfer';

const defaults = (): Scalars => ({ ...toModel(null).printing.f });

describe('exportPrinting', () => {
  it('writes the printing keys nested as the API has them', () => {
    const scalars = { ...defaults(), 'receipt.user': true, 'prebilling.titleText': 'Titolo' };
    const parsed = JSON.parse(exportPrinting(scalars));
    expect(parsed.receipt.user).toBe(true);
    expect(parsed.receipt.barcode).toBe(false);
    expect(parsed.prebilling.titleText).toBe('Titolo');
    expect(parsed.ordering.startReturnNumber).toBe(0);
    expect(parsed.receipt.invoiceQt).toBe(1);
    expect(parsed.ordering.productsSorting).toBeNull();
  });

  it('is read back unchanged by the import', () => {
    const scalars = {
      ...defaults(),
      'receipt.user': true,
      'receipt.invoiceQt': '3',
      'prebilling.bottomText': 'Grazie',
      'ordering.titleFontSize': '2-2',
      'ordering.productsSorting': 'alphabetical',
    };
    const result = importPrinting(exportPrinting(scalars));
    expect(result?.ignored).toBe(0);
    expect(result?.values['receipt.user']).toBe(true);
    expect(result?.values['receipt.invoiceQt']).toBe('3');
    expect(result?.values['prebilling.bottomText']).toBe('Grazie');
    expect(result?.values['ordering.titleFontSize']).toBe('2-2');
    expect(result?.values['ordering.productsSorting']).toBe('alphabetical');
    expect(result?.values['prebilling.titleText']).toBe('');
    expect(result?.applied).toBe(FIELDS.printing.length);
  });

  it('has a limit on the size of the file', () => {
    expect(MAX_IMPORT_BYTES).toBe(262144);
  });
});

describe('importPrinting', () => {
  it('rejects a text that is not JSON', () => {
    expect(importPrinting('{not json')).toBeNull();
    expect(importPrinting('')).toBeNull();
  });

  it.each(['5', '"x"', 'null', 'true', '[]', '[{"receipt":{"user":true}}]'])(
    'rejects %s as not an object',
    (text) => {
      expect(importPrinting(text)).toBeNull();
    },
  );

  it('applies nothing for an empty object', () => {
    expect(importPrinting('{}')).toEqual({ values: {}, applied: 0, ignored: 0 });
  });

  it('applies the keys that have the right type', () => {
    const result = importPrinting(
      JSON.stringify({
        receipt: { user: true, noFiscalBottomText: 'Ciao', invoiceQt: 2, subtotalFontSize: '3-1' },
        prebilling: { header: false, titleText: 'T' },
        ordering: { startReturnNumber: 10, tableFontSize: '2-3', productsSorting: 'cart' },
      }),
    );
    expect(result).toEqual({
      values: {
        'receipt.user': true,
        'receipt.noFiscalBottomText': 'Ciao',
        'receipt.invoiceQt': '2',
        'receipt.subtotalFontSize': '3-1',
        'prebilling.header': false,
        'prebilling.titleText': 'T',
        'ordering.startReturnNumber': '10',
        'ordering.tableFontSize': '2-3',
        'ordering.productsSorting': 'cart',
      },
      applied: 9,
      ignored: 0,
    });
  });

  it('ignores and counts the values of the wrong type', () => {
    const result = importPrinting(
      JSON.stringify({
        receipt: {
          user: 'yes',
          barcode: 1,
          invoiceQt: '2',
          noFiscalBottomText: 5,
          subtotalFontSize: {},
        },
        ordering: { tableText: ['a'], printStationFontSize: true },
        unknown: { key: 1 },
      }),
    );
    expect(result).toEqual({ values: {}, applied: 0, ignored: 7 });
  });

  it('takes a null as an empty text, number or choice but not as a flag', () => {
    const result = importPrinting(
      JSON.stringify({
        receipt: { user: null, invoiceQt: null, noFiscalBottomText: null },
        ordering: { productsSorting: null, tableText: null },
      }),
    );
    expect(result?.ignored).toBe(1);
    expect(result?.values).toEqual({
      'receipt.invoiceQt': '',
      'receipt.noFiscalBottomText': '',
      'ordering.productsSorting': '',
      'ordering.tableText': '',
    });
    expect(result?.applied).toBe(4);
  });

  it('takes only keys of the printing tab, whatever else the file holds', () => {
    const text = JSON.stringify({ receipt: { user: true, other: true }, extra: 1, other: 2 });
    const result = importPrinting(text);
    expect(result?.values).toEqual({ 'receipt.user': true });
  });
});
