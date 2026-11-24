import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/http/errors.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import type { SheetRow } from '../../src/shared/xlsx/reader.ts';
import { DEFAULT_XLSX_LIMITS } from '../../src/shared/xlsx/limits.ts';
import {
  FIXED_COLUMNS,
  PLACE_KINDS,
  PRICE_SLOTS,
  SHEET_KINDS,
  SHEET_NAMES,
  cellText,
  echoed,
  normalizeHeader,
  parseHeader,
  placeHeader,
} from '../../src/modules/catalog-xlsx/catalog-xlsx.columns.ts';
import type { PlaceColumn } from '../../src/modules/catalog-xlsx/catalog-xlsx.columns.ts';
import {
  ErrorCollector,
  ImportRefusal,
  MAX_COLLECTED_ERRORS,
  MAX_REPORTED_ERRORS,
  ROW_ERROR_MESSAGES,
} from '../../src/modules/catalog-xlsx/catalog-xlsx.errors.ts';
import type { RowErrorCode } from '../../src/modules/catalog-xlsx/catalog-xlsx.errors.ts';
import {
  CATALOG_IMPORT_LIMITS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_SHEET_ROWS,
  READ_ORDER,
  parseWorkbook,
} from '../../src/modules/catalog-xlsx/catalog-xlsx.parse.ts';
import type { ParsedSheet } from '../../src/modules/catalog-xlsx/catalog-xlsx.parse.ts';
import { baseRuleIndex, representedPrices } from '../../src/modules/catalog-xlsx/catalog-xlsx.prices.ts';
import { MAX_PLACE_COLUMNS } from '../../src/modules/catalog-xlsx/catalog-xlsx.repository.ts';
import { MAX_CELL_TEXT, RowReader, headerOf } from '../../src/modules/catalog-xlsx/catalog-xlsx.row.ts';
import {
  PALETTE,
  VARIANT_TYPES,
  decimalOf,
  recognizeByIdOrName,
  recognizeColor,
  recognizeFlag,
  recognizeRate,
  recognizeScaleType,
  recognizeWhole,
  referencesOf,
} from '../../src/modules/catalog-xlsx/catalog-xlsx.rules.ts';
import { exportQuery, importQuery } from '../../src/modules/catalog-xlsx/catalog-xlsx.schemas.ts';
import type { PriceView } from '../../src/modules/products/products.pricing.ts';
import { catalogWorkbook } from '../helpers/catalog-xlsx.ts';
import { workbookOf, zipOf } from '../helpers/xlsx.ts';

describe('catalog-xlsx columns', () => {
  it('has the sheets the legacy workbook has, with their names and order of reading', () => {
    assert.deepEqual(SHEET_NAMES, { products: 'Prodotti', variants: 'Varianti', categories: 'Categorie' });
    assert.deepEqual([...SHEET_KINDS], ['products', 'variants', 'categories']);
    assert.equal(Object.isFrozen(SHEET_NAMES), true);
    assert.equal(PRICE_SLOTS, 15);
  });

  it('has 63, 64 and 9 fixed columns, with unique keys and unique normalized headers', () => {
    assert.equal(FIXED_COLUMNS.products.length, 63);
    assert.equal(FIXED_COLUMNS.variants.length, 64);
    assert.equal(FIXED_COLUMNS.categories.length, 9);
    for (const kind of SHEET_KINDS) {
      assert.equal(new Set(FIXED_COLUMNS[kind].map((column) => column.key)).size, FIXED_COLUMNS[kind].length);
      assert.equal(new Set(FIXED_COLUMNS[kind].map((column) => normalizeHeader(column.header))).size, FIXED_COLUMNS[kind].length);
    }
    assert.equal(FIXED_COLUMNS.variants[1]!.key, 'type');
    assert.equal(FIXED_COLUMNS.products.some((column) => column.key === 'type'), false);
    const lists = FIXED_COLUMNS.products.filter((column) => /^list\d+$/.test(column.key));
    assert.equal(lists.length, PRICE_SLOTS);
    assert.deepEqual(FIXED_COLUMNS.products.find((column) => column.key === 'tax15'), { key: 'tax15', header: 'ALIQUOTA 15 (ID / VALORE)' });
    assert.deepEqual(FIXED_COLUMNS.products.find((column) => column.key === 'list1'), { key: 'list1', header: 'LISTINO 1 (ID / NOME )' });
  });

  it('allows the places columns only where the sheet has them', () => {
    assert.deepEqual(PLACE_KINDS.products, ['DISPO']);
    assert.deepEqual(PLACE_KINDS.variants, ['DISPO']);
    assert.deepEqual([...PLACE_KINDS.categories].sort(), ['BANCO', 'DISPO', 'SALA']);
  });

  it('normalizes a header: trim, collapsed white space, capitals, no space before a closing parenthesis', () => {
    assert.equal(normalizeHeader('  nome \t breve  '), 'NOME BREVE');
    assert.equal(normalizeHeader('LISTINO 1 (ID / NOME )'), 'LISTINO 1 (ID / NOME)');
    assert.equal(normalizeHeader('listino 1 (id / nome)'), 'LISTINO 1 (ID / NOME)');
    assert.equal(normalizeHeader(''), '');
  });

  it('writes the header of a point of sale column', () => {
    assert.equal(placeHeader('DISPO', 'Bar'), 'DISPO | Bar');
    assert.equal(placeHeader('SALA', 'Bar'), 'POSTAZIONI SALA | Bar');
    assert.equal(placeHeader('BANCO', 'Bar'), 'POSTAZIONI BANCO | Bar');
  });

  it('echoes a text without control characters and cuts it at 60 characters', () => {
    assert.equal(echoed('plain'), 'plain');
    assert.equal(echoed('a\u0000b\nc\u007fd\u0085e f g‮h⁦i⁩j'), 'a b c d e f g h i j');
    assert.equal(echoed('x'.repeat(100)), 'x'.repeat(60));
    assert.equal(echoed(`${'x'.repeat(59)}\n${'y'.repeat(10)}`), `${'x'.repeat(59)} `);
  });

  it('reads the text of a cell', () => {
    assert.equal(cellText(undefined), '');
    assert.equal(cellText(null), '');
    assert.equal(cellText(true), null);
    assert.equal(cellText(false), null);
    assert.equal(cellText(12.5), '12.5');
    assert.equal(cellText(0), '0');
    assert.equal(cellText('text'), 'text');
    assert.equal(cellText("'=SUM(A1)"), '=SUM(A1)');
    assert.equal(cellText("''=x"), "'=x");
    assert.equal(cellText("'plain"), "'plain");
  });
});

