import { Price } from './product.types';
import {
  grossFromNet,
  moneyText,
  netFromGross,
  newPriceRow,
  PriceRow,
  priceBody,
  priceIssues,
  priceRowOf,
  priceSummary,
  withTaxRate,
  withWrittenPrice,
} from './product-prices';

const row = (overrides: Partial<PriceRow> = {}): PriceRow => ({
  ...newPriceRow('pl1', 'EUR', 't1', 22),
  ...overrides,
});

const PRICE: Price = {
  id: 'r1',
  priceListId: 'pl1',
  currency: 'EUR',
  taxId: 't1',
  tax: null,
  net: 10,
  gross: 12.2,
  discount: 5,
  validFrom: null,
  validTo: null,
  dailyFrom: '08:00',
  dailyTo: '12:30',
  weekDays: [3, 1],
  fromQuantity: 2,
  maxSaleQuantity: null,
};

describe('conversions', () => {
  it('computes the gross price to two decimals', () => {
    expect(grossFromNet('10', 22)).toBe('12.20');
    expect(grossFromNet(' 1.005 ', 0)).toBe('1.00');
  });

  it('gives nothing for an empty or not numeric net price or an unknown rate', () => {
    expect(grossFromNet('', 22)).toBe('');
    expect(grossFromNet('  ', 22)).toBe('');
    expect(grossFromNet('abc', 22)).toBe('');
    expect(grossFromNet('10', null)).toBe('');
  });

  it('computes the net price to eight decimals without trailing zeros', () => {
    expect(netFromGross('12.2', 22)).toBe('10');
    expect(netFromGross('1', 22)).toBe('0.81967213');
  });

  it('gives nothing for an empty or not numeric gross price or an unknown rate', () => {
    expect(netFromGross('', 22)).toBe('');
    expect(netFromGross('x', 22)).toBe('');
    expect(netFromGross('10', null)).toBe('');
  });
});

describe('withWrittenPrice', () => {
  it('follows a written net price with the gross one', () => {
    expect(withWrittenPrice(row({ written: 'gross' }), 'net', '100', 22)).toMatchObject({
      net: '100',
      gross: '122.00',
      written: 'net',
    });
  });

  it('follows a written gross price with the net one', () => {
    expect(withWrittenPrice(row(), 'gross', '122', 22)).toMatchObject({ gross: '122', net: '100', written: 'gross' });
  });

  it('empties the other price for an unknown rate', () => {
    expect(withWrittenPrice(row(), 'net', '5', null)).toMatchObject({ net: '5', gross: '' });
  });
});

describe('withTaxRate', () => {
  it('recomputes the gross price of a net one', () => {
    expect(withTaxRate(row({ net: '100', gross: '122.00' }), 't2', 10)).toMatchObject({ taxId: 't2', net: '100', gross: '110.00' });
  });

  it('recomputes the net price of a gross one', () => {
    expect(withTaxRate(row({ written: 'gross', net: '100', gross: '110' }), 't2', 10)).toMatchObject({
      taxId: 't2',
      gross: '110',
      net: '100',
    });
  });

  it('keeps both prices when the rate is unknown', () => {
    const net = row({ net: '5', gross: '6.10' });
    expect(withTaxRate(net, 't9', null)).toMatchObject({ taxId: 't9', net: '5', gross: '6.10' });
    const gross = row({ written: 'gross', net: '5', gross: '6.10' });
    expect(withTaxRate(gross, 't9', null)).toMatchObject({ taxId: 't9', net: '5', gross: '6.10' });
  });
});

describe('priceRowOf', () => {
  it('turns a price into a form row, written by net', () => {
    expect(priceRowOf(PRICE)).toEqual({
      id: 'r1',
      priceListId: 'pl1',
      currency: 'EUR',
      taxId: 't1',
      net: '10',
      gross: '12.2',
      written: 'net',
      discount: '5',
      validFrom: '',
      validTo: '',
      dailyFrom: '08:00',
      dailyTo: '12:30',
      weekDays: [3, 1],
      fromQuantity: '2',
      maxSaleQuantity: '',
    });
  });

  it('fills what the price lacks', () => {
    const empty: Price = {
      ...PRICE,
      priceListId: null,
      currency: null,
      taxId: null,
      net: null,
      gross: null,
      discount: null,
      dailyFrom: null,
      dailyTo: null,
      weekDays: [],
      fromQuantity: null,
    };
    expect(priceRowOf(empty)).toMatchObject({
      priceListId: '',
      currency: '',
      taxId: '',
      net: '',
      gross: '',
      discount: '0',
      dailyFrom: '',
      dailyTo: '',
      fromQuantity: '',
    });
  });

  it('copies the week days', () => {
    const days = [1];
    const result = priceRowOf({ ...PRICE, weekDays: days });
    expect(result.weekDays).not.toBe(days);
  });

  it('shows the dates in local time', () => {
    expect(priceRowOf({ ...PRICE, validFrom: '2026-03-04T10:20:00.000Z' }).validFrom).toMatch(/^2026-03-04T\d\d:20$/);
  });
});

