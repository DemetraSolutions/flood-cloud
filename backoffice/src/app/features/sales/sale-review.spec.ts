import { TestBed } from '@angular/core/testing';
import { aSaleDetail, aSaleProduct } from '../../../testing/sales';
import { I18nService } from '../../core/i18n/i18n.service';
import { SaleReview } from './sale-review';
import { SaleAnomaly, SaleDetail, SaleInvoice, SaleOperation, SaleServerCheck } from './sale.types';

function check(over: Partial<SaleServerCheck> = {}): SaleServerCheck {
  return { checkedAt: null, status: 'ok', totals: [], lines: [], linesTruncated: false, ...over };
}

function anomaly(over: Partial<SaleAnomaly> = {}): SaleAnomaly {
  return {
    at: null,
    operation: null,
    source: null,
    code: null,
    productId: null,
    collectionId: null,
    type: null,
    ids: [],
    fields: [],
    ...over,
  };
}

function invoice(over: Partial<SaleInvoice> = {}): SaleInvoice {
  return {
    documentId: 'd1',
    number: null,
    prefixSuffix: null,
    year: null,
    sendStatus: null,
    notQueued: false,
    documentFound: true,
    ...over,
  };
}

async function render(over: Partial<SaleDetail> = {}, currency = 'EUR') {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(SaleReview);
  fixture.componentRef.setInput('sale', aSaleDetail(over));
  fixture.componentRef.setInput('currency', currency);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const section = (id: string) => root.querySelector<HTMLElement>(`section[aria-labelledby="${id}"]`);
  const rows = (id: string, caption?: string) => {
    const scope = section(id)!;
    const table = caption === undefined ? scope : [...scope.querySelectorAll('table')].find((t) => t.querySelector('caption')?.textContent?.trim() === caption)!;
    return [...table.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
    );
  };
  const badges = (id: string) =>
    [...section(id)!.querySelectorAll('fc-status-badge')].map((badge) => [
      badge.textContent?.replace(/\s+/g, ' ').trim(),
      badge.getAttribute('data-tone'),
    ]);
  const text = (id: string) => section(id)!.textContent!.replace(/\s+/g, ' ');
  return { root, section, rows, badges, text, fixture };
}

afterEach(() => vi.restoreAllMocks());