describe('catalog-xlsx parseHeader', () => {
  const headerOfKey = (kind: 'products' | 'variants' | 'categories', key: string): string => FIXED_COLUMNS[kind].find((column) => column.key === key)!.header;

  it('finds the fixed columns by what they say, wherever they are', () => {
    const header = parseHeader('products', ['PREZZO 1', 'nome', '  ID  ', 'LISTINO 1 (ID / NOME)', 'ALIQUOTA 1 (ID / VALORE )']);
    assert.deepEqual([...header.fixed], [['price1', 0], ['name', 1], ['id', 2], ['list1', 3], ['tax1', 4]]);
    assert.deepEqual(header.places, []);
    assert.deepEqual(header.problems, []);
  });

  it('reads the legacy spacing of the price list headers and every fixed header of every sheet', () => {
    for (const kind of SHEET_KINDS) {
      const headers = FIXED_COLUMNS[kind].map((column) => column.header);
      const parsed = parseHeader(kind, headers);
      assert.deepEqual(parsed.problems, [], kind);
      assert.equal(parsed.fixed.size, headers.length);
      FIXED_COLUMNS[kind].forEach((column, index) => assert.equal(parsed.fixed.get(column.key), index));
      const sloppy = parseHeader(kind, headers.map((header) => header.toLowerCase().replace(' )', ')').replace(/ /g, '  ')));
      assert.equal(sloppy.fixed.size, headers.length, kind);
    }
  });

  it('simply lacks the columns that are missing', () => {
    const header = parseHeader('categories', ['NOME']);
    assert.deepEqual([...header.fixed], [['name', 0]]);
    assert.equal(header.fixed.has('id'), false);
    assert.deepEqual(parseHeader('products', []), { fixed: new Map(), places: [], problems: [] });
  });

  it('reports a header that is not a column of the sheet', () => {
    const header = parseHeader('products', ['NOME', 'COLORE (1-12 / HEX)', 'TIPO (pm / p / m / i)', 'mystery']);
    assert.deepEqual(header.problems, [
      { code: 'unknownColumn', column: 'COLORE (1-12 / HEX)' },
      { code: 'unknownColumn', column: 'TIPO (pm / p / m / i)' },
      { code: 'unknownColumn', column: 'mystery' },
    ]);
    assert.deepEqual([...header.fixed], [['name', 0]]);
    assert.deepEqual(parseHeader('variants', ['TIPO (pm / p / m / i)']).problems, []);
    assert.deepEqual(parseHeader('categories', [headerOfKey('categories', 'color')]).problems, []);
  });

  it('reports a column that comes twice, whatever the spelling', () => {
    const header = parseHeader('products', ['NOME', 'Nome ', 'ID', 'id']);
    assert.deepEqual(header.problems, [
      { code: 'duplicateColumn', column: 'Nome' },
      { code: 'duplicateColumn', column: 'id' },
    ]);
    assert.deepEqual([...header.fixed], [['name', 0], ['id', 2]]);
  });

  it('reads the columns of the points of sale: DISPO on products and variants', () => {
    for (const kind of ['products', 'variants'] as const) {
      const header = parseHeader(kind, ['NOME', 'DISPO | Bar', 'dispo|  Sala grande ', ' Dispo  |Cucina']);
      assert.deepEqual(header.problems, []);
      assert.deepEqual(header.places, [
        { kind: 'DISPO', placeName: 'Bar', index: 1, header: 'DISPO | Bar' },
        { kind: 'DISPO', placeName: 'Sala grande', index: 2, header: 'dispo|  Sala grande' },
        { kind: 'DISPO', placeName: 'Cucina', index: 3, header: 'Dispo  |Cucina' },
      ]);
    }
  });

  it('refuses the print station columns where the sheet does not allow them', () => {
    for (const kind of ['products', 'variants'] as const) {
      const header = parseHeader(kind, ['POSTAZIONI SALA | Bar', 'POSTAZIONI BANCO | Bar']);
      assert.deepEqual(header.places, []);
      assert.deepEqual(header.problems, [
        { code: 'unknownColumn', column: 'POSTAZIONI SALA | Bar' },
        { code: 'unknownColumn', column: 'POSTAZIONI BANCO | Bar' },
      ]);
    }
  });

  it('reads the three kinds of place column of the categories', () => {
    const header = parseHeader('categories', ['ID', 'POSTAZIONI SALA | Bar', 'postazioni  banco | Bar', 'DISPO | Bar']);
    assert.deepEqual(header.problems, []);
    assert.deepEqual(header.places.map((place: PlaceColumn) => [place.kind, place.placeName, place.index]), [['SALA', 'Bar', 1], ['BANCO', 'Bar', 2], ['DISPO', 'Bar', 3]]);
  });

  it('reports a place column with no name, or the same one twice', () => {
    const empty = parseHeader('categories', ['DISPO |', 'POSTAZIONI SALA |   ', 'DISPO | ']);
    assert.deepEqual(empty.problems.map((problem) => problem.code), ['unknownColumn', 'unknownColumn', 'unknownColumn']);
    assert.deepEqual(empty.places, []);
    const twice = parseHeader('products', ['DISPO | Bar', 'DISPO|Bar ', 'DISPO | Cucina']);
    assert.deepEqual(twice.problems, [{ code: 'duplicateColumn', column: 'DISPO|Bar' }]);
    assert.deepEqual(twice.places.map((place) => place.placeName), ['Bar', 'Cucina']);
    // The same name under another kind is another column; the same name with another case is another point of sale.
    const kinds = parseHeader('categories', ['DISPO | Bar', 'POSTAZIONI SALA | Bar', 'DISPO | bar']);
    assert.deepEqual(kinds.problems, []);
    assert.equal(kinds.places.length, 3);
  });

  it('treats a bar header that names no known action as an unknown column', () => {
    const header = parseHeader('categories', ['COSA | Bar', '| Bar', 'NOME | x']);
    assert.deepEqual(header.problems.map((problem) => problem.code), ['unknownColumn', 'unknownColumn', 'unknownColumn']);
    assert.deepEqual(header.places, []);
  });

  it('echoes a header without control characters and cut at 60 characters', () => {
    const header = parseHeader('products', [`bad\u0000\n${'x'.repeat(80)}`, `DISPO | ${'y'.repeat(80)}`, `DISPO | ${'z'.repeat(80)}\u0001`]);
    assert.equal(header.problems[0]!.column.length, 60);
    assert.equal(header.problems[0]!.column.startsWith('bad  xxx'), true);
    assert.equal(header.places[0]!.header.length, 60);
    assert.equal(header.places[0]!.placeName, 'y'.repeat(80));
    assert.equal(header.places[1]!.header.length, 60);
  });

  it('ignores the empty header cells and the ones that cannot be a header', () => {
    const header = parseHeader('products', [null, '', '   ', true, false, 'NOME']);
    assert.deepEqual([...header.fixed], [['name', 5]]);
    assert.deepEqual(header.problems, []);
  });

  it('reads a number as a header, and restores a neutralized formula', () => {
    const header = parseHeader('products', [5, 1.5, "'=NOME", 'ID']);
    assert.deepEqual(header.problems, [
      { code: 'unknownColumn', column: '5' },
      { code: 'unknownColumn', column: '1.5' },
      { code: 'unknownColumn', column: '=NOME' },
    ]);
    assert.deepEqual([...header.fixed], [['id', 3]]);
  });
});

