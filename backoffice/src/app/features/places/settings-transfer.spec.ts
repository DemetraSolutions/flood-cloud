import { FIELDS } from './place-fields';
import { toModel } from './place-model';
import { exportSettings, importSettings, MAX_IMPORT_BYTES } from './settings-transfer';

const base = () => structuredClone(toModel(null));

describe('exportSettings', () => {
  it('writes the five parts the old backoffice exports, with the keys of the API', () => {
    const model = base();
    model.cashSettings.f['fastLogin'] = true;
    model.cashSettings.f['totalRounding'] = '0.05';
    model.cashSettings.workshiftNames = [{ name: 'Pranzo' }, { name: 'Cena' }];
    model.printing.f['receipt.user'] = true;
    model.printing.f['prebilling.titleText'] = 'Titolo';
    model.tables.f['exitsNumber'] = '';
    model.tables.tipValues = [
      { type: 'p', value: '10' },
      { type: 'v', value: '2.5' },
    ];
    const parsed = JSON.parse(exportSettings(model));
    expect(Object.keys(parsed)).toEqual([
      'general',
      'receipt',
      'prebilling',
      'ordering',
      'roomsSettings',
    ]);
    expect(parsed.general.fastLogin).toBe(true);
    expect(parsed.general.totalRounding).toBe(0.05);
    expect(parsed.general.chargeDocumentQt).toBe(1);
    expect(parsed.general.workshiftNames).toEqual(['Pranzo', 'Cena']);
    expect(parsed.general).not.toHaveProperty('advancedReportLogs');
    expect(parsed.receipt.user).toBe(true);
    expect(parsed.prebilling.titleText).toBe('Titolo');
    expect(parsed.ordering.startReturnNumber).toBe(0);
    expect(parsed.roomsSettings.exitsNumber).toBe(5);
    expect(parsed.roomsSettings.tableGroups).toEqual({
      status: false,
      name: false,
      autoCreateFirst: false,
    });
    expect(parsed.roomsSettings.tipValues).toEqual([
      { type: 'p', value: 10 },
      { type: 'v', value: 2.5 },
    ]);
  });

  it('has a limit on the size of the file', () => {
    expect(MAX_IMPORT_BYTES).toBe(262144);
  });
});

describe('importSettings', () => {
  it('rejects a text that is not JSON', () => {
    expect(importSettings('{not json')).toBeNull();
    expect(importSettings('')).toBeNull();
  });

  it.each(['5', '"x"', 'null', 'true', '[]', '[{"general":{}}]'])(
    'rejects %s as not an object',
    (text) => {
      expect(importSettings(text)).toBeNull();
    },
  );

  it('applies nothing for an empty object', () => {
    expect(importSettings('{}')).toEqual({
      cashSettings: {},
      workshiftNames: null,
      printing: {},
      tables: {},
      tipValues: null,
      applied: 0,
      ignored: 0,
    });
  });

  it('is read back unchanged from an export', () => {
    const model = base();
    model.cashSettings.f['fastLogin'] = true;
    model.cashSettings.f['customDiscount'] = 'x';
    model.cashSettings.workshiftNames = [{ name: 'A' }];
    model.printing.f['receipt.invoiceQt'] = '3';
    model.printing.f['ordering.titleFontSize'] = '2-2';
    model.tables.f['exits'] = true;
    model.tables.tipValues = [{ type: 'v', value: '3' }];
    const result = importSettings(exportSettings(model));
    expect(result?.ignored).toBe(0);
    expect(result?.cashSettings['fastLogin']).toBe(true);
    expect(result?.cashSettings['customDiscount']).toBe('x');
    expect(result?.cashSettings['receiptsCancellation']).toBe('');
    expect(result?.workshiftNames).toEqual(['A']);
    expect(result?.printing['receipt.invoiceQt']).toBe('3');
    expect(result?.printing['ordering.titleFontSize']).toBe('2-2');
    expect(result?.tables['exits']).toBe(true);
    expect(result?.tipValues).toEqual([{ type: 'v', value: '3' }]);
    expect(result?.printing['prebilling.titleText']).toBe('');
    expect(result?.applied).toBeGreaterThan(FIELDS.printing.length);
  });

  it('applies the keys that have the right type and counts the others as ignored', () => {
    const result = importSettings(
      JSON.stringify({
        general: {
          fastLogin: 'yes',
          totalRounding: 0.1,
          operatingTime: '04:30',
          customDiscount: 5,
          advancedReportLogs: true,
          unknownKey: 1,
          chargeDocumentQt: null,
          workshiftNames: ['a', 'b'],
        },
        receipt: { user: true, invoiceQt: '2' },
        roomsSettings: { exitsNumber: 8, tipValues: [{ type: 'p', value: 5 }] },
      }),
    );
    expect(result).toEqual({
      cashSettings: { totalRounding: '0.1', operatingTime: '04:30', chargeDocumentQt: '' },
      workshiftNames: ['a', 'b'],
      printing: { 'receipt.user': true },
      tables: { exitsNumber: '8' },
      tipValues: [{ type: 'p', value: '5' }],
      applied: 7,
      ignored: 3,
    });
  });

  it('does not take a null for a switch, and takes it for the other types', () => {
    const result = importSettings(
      JSON.stringify({ general: { fastLogin: null, totalRounding: null, customDiscount: null } }),
    );
    expect(result?.cashSettings).toEqual({ totalRounding: '', customDiscount: '' });
    expect(result?.ignored).toBe(1);
  });

  it.each([
    ['not a list', 'x'],
    ['a list with a non-text item', ['a', 3]],
    ['too long a list', Array.from({ length: 21 }, () => 'n')],
  ])('ignores the shift names when they are %s', (_, names) => {
    const result = importSettings(JSON.stringify({ general: { workshiftNames: names } }));
    expect(result).toMatchObject({ workshiftNames: null, applied: 0, ignored: 1 });
  });

  it('keeps a full list of shift names', () => {
    const names = Array.from({ length: 20 }, (_, index) => `n${index}`);
    expect(
      importSettings(JSON.stringify({ general: { workshiftNames: names } }))?.workshiftNames,
    ).toEqual(names);
  });

  it.each([
    ['not a list', 'x'],
    ['an item that is not an object', [3]],
    ['an unknown type', [{ type: 'z', value: 1 }]],
    ['a value that is not a number', [{ type: 'p', value: '1' }]],
    ['too long a list', Array.from({ length: 21 }, () => ({ type: 'p', value: 1 }))],
  ])('ignores the tips when they are %s', (_, tips) => {
    const result = importSettings(JSON.stringify({ roomsSettings: { tipValues: tips } }));
    expect(result).toMatchObject({ tipValues: null, applied: 0, ignored: 1 });
  });

  it('ignores a general part and a rooms part that are not objects', () => {
    expect(importSettings(JSON.stringify({ general: 'x', roomsSettings: [1] }))).toMatchObject({
      cashSettings: {},
      tables: {},
      workshiftNames: null,
      tipValues: null,
      applied: 0,
    });
  });
});