describe('SaleReview', () => {
  it('shows only the anomalies section, saying there are none, for a sale without check, invoice and operations', async () => {
    const { root, section, text } = await render();
    expect([...root.querySelectorAll('section')]).toEqual([section('sale-anomalies')]);
    expect(text('sale-anomalies')).toContain('SALES.ANOMALIES.NONE');
    expect(root.querySelector('table')).toBeNull();
  });

  it('makes the titles of the check, the anomalies and the invoice focusable, so that the header can lead to them', async () => {
    const { root } = await render({ serverCheck: check(), invoice: invoice(), operations: [{ kind: 'create', at: null }] });
    for (const id of ['sale-check', 'sale-anomalies', 'sale-invoice']) {
      const title = root.querySelector<HTMLElement>(`h2#${id}`)!;
      expect(title.getAttribute('tabindex')).toBe('-1');
    }
    expect(root.querySelector('h2#sale-operations')!.hasAttribute('tabindex')).toBe(false);
  });

  describe('check', () => {
    it('shows the state and the date of a check that passed', async () => {
      const { badges, text, section } = await render({ serverCheck: check({ checkedAt: '2026-11-20T10:30:00.000Z' }) });
      expect(badges('sale-check')).toEqual([['SALES.CHECK.STATE_OK', 'success']]);
      expect(text('sale-check')).toContain('SALES.CHECK.CHECKED_AT {"date":"');
      expect(section('sale-check')!.querySelector('table')).toBeNull();
      expect(text('sale-check')).not.toContain('SALES.CHECK.LINES_TRUNCATED');
    });

    it('explains what the check is before the state', async () => {
      const { text } = await render({ serverCheck: check() });
      expect(text('sale-check')).toContain('SALES.CHECK.INTRO');
    });

    it('shows the differences, without a date when the check has none', async () => {
      const { badges, text } = await render({ serverCheck: check({ status: 'differences' }) });
      expect(badges('sale-check')).toEqual([['SALES.CHECK.STATE_DIFFERENCES', 'warning']]);
      expect(text('sale-check')).not.toContain('SALES.CHECK.CHECKED_AT');
    });

    it('shows a check without a state as not determined', async () => {
      const { badges } = await render({ serverCheck: check({ status: null }) });
      expect(badges('sale-check')).toEqual([['SALES.CHECK.STATE_UNKNOWN', 'neutral']]);
    });

    it('lists the totals with what the cash desk sent, what the system worked out and the gap', async () => {
      const { rows, section } = await render({
        serverCheck: check({
          status: 'differences',
          totals: [
            { field: 'total', pos: 10, server: 10.5 },
            { field: 'tax', pos: null, server: 2 },
            { field: 'payments', pos: 3, server: null },
            { field: 'made-up', pos: null, server: null },
          ],
        }),
      });
      const table = rows('sale-check');
      const unavailable = '—SALES.CHECK.UNAVAILABLE';
      expect(table.map((row) => row[0])).toEqual([
        'SALES.CHECK_FIELD.total',
        'SALES.CHECK_FIELD.tax',
        'SALES.CHECK_FIELD.payments',
        'SALES.CHECK_FIELD.UNKNOWN {"code":"made-up"}',
      ]);
      expect(table[0][1]).toMatch(/^10,00\s*€$/);
      expect(table[0][2]).toMatch(/^10,50\s*€$/);
      expect(table[0][3]).toMatch(/^[-\u2212]0,50\s*€$/);
      expect(table[1].slice(1)).toEqual([unavailable, expect.stringMatching(/^2,00\s*€$/), unavailable]);
      expect(table[2].slice(1)).toEqual([expect.stringMatching(/^3,00\s*€$/), unavailable, unavailable]);
      expect(table[3].slice(1)).toEqual([unavailable, unavailable, unavailable]);
      const headers = [...section('sale-check')!.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
      expect(headers).toEqual(['SALES.CHECK.FIELD', 'SALES.CHECK.POS', 'SALES.CHECK.SERVER', 'SALES.CHECK.DELTA']);
    });

    it('shows an amount that is not available as a dash hidden from screen readers, and says so out loud', async () => {
      const { section } = await render({
        serverCheck: check({ totals: [{ field: 'tax', pos: null, server: 2 }] }),
      });
      const cells = section('sale-check')!.querySelectorAll('tbody tr td');
      const first = cells[0];
      expect(first.querySelector('[aria-hidden="true"]')!.textContent).toBe('—');
      expect(first.querySelector('.visually-hidden')!.textContent).toBe('SALES.CHECK.UNAVAILABLE');
      expect(cells[1].querySelector('.visually-hidden')).toBeNull();
    });

    it('names the tables of the check differently from the title', async () => {
      const { section } = await render({
        serverCheck: check({
          totals: [{ field: 'total', pos: 1, server: 2 }],
          lines: [{ index: 0, code: 'taxMissing', pos: null, server: null }],
        }),
      });
      const captions = [...section('sale-check')!.querySelectorAll('caption')].map((c) => c.textContent?.trim());
      expect(captions).toEqual(['SALES.CHECK.TOTALS', 'SALES.CHECK.LINES']);
    });

    it('lists the differences of the lines with the name of the line, or its position', async () => {
      const { rows, text } = await render(
        {
          products: [
            aSaleProduct({ index: 0, name: 'Caffè', code: 'C1' }),
            aSaleProduct({ index: 1, name: null, code: 'C2' }),
            aSaleProduct({ index: 2, name: null, code: null }),
          ],
          serverCheck: check({
            status: 'differences',
            linesTruncated: true,
            lines: [
              { index: 0, code: 'taxMissing', pos: null, server: null },
              { index: 1, code: 'lineTotalMismatch', pos: 1, server: 2 },
              { index: 2, code: 'priceMissing', pos: null, server: null },
              { index: 7, code: 'new-code', pos: null, server: null },
            ],
          }),
        },
        'USD',
      );
      const table = rows('sale-check');
      expect(table.every((row) => row.length === 4)).toBe(true);
      expect(table.map((row) => row.slice(0, 2))).toEqual([
        ['#1 Caffè', 'SALES.CHECK_LINE.taxMissing'],
        ['#2 C2', 'SALES.CHECK_LINE.lineTotalMismatch'],
        ['#3', 'SALES.CHECK_LINE.priceMissing'],
        ['#8', 'SALES.CHECK_LINE.UNKNOWN {"code":"new-code"}'],
      ]);
      expect(table[1][2]).toContain('USD');
      expect(table[1][3]).toContain('USD');
      expect(table[0][2]).toBe('—SALES.CHECK.UNAVAILABLE');
      expect(text('sale-check')).toContain('SALES.CHECK.LINES_TRUNCATED');
    });
  });

  describe('anomalies', () => {
    it('explains the section and says none were recorded when there are none', async () => {
      const { text, section } = await render({ anomalies: [] });
      expect(text('sale-anomalies')).toContain('SALES.ANOMALIES.INTRO');
      expect(text('sale-anomalies')).toContain('SALES.ANOMALIES.NONE');
      expect(section('sale-anomalies')!.querySelector('table')).toBeNull();
    });

    it('shows the table, with its own caption, and not the line of none when there are anomalies', async () => {
      const { text, section } = await render({ anomalies: [anomaly({ code: 'cycle' })] });
      expect(text('sale-anomalies')).toContain('SALES.ANOMALIES.INTRO');
      expect(text('sale-anomalies')).not.toContain('SALES.ANOMALIES.NONE');
      expect(section('sale-anomalies')!.querySelector('caption')!.textContent?.trim()).toBe('SALES.ANOMALIES.TABLE');
    });

    it('shows the date, the anomaly, its origin and the operation', async () => {
      const { rows } = await render({
        anomalies: [
          anomaly({ at: '2026-11-20T10:30:00.000Z', code: 'cycle', source: 'stock', operation: 'refund' }),
        ],
      });
      const [row] = rows('sale-anomalies');
      expect(row[0]).not.toBe('');
      expect(row.slice(1)).toEqual(['SALES.ANOMALY_CODE.cycle', 'SALES.ANOMALY_SOURCE.stock', 'SALES.OPERATION.refund', '']);
    });

    it('shows a code, an origin and an operation it does not know with their text, and missing ones as such', async () => {
      const { rows } = await render({
        anomalies: [
          anomaly({ code: 'brandNew', source: 'cloud', operation: 'merge' }),
          anomaly({}),
        ],
      });
      const table = rows('sale-anomalies');
      expect(table[0]).toEqual([
        '',
        'SALES.ANOMALY_CODE.UNKNOWN {"code":"brandNew"}',
        'SALES.ANOMALY_SOURCE.UNKNOWN {"code":"cloud"}',
        'SALES.OPERATION.UNKNOWN {"code":"merge"}',
        '',
      ]);
      expect(table[1]).toEqual([
        '',
        'SALES.ANOMALY_CODE.NONE',
        'SALES.ANOMALY_SOURCE.NONE',
        'SALES.OPERATION.NONE',
        '',
      ]);
    });

    it('adds the sales a deferred invoice could not gather and the fields out of their domain', async () => {
      const { rows } = await render({
        anomalies: [
          anomaly({ code: 'invoiceXmlInvalid', ids: ['a', 'b'] }),
          anomaly({ code: 'invoiceXmlInvalid', fields: ['x.y', 'z'] }),
          anomaly({ code: 'invoiceXmlInvalid', ids: ['a'], fields: ['q'] }),
        ],
      });
      const details = rows('sale-anomalies').map((row) => row[4]);
      expect(details).toEqual([
        'SALES.ANOMALIES.SALES {"count":2}',
        'SALES.ANOMALIES.FIELDS {"fields":"x.y, z"}',
        'SALES.ANOMALIES.SALES {"count":1}; SALES.ANOMALIES.FIELDS {"fields":"q"}',
      ]);
    });
  });

  describe('invoice', () => {
    it('has no section for a sale without an invoice', async () => {
      const { section } = await render({ invoice: null });
      expect(section('sale-invoice')).toBeNull();
    });

    it('writes the number with the series and the year, and the state of the sending', async () => {
      const { text, badges } = await render({
        invoice: invoice({ number: 15, prefixSuffix: 'A', year: 2026, sendStatus: 'delivered' }),
      });
      expect(text('sale-invoice')).toContain(
        'SALES.INVOICE.NUMBER_OF {"number":15}, SALES.INVOICE.SERIES_OF {"series":"A"}, SALES.INVOICE.YEAR_OF {"year":2026}',
      );
      expect(badges('sale-invoice')).toEqual([['SALES.SEND_STATUS.delivered', 'success']]);
      expect(text('sale-invoice')).not.toContain('SALES.INVOICE.NO_SENDING');
      expect(text('sale-invoice')).not.toContain('SALES.INVOICE.DOCUMENT_MISSING');
    });

    it('leaves out the series when it is empty or missing, and the year when it is missing', async () => {
      for (const prefixSuffix of ['', null]) {
        const { text } = await render({ invoice: invoice({ number: 3, prefixSuffix, year: null, sendStatus: 'queued' }) });
        expect(text('sale-invoice')).toContain('SALES.INVOICE.NUMBER_OF {"number":3}');
        expect(text('sale-invoice')).not.toContain('SERIES_OF');
        expect(text('sale-invoice')).not.toContain('YEAR_OF');
        TestBed.resetTestingModule();
      }
    });

    it('shows no number for an invoice without one', async () => {
      const { section } = await render({ invoice: invoice({ number: null, prefixSuffix: 'A', year: 2026, sendStatus: 'queued' }) });
      expect(section('sale-invoice')!.querySelector('.emphasis')).toBeNull();
    });

    it('shows an invoice the server says is not queued with a warning and its note', async () => {
      const { badges, text } = await render({ invoice: invoice({ number: 1, notQueued: true, sendStatus: 'queued' }) });
      expect(badges('sale-invoice')).toEqual([['SALES.INVOICE.NOT_QUEUED', 'warning']]);
      expect(text('sale-invoice')).toContain('SALES.INVOICE.NOT_QUEUED_NOTE');
      expect(text('sale-invoice')).not.toContain('SALES.INVOICE.NO_SENDING');
    });

    it('shows the same warning for the state "not queued" without the flag', async () => {
      const { badges, text } = await render({ invoice: invoice({ sendStatus: 'notQueued' }) });
      expect(badges('sale-invoice')).toEqual([['SALES.INVOICE.NOT_QUEUED', 'warning']]);
      expect(text('sale-invoice')).toContain('SALES.INVOICE.NOT_QUEUED_NOTE');
    });

    it('shows a state of sending it does not know as it is, in a neutral badge', async () => {
      const { badges } = await render({ invoice: invoice({ sendStatus: 'weird' }) });
      expect(badges('sale-invoice')).toEqual([['weird', 'neutral']]);
    });

    it('says there is no sending from this platform when the invoice has no state', async () => {
      const { badges, text } = await render({ invoice: invoice({ number: 4, sendStatus: null }) });
      expect(badges('sale-invoice')).toEqual([]);
      expect(text('sale-invoice')).toContain('SALES.INVOICE.NO_SENDING');
    });

    it('shows a document that is missing, without the note of no sending', async () => {
      const { badges, text } = await render({ invoice: invoice({ documentFound: false }) });
      expect(badges('sale-invoice')).toEqual([['SALES.INVOICE.DOCUMENT_MISSING', 'danger']]);
      expect(text('sale-invoice')).toContain('SALES.INVOICE.DOCUMENT_MISSING_NOTE');
      expect(text('sale-invoice')).not.toContain('SALES.INVOICE.NO_SENDING');
    });
  });

  describe('operations', () => {
    it('has no section without operations', async () => {
      const { section } = await render({ operations: [] });
      expect(section('sale-operations')).toBeNull();
    });

    it('lists the kind and the date of each operation, the unknown and missing ones included', async () => {
      const operations: SaleOperation[] = [
        { kind: 'create', at: '2026-11-20T10:30:00.000Z' },
        { kind: 'x', at: null },
        { kind: null, at: null },
      ];
      const { rows } = await render({ operations });
      const table = rows('sale-operations');
      expect(table.map((row) => row[0])).toEqual([
        'SALES.OPERATION.create',
        'SALES.OPERATION.UNKNOWN {"code":"x"}',
        'SALES.OPERATION.NONE',
      ]);
      expect(table[0][1]).not.toBe('');
      expect(table[1][1]).toBe('');
    });

    it('gives the table a caption that is not the title', async () => {
      const { section } = await render({ operations: [{ kind: 'create', at: null }] });
      expect(section('sale-operations')!.querySelector('caption')!.textContent?.trim()).toBe('SALES.OPERATIONS.TABLE');
    });
  });
});