describe('catalog-xlsx rules', () => {
  const items = [
    { id: 'a1', name: 'Pizza' },
    { id: 'a2', name: 'pizza' },
    { id: 'a3', name: 'Dup' },
    { id: 'a4', name: 'Dup' },
    { id: 'Pizza', name: 'Other' },
    { id: 'a6', name: 'Caffè' },
    { id: 'a7', name: 'Due  spazi' },
  ];

  it('recognizes a reference: id first, then the exact name', () => {
    assert.deepEqual(recognizeByIdOrName('a1', items), { kind: 'found', value: items[0] });
    assert.deepEqual(recognizeByIdOrName('  a2  ', items), { kind: 'found', value: items[1] });
    assert.deepEqual(recognizeByIdOrName('pizza', items), { kind: 'found', value: items[1] });
    assert.deepEqual(recognizeByIdOrName('Caffè', items), { kind: 'found', value: items[5] });
    assert.deepEqual(recognizeByIdOrName('Due  spazi', items), { kind: 'found', value: items[6] });
  });

  it('gives the id the precedence over a name that is the id of another element', () => {
    // `Pizza` is the id of the fifth item and the name of the first one.
    assert.deepEqual(recognizeByIdOrName('Pizza', items), { kind: 'found', value: items[4] });
  });

  it('never guesses: case, inner spaces and accents count, and a name two items have is ambiguous', () => {
    assert.deepEqual(recognizeByIdOrName('PIZZA', items), { kind: 'none' });
    assert.deepEqual(recognizeByIdOrName('Caffe', items), { kind: 'none' });
    assert.deepEqual(recognizeByIdOrName('Due spazi', items), { kind: 'none' });
    assert.deepEqual(recognizeByIdOrName('Dup', items), { kind: 'ambiguous' });
    assert.deepEqual(recognizeByIdOrName('', items), { kind: 'none' });
    assert.deepEqual(recognizeByIdOrName('x', []), { kind: 'none' });
  });

  it('reads a decimal number with a point or a comma', () => {
    assert.equal(decimalOf('12'), 12);
    assert.equal(decimalOf('12.5'), 12.5);
    assert.equal(decimalOf(' 12,5 '), 12.5);
    assert.equal(decimalOf('0'), 0);
    assert.equal(decimalOf('123456789'), 123456789);
    assert.equal(decimalOf('1.12345678'), 1.12345678);
    for (const bad of ['', '  ', '.5', '1,', '1,2,3', '-1', '+1', '1e3', 'abc', '1234567890', '1.123456789', '1 2']) {
      assert.equal(decimalOf(bad), null, bad);
    }
  });

  describe('recognizeRate', () => {
    const rates = [
      { id: 'r1', rate: 22 },
      { id: 'r2', rate: 10 },
      { id: 'r3', rate: 10 },
      { id: 'r4', rate: 5.5 },
      { id: '22', rate: 4 },
    ];

    it('takes the id first, even when it looks like a percentage', () => {
      assert.deepEqual(recognizeRate('r1', rates, null), { kind: 'found', value: rates[0] });
      assert.deepEqual(recognizeRate(' r4 ', rates, null), { kind: 'found', value: rates[3] });
      assert.deepEqual(recognizeRate('22', rates, null), { kind: 'found', value: rates[4] });
    });

    it('then the percentage, with a point or a comma', () => {
      const without = rates.filter((rate) => rate.id !== '22');
      assert.deepEqual(recognizeRate('22', without, null), { kind: 'found', value: rates[0] });
      assert.deepEqual(recognizeRate('5,5', without, null), { kind: 'found', value: rates[3] });
      assert.deepEqual(recognizeRate('5.5', without, null), { kind: 'found', value: rates[3] });
      assert.deepEqual(recognizeRate(' 5.5 ', without, 'other'), { kind: 'found', value: rates[3] });
      assert.deepEqual(recognizeRate('22', without, 'r1'), { kind: 'found', value: rates[0] });
    });

    it('is ambiguous when two rates have the percentage, unless the price already has one of them', () => {
      assert.deepEqual(recognizeRate('10', rates, null), { kind: 'ambiguous' });
      assert.deepEqual(recognizeRate('10', rates, 'r1'), { kind: 'ambiguous' });
      assert.deepEqual(recognizeRate('10', rates, 'r2'), { kind: 'found', value: rates[1] });
      assert.deepEqual(recognizeRate('10,0', rates, 'r3'), { kind: 'found', value: rates[2] });
    });

    it('finds nothing for a percentage no rate has, or text that is not a number', () => {
      for (const token of ['7', '', 'abc', '22,', '-22', '5,50001']) {
        assert.deepEqual(recognizeRate(token, rates.filter((rate) => rate.id !== '22'), null), { kind: 'none' }, token);
      }
      assert.deepEqual(recognizeRate('1', [], null), { kind: 'none' });
    });
  });

  it('recognizes a color: the palette, or a hexadecimal one in lower case', () => {
    assert.equal(PALETTE.length, 12);
    assert.equal(Object.isFrozen(PALETTE), true);
    PALETTE.forEach((color, index) => {
      assert.equal(recognizeColor(String(index + 1)), color);
      assert.match(color, /^#[0-9a-f]{6}$/);
    });
    assert.equal(recognizeColor('01'), '#ff8064');
    assert.equal(recognizeColor(' 12 '), '#5c98b1');
    assert.equal(recognizeColor('#AABBCC'), '#aabbcc');
    assert.equal(recognizeColor('#abcdef'), '#abcdef');
    assert.equal(recognizeColor('#AbCdEf'), '#abcdef');
    assert.equal(recognizeColor(''), '');
    assert.equal(recognizeColor('   '), '');
    for (const bad of ['0', '00', '13', '99', '123', '#fff', '#GGGGGG', '#1234567', 'AABBCC', 'red', '-1', '1.5']) {
      assert.equal(recognizeColor(bad), null, bad);
    }
  });

  it('recognizes a flag: X is on, nothing is off, anything else is invalid', () => {
    for (const on of ['X', 'x', ' x ', '\tX']) {
      assert.equal(recognizeFlag(on), true, on);
    }
    for (const off of ['', '   ']) {
      assert.equal(recognizeFlag(off), false);
    }
    for (const bad of ['xx', '1', 'yes', 'no', 'si', 'true', '-', 'X X']) {
      assert.equal(recognizeFlag(bad), null, bad);
    }
  });

  it('recognizes a whole number of up to nine digits', () => {
    assert.equal(recognizeWhole('0'), 0);
    assert.equal(recognizeWhole(' 12 '), 12);
    assert.equal(recognizeWhole('007'), 7);
    assert.equal(recognizeWhole('999999999'), 999999999);
    for (const bad of ['', '1234567890', '-1', '+1', '1.5', '1,5', 'a', '1e3', '1 2']) {
      assert.equal(recognizeWhole(bad), null, bad);
    }
  });

  it('recognizes the type of scale', () => {
    assert.equal(recognizeScaleType('w'), 'weight');
    assert.equal(recognizeScaleType(' W '), 'weight');
    assert.equal(recognizeScaleType('p'), 'piece');
    assert.equal(recognizeScaleType('P'), 'piece');
    assert.equal(recognizeScaleType(''), '');
    assert.equal(recognizeScaleType('  '), '');
    for (const bad of ['x', 'weight', 'pp', '1']) {
      assert.equal(recognizeScaleType(bad), null, bad);
    }
  });

  it('splits a cell of references on the bar, trimming and dropping the empty ones', () => {
    assert.deepEqual(referencesOf('a|b'), ['a', 'b']);
    assert.deepEqual(referencesOf(' a | | b  | '), ['a', 'b']);
    assert.deepEqual(referencesOf('single'), ['single']);
    assert.deepEqual(referencesOf('two words | c'), ['two words', 'c']);
    assert.deepEqual(referencesOf(''), []);
    assert.deepEqual(referencesOf('|||'), []);
    assert.deepEqual(referencesOf('   '), []);
  });

  it('maps the legacy codes of the variants', () => {
    assert.deepEqual([...VARIANT_TYPES], [['pm', 'addRemove'], ['p', 'add'], ['m', 'remove'], ['i', 'info']]);
    assert.equal(VARIANT_TYPES.get('x'), undefined);
    // A text of the file is never a property of the table.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(VARIANT_TYPES.get(name), undefined);
    }
  });
});