describe('newPriceRow', () => {
  it('is a rule of price 0 with the first tax rate', () => {
    expect(newPriceRow('pl1', 'EUR', 't1', 22)).toEqual({
      id: null,
      priceListId: 'pl1',
      currency: 'EUR',
      taxId: 't1',
      net: '0',
      gross: '0.00',
      written: 'net',
      discount: '0',
      validFrom: '',
      validTo: '',
      dailyFrom: '',
      dailyTo: '',
      weekDays: [],
      fromQuantity: '1',
      maxSaleQuantity: '',
    });
  });

  it('has no gross price for an unknown rate', () => {
    expect(newPriceRow('pl1', 'EUR', 't1', null).gross).toBe('');
  });
});

describe('priceIssues', () => {
  it('has none for a valid rule', () => {
    expect(priceIssues(row())).toEqual({});
    expect(priceIssues(row({ validFrom: '2026-01-01T10:00', validTo: '2026-01-02T10:00', dailyFrom: '08:00', dailyTo: '23:59' }))).toEqual({});
  });

  it('requires the price list, the currency and the tax rate', () => {
    expect(priceIssues(row({ priceListId: '', currency: '', taxId: '' }))).toEqual({
      priceListId: 'required',
      currency: 'required',
      taxId: 'required',
    });
  });

  it('requires the net price only without a gross one', () => {
    expect(priceIssues(row({ net: '', gross: '' }))).toEqual({ net: 'required' });
    expect(priceIssues(row({ net: '', gross: '12' }))).toEqual({});
  });

  it('checks the amounts', () => {
    expect(priceIssues(row({ net: 'x', gross: '-1', discount: '101', fromQuantity: '-2', maxSaleQuantity: '2000000000' }))).toEqual({
      net: 'type',
      gross: 'minimum',
      discount: 'maximum',
      fromQuantity: 'minimum',
      maxSaleQuantity: 'maximum',
    });
  });

  it('checks the dates, also against each other', () => {
    expect(priceIssues(row({ validFrom: 'bad', validTo: 'bad' }))).toEqual({ validFrom: 'incorrect', validTo: 'incorrect' });
    expect(priceIssues(row({ validFrom: '2026-02-01T10:00', validTo: '2026-01-01T10:00' }))).toEqual({ validTo: 'incorrect' });
  });

  it('checks the hours of the day', () => {
    expect(priceIssues(row({ dailyFrom: '24:00', dailyTo: '8:00' }))).toEqual({ dailyFrom: 'format', dailyTo: 'format' });
  });
});

describe('priceBody', () => {
  it('sends the net price a user wrote, without the id of a new rule', () => {
    expect(priceBody(row({ net: '10', gross: '12.20', discount: '5', weekDays: [5, 1], fromQuantity: '2' }))).toEqual({
      priceListId: 'pl1',
      currency: 'EUR',
      taxId: 't1',
      net: 10,
      discount: 5,
      validFrom: null,
      validTo: null,
      dailyFrom: null,
      dailyTo: null,
      weekDays: [1, 5],
      fromQuantity: 2,
      maxSaleQuantity: null,
    });
  });

  it('sends the gross price a user wrote last, with the id and the dates of a stored rule', () => {
    const body = priceBody(
      row({
        id: 'r1',
        written: 'gross',
        gross: '12.20',
        net: '10',
        validFrom: '2026-01-01T10:00',
        validTo: '2026-01-02T10:00',
        dailyFrom: '08:00',
        dailyTo: '10:00',
        maxSaleQuantity: '9',
      }),
    );
    expect(body).toMatchObject({
      id: 'r1',
      gross: 12.2,
      dailyFrom: '08:00',
      dailyTo: '10:00',
      maxSaleQuantity: 9,
    });
    expect(body).not.toHaveProperty('net');
    expect(typeof body['validFrom']).toBe('string');
    expect(typeof body['validTo']).toBe('string');
  });

  it('sends the other price when the written one is empty', () => {
    expect(priceBody(row({ written: 'gross', gross: '', net: '10' }))).toMatchObject({ net: 10 });
    expect(priceBody(row({ written: 'net', net: '', gross: '12' }))).toMatchObject({ gross: 12 });
  });

  it('sends a discount of 0 when it is empty', () => {
    expect(priceBody(row({ discount: ' ' }))).toMatchObject({ discount: 0 });
  });
});

describe('priceSummary', () => {
  it('shows the amounts before and after the discount', () => {
    expect(priceSummary(row({ net: '100', gross: '122', discount: '10' }))).toEqual({
      gross: 122,
      net: 100,
      discountedGross: 109.8,
      discountedNet: 90,
    });
  });

  it('has no amount for an empty or not numeric price and no discount for an empty one', () => {
    expect(priceSummary(row({ net: '', gross: 'x', discount: '' }))).toEqual({
      gross: null,
      net: null,
      discountedGross: null,
      discountedNet: null,
    });
    expect(priceSummary(row({ net: '10', gross: '', discount: '' }))).toMatchObject({ net: 10, discountedNet: 10 });
  });
});

describe('moneyText', () => {
  it('has two decimals, and nothing for none', () => {
    expect(moneyText(1)).toBe('1.00');
    expect(moneyText(1.239)).toBe('1.24');
    expect(moneyText(null)).toBe('');
  });
});
