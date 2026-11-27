import {
  badgeText,
  invoiceNotQueued,
  periodOf,
  receiptLabel,
  SALE_BADGE_KEYS,
  saleBadges,
  SaleFilter,
  SaleInvoice,
  saleParams,
  saleRoute,
  SaleRow,
} from './sale.types';

const FILTER: SaleFilter = { contactId: 'c1', placeId: '', from: '', to: '' };
const NOW = new Date(2026, 10, 25, 15, 0, 0);

function row(over: Partial<SaleRow> = {}): SaleRow {
  return {
    id: 's1',
    date: '2026-11-20T10:00:00.000Z',
    receiptType: 'receipt',
    nonFiscal: false,
    number: { report: 12, number: 345 },
    fiscalState: null,
    refunds: [],
    unpaid: 0,
    invoiced: false,
    total: 10,
    companyId: 'a',
    placeId: 'p',
    cashDesk: null,
    operator: null,
    table: null,
    customer: null,
    ...over,
  };
}

describe('saleRoute', () => {
  it('points to the page of a sale of the group', () => {
    expect(saleRoute('g1', 's1')).toEqual(['/groups', 'g1', 'sales', 's1']);
  });
});

describe('receiptLabel', () => {
  it.each([
    [null, ''],
    [{ report: 12, number: 345 }, '12-345'],
    [{ report: null, number: 7 }, '7'],
    [{ report: '3', number: null }, '3'],
    [{ report: '', number: null }, ''],
  ])('writes %j as "%s"', (value, text) => {
    expect(receiptLabel(value)).toBe(text);
  });
});

describe('periodOf', () => {
  it('is none without dates', () => {
    expect(periodOf(FILTER, NOW)).toBeNull();
    expect(periodOf({ from: 'not a date', to: '' }, NOW)).toBeNull();
  });

  it('runs from the start of the first day to the start of the day after the last one (local time)', () => {
    const period = periodOf({ from: '2026-11-01', to: '2026-11-30' }, NOW)!;
    expect(period.from).toBe(new Date(2026, 10, 1).toISOString());
    expect(period.to).toBe(new Date(2026, 11, 1).toISOString());
  });

  it('leaves the missing end open: the start of time, or tomorrow', () => {
    expect(periodOf({ from: '', to: '2026-11-30' }, NOW)).toEqual({
      from: '1970-01-01T00:00:00.000Z',
      to: new Date(2026, 11, 1).toISOString(),
    });
    expect(periodOf({ from: '2026-11-01', to: '' }, NOW)).toEqual({
      from: new Date(2026, 10, 1).toISOString(),
      to: new Date(2026, 10, 26).toISOString(),
    });
  });

  it('keeps the end after the start when the first day is in the future', () => {
    expect(periodOf({ from: '2026-12-10', to: '' }, NOW)).toEqual({
      from: new Date(2026, 11, 10).toISOString(),
      to: new Date(2026, 11, 11).toISOString(),
    });
  });

  it('uses the clock when no time is given', () => {
    expect(periodOf({ from: '2026-11-01', to: '' })?.to).toBe(
      new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).toISOString(),
    );
  });
});

describe('saleParams', () => {
  it('sends the contact alone by default', () => {
    expect(saleParams(FILTER, false, NOW)).toEqual({ contactId: 'c1' });
  });

  it('adds the store, both ends of the period and nonFiscal=include only when asked', () => {
    expect(saleParams({ ...FILTER, placeId: 'p1', from: '2026-11-01', to: '2026-11-02' }, true, NOW)).toEqual({
      contactId: 'c1',
      placeId: 'p1',
      from: new Date(2026, 10, 1).toISOString(),
      to: new Date(2026, 10, 3).toISOString(),
      nonFiscal: 'include',
    });
  });

  it('uses the clock when no time is given', () => {
    expect(saleParams({ ...FILTER, from: '2026-11-01' }, false)['from']).toBeDefined();
  });
});

describe('saleBadges', () => {
  it('has none for a plain receipt', () => {
    expect(saleBadges(row())).toEqual([]);
  });

  it('names invoice, charge, non fiscal, unpaid and invoiced', () => {
    expect(saleBadges(row({ receiptType: 'invoice' })).map((b) => b.key)).toEqual(['INVOICE']);
    expect(saleBadges(row({ receiptType: 'charge' })).map((b) => b.key)).toEqual(['CHARGE']);
    expect(
      saleBadges(row({ nonFiscal: true, unpaid: 5, invoiced: true })).map((b) => b.key),
    ).toEqual(['NON_FISCAL', 'UNPAID', 'INVOICED']);
  });

  it('marks a canceled sale and a refunded one with the numbers of its refunds', () => {
    expect(saleBadges(row({ fiscalState: 'canceled' }))).toEqual([{ key: 'CANCELED', tone: 'danger', detail: '' }]);
    const refunded = saleBadges(
      row({ fiscalState: 'refunded', refunds: [{ report: 1, number: 2 }, { report: null, number: null }, { report: 3, number: 4 }] }),
    );
    expect(refunded).toEqual([{ key: 'REFUNDED', tone: 'warning', detail: '1-2, 3-4' }]);
  });
});

describe('badgeText', () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`;

  it('writes the numbers of the refunds when there are some', () => {
    expect(badgeText(t, { key: 'REFUNDED', tone: 'warning', detail: '1-2' })).toBe('SALES.BADGE.REFUNDED_NUMBERS {"numbers":"1-2"}');
    expect(badgeText(t, { key: 'REFUNDED', tone: 'warning', detail: '' })).toBe('SALES.BADGE.REFUNDED');
  });

  it('lists every kind of badge', () => {
    expect(SALE_BADGE_KEYS).toHaveLength(7);
  });
});

describe('invoiceNotQueued', () => {
  const invoice = (over: Partial<SaleInvoice> = {}): SaleInvoice => ({
    documentId: 'd1',
    number: null,
    prefixSuffix: null,
    year: null,
    sendStatus: null,
    notQueued: false,
    documentFound: true,
    ...over,
  });

  it('is false without an invoice and for an invoice that goes on', () => {
    expect(invoiceNotQueued(null)).toBe(false);
    expect(invoiceNotQueued(invoice())).toBe(false);
    expect(invoiceNotQueued(invoice({ sendStatus: 'queued' }))).toBe(false);
  });

  it('is true when the server says the sending did not start, or the state of the document does', () => {
    expect(invoiceNotQueued(invoice({ notQueued: true }))).toBe(true);
    expect(invoiceNotQueued(invoice({ sendStatus: 'notQueued' }))).toBe(true);
  });
});