function price(over: Partial<PriceView> = {}): PriceView {
  return {
    id: null,
    priceListId: 'L1',
    currency: 'EUR',
    taxId: null,
    tax: null,
    net: 1,
    gross: 1.22,
    discount: null,
    validFrom: null,
    validTo: null,
    dailyFrom: null,
    dailyTo: null,
    weekDays: [],
    fromQuantity: 1,
    maxSaleQuantity: null,
    ...over,
  };
}

describe('catalog-xlsx prices', () => {
  it('picks the rule that always applies, or else the first of the list', () => {
    assert.equal(baseRuleIndex([], 'L1'), -1);
    assert.equal(baseRuleIndex([price({ priceListId: 'L2' })], 'L1'), -1);
    assert.equal(baseRuleIndex([price()], 'L1'), 0);
    assert.equal(baseRuleIndex([price({ fromQuantity: 5 }), price()], 'L1'), 1);
    assert.equal(baseRuleIndex([price({ priceListId: 'L2' }), price({ fromQuantity: 5 }), price()], 'L1'), 2);
    assert.equal(baseRuleIndex([price({ id: 'a' }), price({ id: 'b' })], 'L1'), 0, 'the first of two that always apply');
  });

  it('does not take as the base a rule that has any condition', () => {
    const conditions: Array<Partial<PriceView>> = [
      { fromQuantity: 2 },
      { fromQuantity: 0 },
      { fromQuantity: null },
      { validFrom: '2026-01-01T00:00:00.000Z' },
      { validTo: '2026-12-31T00:00:00.000Z' },
      { dailyFrom: '10:00' },
      { dailyTo: '12:00' },
      { weekDays: [1] },
    ];
    for (const condition of conditions) {
      const rules = [price(condition), price({ id: 'always' })];
      assert.equal(baseRuleIndex(rules, 'L1'), 1, JSON.stringify(condition));
      // With nothing that always applies, the first of the list.
      assert.equal(baseRuleIndex([price({ priceListId: 'L2' }), price(condition), price({ ...condition, id: 'second' })], 'L1'), 1, JSON.stringify(condition));
    }
  });

  it('shows the rule of each price list in the order the lists first appear, at most fifteen', () => {
    assert.deepEqual(representedPrices([]), []);
    const prices = [price({ priceListId: 'B', id: 'b1', fromQuantity: 3 }), price({ priceListId: 'A', id: 'a1' }), price({ priceListId: 'B', id: 'b2' }), price({ priceListId: null, id: 'orphan' }), price({ priceListId: 'A', id: 'a2', fromQuantity: 9 })];
    assert.deepEqual(representedPrices(prices).map((rule) => rule.id), ['b2', 'a1']);
    const many = Array.from({ length: PRICE_SLOTS + 3 }, (_, index) => price({ priceListId: `L${String(index)}`, id: `p${String(index)}` }));
    const shown = representedPrices(many);
    assert.equal(shown.length, PRICE_SLOTS);
    assert.deepEqual(shown.map((rule) => rule.id), many.slice(0, PRICE_SLOTS).map((rule) => rule.id));
  });
});

