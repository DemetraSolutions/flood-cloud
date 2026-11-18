import {
  centsToEuroText,
  euroTextToCents,
  MAX_CENTS,
  plansToRows,
  priceIssue,
  pricesToCents,
  SERVICE_KEYS,
  servicesToModel,
} from './price-list.types';

describe('euroTextToCents', () => {
  it.each([
    ['20', 2000],
    ['20,5', 2050],
    ['20.50', 2050],
    ['0,05', 5],
    ['  7,00 ', 700],
    ['100000', MAX_CENTS],
  ])('reads %s as %d cents', (text, cents) => {
    expect(euroTextToCents(text)).toBe(cents);
  });

  it.each(['', 'abc', '-1', '1,234', '1e3', '1,', ',5', '100000,01', '99999999'])(
    'refuses %j',
    (text) => {
      expect(euroTextToCents(text)).toBeNull();
    },
  );

  it('does not lose cents to floating point arithmetic', () => {
    expect(euroTextToCents('1.15')).toBe(115);
    expect(euroTextToCents('0.29')).toBe(29);
  });
});

describe('centsToEuroText', () => {
  it('writes two decimals with the decimal comma', () => {
    expect(centsToEuroText(2000)).toBe('20,00');
    expect(centsToEuroText(5)).toBe('0,05');
    expect(centsToEuroText(10_000_000)).toBe('100000,00');
  });
});

describe('priceIssue', () => {
  it('names why a price is refused', () => {
    expect(priceIssue('')).toBe('required');
    expect(priceIssue('  ')).toBe('required');
    expect(priceIssue('abc')).toBe('pattern');
    expect(priceIssue('100000,01')).toBe('maximum');
    expect(priceIssue('12,5')).toBeUndefined();
  });

  it('accepts an empty price when it is optional', () => {
    expect(priceIssue('', true)).toBeUndefined();
    expect(priceIssue('abc', true)).toBe('pattern');
  });
});

describe('form models', () => {
  it('writes every service, empty when the list has none', () => {
    const model = servicesToModel({ kiosk: 1500, extraDesk: 5, unknown: 9 });
    expect(Object.keys(model)).toEqual([...SERVICE_KEYS]);
    expect(model.kiosk).toBe('15,00');
    expect(model.extraDesk).toBe('0,05');
    expect(model.api).toBe('');
    expect(servicesToModel(undefined).kiosk).toBe('');
  });

  it('sorts the plans by key', () => {
    expect(plansToRows({ b: 300, a: 200 })).toEqual([
      { key: 'a', price: '2,00' },
      { key: 'b', price: '3,00' },
    ]);
  });

  it('converts to cents and leaves out the empty prices', () => {
    expect(
      pricesToCents([
        ['basic', '20,00'],
        ['pro', ''],
        ['x', ' 1.5 '],
      ]),
    ).toEqual({ basic: 2000, x: 150 });
  });
});