describe('catalog-xlsx errors', () => {
  it('has a fixed text for every code, and none of them says more than it should', () => {
    for (const [code, message] of Object.entries(ROW_ERROR_MESSAGES)) {
      assert.equal(typeof message, 'string', code);
      assert.notEqual(message, '', code);
    }
    assert.equal(Object.isFrozen(ROW_ERROR_MESSAGES), true);
    assert.equal(MAX_REPORTED_ERRORS, 200);
    assert.equal(MAX_COLLECTED_ERRORS, 1000);
  });

  it('records a problem with the name of its sheet and the fixed text', () => {
    const collector = new ErrorCollector();
    assert.equal(collector.full, false);
    collector.add('products', 7, 'NOME', 'required');
    collector.add('variants', null, null, 'tooManyRows');
    collector.add('categories', 3, 'GENITORE', 'invalidValue', 'field parent, issue unknown');
    assert.equal(collector.count, 3);
    assert.deepEqual(collector.errors, [
      { sheet: 'Prodotti', row: 7, column: 'NOME', code: 'required', message: ROW_ERROR_MESSAGES.required },
      { sheet: 'Varianti', row: null, column: null, code: 'tooManyRows', message: ROW_ERROR_MESSAGES.tooManyRows },
      { sheet: 'Categorie', row: 3, column: 'GENITORE', code: 'invalidValue', message: `${ROW_ERROR_MESSAGES.invalidValue} (field parent, issue unknown)` },
    ]);
  });

  it('lists up to 200 problems, counts up to 1000 and then says it is full', () => {
    const collector = new ErrorCollector();
    for (let index = 1; index <= 250; index += 1) {
      collector.add('products', index, null, 'required');
    }
    assert.equal(collector.errors.length, MAX_REPORTED_ERRORS);
    assert.equal(collector.errors.at(-1)!.row, MAX_REPORTED_ERRORS);
    assert.equal(collector.count, 250);
    assert.equal(collector.full, false);
    for (let index = 251; index < MAX_COLLECTED_ERRORS; index += 1) {
      collector.add('products', index, null, 'required');
    }
    assert.equal(collector.count, 999);
    assert.equal(collector.full, false);
    collector.add('products', 1000, null, 'required');
    assert.equal(collector.full, true);
    assert.equal(collector.errors.length, MAX_REPORTED_ERRORS);
    collector.add('products', 1001, null, 'required');
    assert.equal(collector.count, 1001);
    assert.equal(collector.full, true);
  });

  it('builds the refusal of an import', () => {
    const collector = new ErrorCollector();
    collector.add('products', 2, 'ID', 'invalidId');
    const refusal = new ImportRefusal(collector.errors, 5);
    assert.equal(refusal instanceof Error, true);
    assert.equal(refusal.name, 'ImportRefusal');
    assert.equal(refusal.message, 'The workbook has problems: nothing was imported');
    assert.equal(refusal.errors, collector.errors);
    assert.equal(refusal.errorCount, 5);
  });
});

describe('catalog-xlsx RowReader', () => {
  function readerOf(kind: 'products' | 'categories', headers: Array<string | number | boolean | null>, cells: Array<string | number | boolean | null>, places: PlaceColumn[] = []) {
    const header = parseHeader(kind, headers);
    const sheet: ParsedSheet = { kind, header: { ...header, places }, rows: [] };
    const row: SheetRow = { number: 9, cells };
    const errors = new ErrorCollector();
    return { reader: new RowReader(sheet, row, errors), errors };
  }

  it('gives the header of a fixed column and nothing for another key', () => {
    assert.equal(headerOf('products', 'name'), 'NOME');
    assert.equal(headerOf('categories', 'color'), 'COLORE (1-12 / HEX)');
    assert.equal(headerOf('variants', 'type'), 'TIPO (pm / p / m / i)');
    assert.equal(headerOf('products', 'type'), null);
    assert.equal(headerOf('products', 'DISPO | Bar'), null);
  });

  it('reads the text of a column by its key, trimmed', () => {
    const { reader, errors } = readerOf('products', ['ID', 'NOME', 'PREZZO 1', 'PLU'], ['  abc  ', 'Pizza', 4.5]);
    assert.equal(reader.kind, 'products');
    assert.equal(reader.number, 9);
    assert.equal(reader.text('id'), 'abc');
    assert.equal(reader.text('name'), 'Pizza');
    assert.equal(reader.text('price1'), '4.5');
    assert.equal(reader.text('plu'), '', 'a cell past the end of the row is empty');
    assert.equal(reader.failed, false);
    assert.equal(errors.count, 0);
  });

  it('answers undefined for a column the sheet does not have, and says it has it or not', () => {
    const { reader, errors } = readerOf('products', ['NOME'], ['x']);
    assert.equal(reader.text('id'), undefined);
    assert.equal(reader.has('id'), false);
    assert.equal(reader.has('name'), true);
    assert.equal(reader.failed, false);
    assert.equal(errors.count, 0);
  });

  it('reads an empty cell and a gap as empty text', () => {
    const { reader } = readerOf('products', ['ID', 'NOME'], [null, '']);
    assert.equal(reader.text('id'), '');
    assert.equal(reader.text('name'), '');
    assert.equal(reader.failed, false);
  });

  it('records a boolean cell as an invalid value and reads it as empty', () => {
    const { reader, errors } = readerOf('products', ['ID', 'NOME'], [true, 'ok']);
    assert.equal(reader.text('id'), '');
    assert.equal(reader.failed, true);
    assert.deepEqual(errors.errors, [{ sheet: 'Prodotti', row: 9, column: 'ID', code: 'invalidValue', message: ROW_ERROR_MESSAGES.invalidValue }]);
    assert.equal(reader.text('name'), 'ok');
  });

  it('refuses a cell longer than 4000 characters, and accepts one of exactly 4000', () => {
    assert.equal(MAX_CELL_TEXT, 4000);
    const { reader, errors } = readerOf('products', ['NOME', 'DESCRIZIONE'], ['x'.repeat(4000), 'y'.repeat(4001)]);
    assert.equal(reader.text('name'), 'x'.repeat(4000));
    assert.equal(reader.failed, false);
    assert.equal(reader.text('description'), '');
    assert.equal(reader.failed, true);
    assert.deepEqual(errors.errors.map((error) => [error.column, error.code]), [['DESCRIZIONE', 'invalidValue']]);
  });

  it('measures the length before the trim', () => {
    const { reader } = readerOf('products', ['NOME'], [`${' '.repeat(10)}${'x'.repeat(3995)}`]);
    assert.equal(reader.text('name'), '');
    assert.equal(reader.failed, true);
  });

  it('records a problem on a fixed column under its header, and on any other under the text given', () => {
    const { reader, errors } = readerOf('categories', ['NOME'], ['x']);
    reader.fail('color', 'invalidValue');
    reader.fail('DISPO | Bar', 'unknownPlace', 'a detail');
    reader.fail(null, 'conflict');
    assert.equal(reader.failed, true);
    assert.deepEqual(errors.errors.map((error) => [error.sheet, error.row, error.column, error.code, error.message]), [
      ['Categorie', 9, 'COLORE (1-12 / HEX)', 'invalidValue', ROW_ERROR_MESSAGES.invalidValue],
      ['Categorie', 9, 'DISPO | Bar', 'unknownPlace', `${ROW_ERROR_MESSAGES.unknownPlace} (a detail)`],
      ['Categorie', 9, null, 'conflict', ROW_ERROR_MESSAGES.conflict],
    ]);
  });

  it('reads the text of a point of sale column, and records a problem under its header', () => {
    const places: PlaceColumn[] = [
      { kind: 'DISPO', placeName: 'Bar', index: 1, header: 'DISPO | Bar' },
      { kind: 'SALA', placeName: 'Bar', index: 2, header: 'POSTAZIONI SALA | Bar' },
      { kind: 'BANCO', placeName: 'Bar', index: 3, header: 'POSTAZIONI BANCO | Bar' },
    ];
    const { reader, errors } = readerOf('categories', ['NOME'], ['x', ' X ', 'a|b', true], places);
    assert.equal(reader.placeText(places[0]!), 'X');
    assert.equal(reader.placeText(places[1]!), 'a|b');
    assert.equal(reader.failed, false);
    assert.equal(reader.placeText(places[2]!), '');
    assert.equal(reader.failed, true);
    assert.deepEqual(errors.errors.map((error) => error.column), ['POSTAZIONI BANCO | Bar']);
  });

  it('lets a failed row stay failed', () => {
    const { reader } = readerOf('products', ['NOME'], [true]);
    reader.text('name');
    reader.text('missing');
    assert.equal(reader.failed, true);
  });
});

describe('catalog-xlsx parseWorkbook', () => {
  const asRefusal = (code: string, field: string, issue: string) => (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, [{ field, issue }]);
    return true;
  };

  it('has the limits of the import', () => {
    assert.equal(MAX_IMPORT_SHEET_ROWS, 1000);
    assert.equal(MAX_IMPORT_ROWS, 1500);
    assert.deepEqual([...READ_ORDER], ['products', 'variants', 'categories']);
    assert.equal(CATALOG_IMPORT_LIMITS.maxRows, 2001);
    assert.equal(CATALOG_IMPORT_LIMITS.maxColumns, 9 + 3 * MAX_PLACE_COLUMNS);
    assert.equal(CATALOG_IMPORT_LIMITS.maxCellChars, DEFAULT_XLSX_LIMITS.maxCellChars);
    assert.equal(Object.isFrozen(CATALOG_IMPORT_LIMITS), true);
  });

  it('reads the three sheets by name, with their header and data rows', async () => {
    const file = await catalogWorkbook({
      products: [{ id: 'p1', name: 'Pizza' }, { id: 'p2', name: 'Birra', 'DISPO | Bar': 'X' }],
      variants: [{ name: 'Extra' }],
      categories: [{ name: 'Cibo', 'POSTAZIONI SALA | Bar': 'Forno' }],
    });
    const { sheets } = parseWorkbook(file);
    assert.deepEqual(sheets.map((sheet) => sheet.kind), ['products', 'variants', 'categories']);
    const products = sheets[0]!;
    assert.deepEqual([...products.header.fixed], [['id', 0], ['name', 1]]);
    assert.deepEqual(products.header.places.map((place) => [place.kind, place.placeName, place.index]), [['DISPO', 'Bar', 2]]);
    assert.deepEqual(products.header.problems, []);
    assert.deepEqual(products.rows.map((row) => [row.number, row.cells]), [[2, ['p1', 'Pizza']], [3, ['p2', 'Birra', 'X']]]);
    assert.equal(sheets[2]!.header.places[0]!.kind, 'SALA');
  });

  it('recognizes the sheets by name, in any order of the workbook', async () => {
    const forward = await catalogWorkbook({ products: [{ name: 'a' }], categories: [{ name: 'b' }] });
    const kinds = parseWorkbook(forward).sheets.map((sheet) => sheet.kind);
    assert.deepEqual(kinds, ['products', 'categories']);
    // Sheets with other names (the generic helper has Listino and Altro) are not the catalog's.
    assert.throws(() => parseWorkbook(workbookOf([['NOME'], ['x']])), asRefusal('VALIDATION_ERROR', 'file', 'incorrect'));
  });

  it('leaves out a sheet that has only a header, or nothing, and keeps the others', async () => {
    const file = await catalogWorkbook({ products: [], categories: [{ name: 'Cibo' }], variants: [] }, { products: ['NOME'], variants: ['NOME'] });
    assert.deepEqual(parseWorkbook(file).sheets.map((sheet) => sheet.kind), ['categories']);
  });

  it('refuses a workbook that has none of the three sheets, or only empty ones', async () => {
    assert.throws(() => parseWorkbook(workbookOf([['NOME'], ['x']])), asRefusal('VALIDATION_ERROR', 'file', 'incorrect'));
    const headerOnly = await catalogWorkbook({ products: [] }, { products: ['NOME'] });
    assert.throws(() => parseWorkbook(headerOnly), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'The file does not contain a worksheet');
      return asRefusal('VALIDATION_ERROR', 'file', 'incorrect')(error);
    });
  });

  it('keeps the problems of a header for the importer to report', async () => {
    const file = await catalogWorkbook({ products: [{ name: 'a', 'Strano': 'x' }] });
    const [sheet] = parseWorkbook(file).sheets;
    assert.deepEqual(sheet!.header.problems, [{ code: 'unknownColumn', column: 'Strano' }]);
  });

  it('refuses a sheet with more rows than the limit, and a workbook with more in all', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `n${String(index)}` }));
    const limits = { sheet: 2, total: 3 };
    const atLimit = await catalogWorkbook({ products: rows(2), variants: rows(1) });
    assert.equal(parseWorkbook(atLimit, {}, limits).sheets.length, 2);
    const sheetTooBig = await catalogWorkbook({ products: rows(3) });
    assert.throws(() => parseWorkbook(sheetTooBig, {}, limits), asRefusal('VALIDATION_ERROR', 'file', 'tooMany'));
    const totalTooBig = await catalogWorkbook({ products: rows(2), variants: rows(2) });
    assert.throws(() => parseWorkbook(totalTooBig, {}, limits), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'The file exceeds the limits of an XLSX workbook');
      return asRefusal('VALIDATION_ERROR', 'file', 'tooMany')(error);
    });
    // The header is not a data row; the default limits are large.
    assert.equal(parseWorkbook(totalTooBig).sheets.length, 2);
  });

  it('maps what the reader refuses to 422 file/incorrect with the fixed message', async () => {
    const incorrect = asRefusal('VALIDATION_ERROR', 'file', 'incorrect');
    assert.throws(() => parseWorkbook(Buffer.from('this is not a zip file at all')), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'The file is not an XLSX workbook');
      return incorrect(error);
    });
    const good = await catalogWorkbook({ products: [{ name: 'a' }] });
    const tampered = Buffer.from(good);
    tampered.writeUInt32LE(0x12345678, 0);
    assert.throws(() => parseWorkbook(tampered), incorrect);
    assert.throws(() => parseWorkbook(zipOf([{ name: 'xl/workbook.xml', data: '<workbook' }])), incorrect);
    // The limits of the reader are applied too, and can be replaced.
    assert.throws(() => parseWorkbook(good, { maxEntries: 1 }), incorrect);
    assert.throws(() => parseWorkbook(good, { maxColumns: 0 }), incorrect);
  });

  it('rethrows anything that is not a refusal of the reader, as it is', () => {
    const boom = new RangeError('unexpected');
    const hostile = {
      get maxRows(): number {
        throw boom;
      },
    };
    assert.throws(() => parseWorkbook(Buffer.alloc(0), hostile), (error: unknown) => error === boom);
  });
});

describe('catalog-xlsx schemas', () => {
  const issues = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      return error.details;
    }
    return assert.fail('it should have been refused');
  };

  it('reads the query of the export', () => {
    assert.deepEqual(validate(exportQuery, {}, 'query'), {});
    assert.deepEqual(validate(exportQuery, { references: 'ids' }, 'query'), { references: 'ids' });
    assert.deepEqual(validate(exportQuery, { references: 'names' }, 'query'), { references: 'names' });
  });

  it('refuses another value of references, and any other parameter', () => {
    assert.ok(issues(() => validate(exportQuery, { references: 'other' }, 'query')));
    assert.ok(issues(() => validate(exportQuery, { references: ['ids'] }, 'query')));
    assert.ok(issues(() => validate(exportQuery, { unknown: '1' }, 'query')));
    assert.ok(issues(() => validate(exportQuery, { $where: '1' }, 'query')));
  });

  it('reads the query of the import: dryRun is a boolean', () => {
    assert.deepEqual(validate(importQuery, {}, 'query'), {});
    assert.deepEqual(validate(importQuery, { dryRun: 'true' }, 'query'), { dryRun: true });
    assert.deepEqual(validate(importQuery, { dryRun: 'false' }, 'query'), { dryRun: false });
  });

  it('refuses another value of dryRun, and any other parameter', () => {
    for (const bad of ['yes', '1', 'TRUE', '', true]) {
      assert.ok(issues(() => validate(importQuery, { dryRun: bad }, 'query')), String(bad));
    }
    assert.ok(issues(() => validate(importQuery, { extra: 'x' }, 'query')));
  });
});

describe('catalog-xlsx module', () => {
  it('keeps every error code of the messages usable as a type', () => {
    const code: RowErrorCode = 'tooSlow';
    assert.equal(ROW_ERROR_MESSAGES[code], 'The import takes too long: split the file');
  });
});
