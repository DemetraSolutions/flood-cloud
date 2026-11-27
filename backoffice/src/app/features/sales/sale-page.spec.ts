import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { emulateNativeDialog } from '../../../testing/dialog';
import { aSaleDetail, aSaleProduct } from '../../../testing/sales';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { SalePage } from './sale-page';
import { SaleAnomaly, SaleDetail, SaleInvoice } from './sale.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const SALE = '665f1c2e9b1d4a0012ab4001';
const CONTACT = '665f1c2e9b1d4a0012ab3a01';
const COMPANY = '665f1c2e9b1d4a0012ab3411';
const PLACE = '665f1c2e9b1d4a0012ab3421';
const URL = `${API}/v1/groups/${GROUP}/sales/${SALE}`;
const CURRENCIES = `${API}/v1/groups/${GROUP}/lookup/currencies`;

function detail(over: Partial<SaleDetail> = {}): SaleDetail {
  return aSaleDetail(over);
}

interface Options {
  permissions?: string[];
  rooms?: boolean;
  noApi?: boolean;
  namesFail?: boolean;
}

/** The text of an element, its text nodes apart by a space. */
function flat(element: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const part = node.textContent?.replace(/\s+/g, ' ').trim();
    if (part) {
      parts.push(part);
    }
  }
  return parts.join(' ');
}

async function render(options: Options = {}) {
  emulateNativeDialog();
  const reference = {
    companyNames: vi.fn(async () => ({ [COMPANY]: 'Acme srl' })),
    placeNames: vi.fn(async () => (options.namesFail ? Promise.reject(new Error('403')) : { [PLACE]: 'Bar Roma' })),
  };
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(options.noApi ? [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }] : []),
      { provide: ReferenceApi, useValue: reference },
      provideRouter([{ path: 'groups/:groupId/sales/:saleId', component: SalePage }], withComponentInputBinding()),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  signIn({
    role: 'SA',
    permissions: options.permissions ?? ['sales:read', 'contacts:read'],
    groupFeatures: fakeFeatureFlags(false, { rooms: options.rooms ?? false }),
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/sales/${SALE}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  await view();
  const answer = async (sale: SaleDetail = detail(), currency = 'EUR') => {
    backend().expectOne(URL).flush({ data: sale });
    backend().expectOne(CURRENCIES).flush({ data: [{ code: currency }] });
    await view();
  };
  const text = () => flat(root);
  return { harness, root, view, answer, text, reference };
}

afterEach(() => {
  backend().verify();
  TestBed.inject(NonFiscalMode).reset();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SalePage', () => {
  it('shows the loading state, then the sale with its header, facts, products, totals and payments', async () => {
    const { root, answer, text } = await render();
    expect(root.textContent).toContain('COMMON.LOADING');
    await answer();
    expect(root.querySelector('h1')?.textContent).toBe('12-345');
    expect(root.querySelector('fc-status-badge')).toBeNull();
    const facts = [...root.querySelectorAll('dl')[0].querySelectorAll('div')].map(flat);
    expect(facts[0]).toBe('SALES.FACT.TYPE SALES.TYPE.RECEIPT');
    expect(facts[1]).toContain('SALES.FACT.DATE');
    expect(facts.slice(2, 6)).toEqual([
      'SALES.FACT.COMPANY Acme srl',
      'SALES.FACT.PLACE Bar Roma',
      'SALES.FACT.CASH_DESK Cassa 1',
      'SALES.FACT.OPERATOR Mario Verdi',
    ]);
    expect(text()).not.toContain('SALES.FACT.TABLE');
    expect(root.querySelector<HTMLAnchorElement>('dl a')!.getAttribute('href')).toBe(`/groups/${GROUP}/contacts/${CONTACT}`);
    expect(text()).toContain('SALES.FACT.CARD CARD1');
    expect(text()).toMatch(/SALES\.FACT\.RECEIPT 12-345, 20 nov 2026/);
    expect(text()).toContain('SALES.FACT.NOTE Senza cipolla');
    const rows = [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
    );
    expect(rows[0]).toEqual(['C1', 'Caffè', '2', '1,20 €', '', '']);
    expect(rows[1][0]).toBe('');
    expect(rows[1][1]).toBe('+ Extra x2');
    expect(rows[1][2]).toBe('1,5');
    expect(rows[1][3]).toBe('20,00 €');
    expect(rows[1][4]).toBe('');
    expect(rows[1][5]).toMatch(/^10\s*%$/);
    expect(text()).toContain('SALES.TOTALS.TOTAL 30,00 €');
    expect(text()).toContain('SALES.TOTALS.TAXABLE 24,59 €');
    expect(text()).toContain('SALES.TOTALS.TAX 5,41 €');
    expect(text()).not.toContain('SALES.TOTALS.DISCOUNT');
    expect(text()).toContain('SALES.PAYMENT.CASH 30,00 €');
    expect(text()).not.toContain('SALES.PAYMENT.ELECTRONIC');
    expect(text()).not.toContain('SALES.SECTION.REFUNDS');
    expect(text()).not.toContain('SALES.PRODUCT.TRUNCATED');
  });

  it('shows the table for a group with the rooms function', async () => {
    const { answer, text } = await render({ rooms: true });
    await answer();
    expect(text()).toContain('SALES.FACT.TABLE T4');
  });

  it('writes the customer as plain text without the permission to read the contacts', async () => {
    const { answer, root } = await render({ permissions: ['sales:read'] });
    await answer();
    expect(root.querySelector('dl a')).toBeNull();
    expect(root.textContent).toContain('Verdi srl');
  });

  it('shows what a sale of a kind it does not know has: no number, customer, card, receipt, note or date', async () => {
    const { answer, root, text } = await render({ rooms: true });
    await answer(
      detail({
        receiptType: null,
        number: null,
        date: null,
        companyId: null,
        placeId: null,
        cashDesk: null,
        operator: null,
        table: null,
        customer: null,
        fidelityCardCode: null,
        fidelityCardUsed: false,
        fiscalReceiptInfo: null,
        note: null,
        payments: { cash: 0, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 },
        products: [],
        productsCount: 0,
      }),
    );
    expect(root.querySelector('h1')?.textContent).toBe('SALES.NO_NUMBER');
    expect(text()).toContain('SALES.TYPE.UNKNOWN');
    const facts = [...root.querySelectorAll('dl')[0].querySelectorAll('div')].map(flat);
    expect(facts).toEqual(['SALES.FACT.TYPE SALES.TYPE.UNKNOWN']);
    for (const fact of ['DATE', 'COMPANY', 'PLACE', 'CASH_DESK', 'OPERATOR', 'TABLE', 'CUSTOMER']) {
      expect(text()).not.toContain(`SALES.FACT.${fact}`);
    }
    expect(text()).not.toContain('SALES.FACT.CARD');
    expect(text()).not.toContain('SALES.FACT.RECEIPT');
    expect(text()).not.toContain('SALES.FACT.NOTE');
    expect(text()).not.toContain('SALES.SECTION.PAYMENTS');
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('SALES.PRODUCT.EMPTY');
  });

  it('shows the receipt of the sale without its date when it has none, and without numbers when it has none', async () => {
    const { answer, root } = await render();
    await answer(detail({ fiscalReceiptInfo: { date: null, report: null, number: 9, amount: 1 } }));
    const receipt = () => [...root.querySelectorAll('dl')[0].querySelectorAll('div')].map(flat).find((f) => f.startsWith('SALES.FACT.RECEIPT'));
    expect(receipt()).toBe('SALES.FACT.RECEIPT 9');
  });

  it('shows the date of a receipt that has no numbers', async () => {
    const { answer, root } = await render();
    await answer(detail({ fiscalReceiptInfo: { date: '2026-11-20T10:31:00.000Z', report: null, number: null, amount: 1 } }));
    const receipt = [...root.querySelectorAll('dl')[0].querySelectorAll('div')].map(flat).find((f) => f.startsWith('SALES.FACT.RECEIPT'))!;
    expect(receipt).toMatch(/^SALES\.FACT\.RECEIPT 20 nov 2026, 11:31$/);
  });

  it('shows the badges, the discount of the whole sale, every payment and the refunds', async () => {
    const { answer, root, text } = await render();
    await answer(
      detail({
        receiptType: 'invoice',
        nonFiscal: true,
        fiscalState: 'refunded',
        unpaid: 5,
        invoiced: true,
        refunds: [
          { report: 1, number: 2, date: '2026-11-21T09:00:00.000Z', amount: 4, canceled: true },
          { report: null, number: null, date: null, amount: 0, canceled: false },
        ],
        totals: { total: 30, taxable: 24.59, tax: 5.41, discount: { adjustment: 'discount', percentage: 10, value: 3 } },
        payments: { cash: 1, electronic: 2, cheque: 3, tickets: 4, fidelityCredit: 5, unpaid: 6 },
      }),
    );
    const badges = [...root.querySelectorAll('fc-status-badge')].map((b) => b.textContent?.trim());
    expect(badges).toEqual([
      'SALES.BADGE.INVOICE',
      'SALES.BADGE.NON_FISCAL',
      'SALES.BADGE.UNPAID',
      'SALES.BADGE.INVOICED',
      'SALES.BADGE.REFUNDED_NUMBERS {"numbers":"1-2"}',
    ]);
    expect(text()).toContain('SALES.TOTALS.DISCOUNT 3,00 € (10%)');
    for (const payment of ['CASH', 'ELECTRONIC', 'CHEQUE', 'TICKETS', 'FIDELITYCREDIT', 'UNPAID']) {
      expect(text()).toContain(`SALES.PAYMENT.${payment}`);
    }
    const refunds = [...root.querySelectorAll('section[aria-labelledby="sale-refunds"] tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
    );
    expect(refunds[0][0]).toBe('1-2');
    expect(refunds[0][1]).not.toBe('');
    expect(refunds[0][2]).toMatch(/^4,00\s*€$/);
    expect(refunds[0][3]).toBe('SALES.REFUND.CANCELED');
    expect(refunds[1].slice(0, 2)).toEqual(['SALES.NO_NUMBER', '']);
    expect(refunds[1][3]).toBe('');
    expect(refunds[1][2]).toMatch(/^0,00\s*€$/);
  });

  it('shows a surcharge without a percentage, in the currency of the group, and notes the lines that are not shown', async () => {
    const { answer, text } = await render();
    await answer(
      detail({
        productsCount: 600,
        totals: { total: 30, taxable: 24.59, tax: 5.41, discount: { adjustment: 'surcharge', percentage: 0, value: 2 } },
      }),
      'USD',
    );
    expect(text()).toContain('SALES.TOTALS.SURCHARGE 2,00 USD');
    expect(text()).toContain('SALES.PRODUCT.TRUNCATED {"shown":2,"count":600}');
  });

  it('keeps the euro when the group has no currency, and the short ids when the names cannot be read', async () => {
    const { root, view, text } = await render({ namesFail: true });
    backend().expectOne(URL).flush({ data: detail() });
    backend().expectOne(CURRENCIES).flush({ data: [] });
    await view();
    expect(text()).toContain('SALES.TOTALS.TOTAL 30,00 €');
    expect(text()).toContain('SALES.FACT.COMPANY …ab3411');
    expect(root.querySelector('h1')?.textContent).toBe('12-345');
  });

  it('says a card was used, without its code, for whoever cannot read the cards', async () => {
    const { answer, text } = await render();
    await answer(detail({ fidelityCardCode: null, fidelityCardUsed: true }));
    expect(text()).toContain('SALES.FACT.CARD SALES.FACT.CARD_USED');
  });

  it('asks for a non fiscal sale only while the UM mode is on, and reads again when it changes', async () => {
    const { view, text, root } = await render();
    backend().expectOne(URL).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    backend().expectOne(CURRENCIES).flush({ data: [] });
    await view();
    expect(root.querySelector('fc-error-state')).not.toBeNull();
    const mode = TestBed.inject(NonFiscalMode);
    for (let click = 0; click < 7; click++) {
      mode.brandClick(click);
    }
    await view();
    const request = backend().expectOne((r) => r.url === URL);
    expect(request.request.params.get('nonFiscal')).toBe('include');
    request.flush({ data: detail({ nonFiscal: true }) });
    await view();
    expect(text()).toContain('SALES.BADGE.NON_FISCAL');
    mode.brandClick(1_000);
    await view();
    const off = backend().expectOne((r) => r.url === URL);
    expect(off.request.params.has('nonFiscal')).toBe(false);
    off.flush({ data: detail() });
    await view();
  });

  it('keeps the euro when the currency of the group cannot be read', async () => {
    const { view, text } = await render();
    backend().expectOne(URL).flush({ data: detail() });
    backend().expectOne(CURRENCIES).flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(text()).toContain('SALES.TOTALS.TOTAL 30,00 €');
  });

  it('shows the error with the request id, retries, and goes back', async () => {
    const { root, view } = await render();
    backend().expectOne(URL).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x', headers: { 'X-Request-Id': 'req-4' } });
    backend().expectOne(CURRENCIES).flush({ data: [] });
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('SALES.PAGE_LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(state.textContent).toContain('req-4');
    const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => undefined);
    root.querySelector<HTMLButtonElement>('p button')!.click();
    expect(back).toHaveBeenCalledOnce();
    state.querySelector('button')!.click();
    await view();
    backend().expectOne(URL).flush({ data: detail() });
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('goes back from the header', async () => {
    const { root, answer } = await render();
    await answer();
    const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => undefined);
    root.querySelector<HTMLButtonElement>('fc-page-header button')!.click();
    expect(back).toHaveBeenCalledOnce();
  });

  it('shows the generic message for a failure that is not an API error', async () => {
    const { root, view } = await render({ noApi: true });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('shows the quantity returned of each line and the value returned, only when there is one', async () => {
    const { answer, root, text } = await render();
    await answer(
      detail({
        products: [aSaleProduct({ quantity: 3, returned: 1.5 }), aSaleProduct({ index: 1, quantity: 1, returned: 0 })],
        returnedValue: 4,
      }),
    );
    const rows = [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
    );
    expect(rows[0][4]).toBe('1,5');
    expect(rows[1][4]).toBe('');
    expect(text()).toContain('SALES.TOTALS.RETURNED 4,00 €');
  });

  it('does not show the value returned when nothing was returned', async () => {
    const { answer, text } = await render();
    await answer();
    expect(text()).not.toContain('SALES.TOTALS.RETURNED');
  });

  it('shows what the server knows of the sale', async () => {
    const { answer, root } = await render();
    await answer(
      detail({
        serverCheck: { checkedAt: null, status: 'ok', totals: [], lines: [], linesTruncated: false },
        invoice: {
          documentId: 'd1',
          number: 3,
          prefixSuffix: null,
          year: null,
          sendStatus: 'sent',
          notQueued: false,
          documentFound: true,
        },
      }),
    );
    expect(root.querySelector('#sale-check')).not.toBeNull();
    expect(root.querySelector('#sale-invoice')).not.toBeNull();
  });

  describe('actions', () => {
    const buttonOf = (root: HTMLElement, text: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;

    it('shows no action without the permissions', async () => {
      const { answer, root } = await render();
      await answer();
      expect(root.querySelector('section .actions')).toBeNull();
    });

    it('cancels the sale, tells the user and reads the sale again', async () => {
      const { answer, root, view } = await render({ permissions: ['sales:read', 'sales:write'] });
      await answer(detail({ fidelityCardUsed: false }));
      buttonOf(root, 'SALES.ACTION.CANCEL').click();
      await view();
      buttonOf(root, 'SALES.ACTION.CANCEL_CONFIRM').click();
      await view();
      const request = backend().expectOne(`${URL}/cancellation`);
      expect(request.request.headers.get('If-Match')).toBe('"v1"');
      request.flush({ data: {} });
      await view();
      expect(TestBed.inject(ToastService).toasts().map((t) => t.message)).toEqual(['SALES.ACTION.DONE_CANCEL']);
      backend().expectOne(URL).flush({ data: detail({ canceled: true, version: 'v2', fidelityCardUsed: false }) });
      await view();
      expect(buttonOf(root, 'SALES.ACTION.AMEND').getAttribute('aria-disabled')).toBe('true');
      expect(root.textContent).toContain('SALES.ACTION.CANCELED_NOTE');
    });

    it('reads the sale again after an outcome that is not known, and lets the user try again once it is read', async () => {
      const { answer, root, view } = await render({ permissions: ['sales:read', 'sales:write'] });
      await answer(detail({ fidelityCardUsed: false }));
      buttonOf(root, 'SALES.ACTION.CANCEL').click();
      await view();
      buttonOf(root, 'SALES.ACTION.CANCEL_CONFIRM').click();
      await view();
      backend().expectOne(`${URL}/cancellation`).error(new ProgressEvent('error'));
      await view();
      expect(root.textContent).toContain('SALES.ACTION.UNCERTAIN');
      expect(buttonOf(root, 'SALES.ACTION.CANCEL_CONFIRM').disabled).toBe(true);
      const reread = backend().expectOne(URL);
      await view();
      expect(buttonOf(root, 'SALES.ACTION.CANCEL_CONFIRM').disabled).toBe(true);
      reread.flush({ data: detail({ fidelityCardUsed: false }) });
      await view();
      expect(buttonOf(root, 'SALES.ACTION.CANCEL_CONFIRM').disabled).toBe(false);
    });

    /** Opens the page on a quote, turns the UM mode on and confirms its deletion (the router is spied). */
    async function deleteQuote(permissions: string[], sale: Partial<SaleDetail> = {}) {
      const page = await render({ permissions });
      const { answer, root, view } = page;
      await answer(detail({ nonFiscal: true, fidelityCardUsed: false, ...sale }));
      expect(buttonOf(root, 'SALES.ACTION.DELETE')).toBeUndefined();
      const mode = TestBed.inject(NonFiscalMode);
      for (let click = 0; click < 7; click++) {
        mode.brandClick(click);
      }
      await view();
      backend()
        .expectOne((r) => r.url === URL)
        .flush({ data: detail({ nonFiscal: true, fidelityCardUsed: false, ...sale }) });
      await view();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      buttonOf(root, 'SALES.ACTION.DELETE').click();
      await view();
      buttonOf(root, 'SALES.ACTION.DELETE_CONFIRM').click();
      await view();
      const request = backend().expectOne((r) => r.url === URL && r.method === 'DELETE');
      expect(request.request.params.get('nonFiscal')).toBe('include');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(TestBed.inject(ToastService).toasts().map((t) => t.message)).toEqual(['SALES.ACTION.DONE_DELETE']);
      return navigate;
    }

    it('deletes a quote while the UM mode is on, tells the user and goes to the purchases of its customer', async () => {
      const navigate = await deleteQuote(['sales:read', 'sales:delete', 'contacts:read', 'groups:read']);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(['/groups', GROUP, 'contacts', CONTACT]);
    });

    it('goes to the settings of the group after the deletion of a quote whose customer the user cannot read', async () => {
      const navigate = await deleteQuote(['sales:read', 'sales:delete', 'groups:read']);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(['/groups', GROUP, 'settings']);
    });

    it('goes to the settings of the group after the deletion of a quote without a customer', async () => {
      const navigate = await deleteQuote(['sales:read', 'sales:delete', 'contacts:read', 'groups:read'], { customer: null });
      expect(navigate).toHaveBeenCalledExactlyOnceWith(['/groups', GROUP, 'settings']);
    });

    it('goes home after the deletion of a quote when the user can read neither the customer nor the group', async () => {
      const navigate = await deleteQuote(['sales:read', 'sales:delete']);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(['/']);
    });
  });

  describe('header badges that lead to the sections', () => {
    const badgeLinks = (root: HTMLElement) => [...root.querySelectorAll<HTMLAnchorElement>('a.badge-link')];
    const anomaly = (code: string): SaleAnomaly => ({
      at: null, operation: null, source: null, code, productId: null, collectionId: null, type: null, ids: [], fields: [],
    });
    const invoice = (over: Partial<SaleInvoice> = {}): SaleInvoice => ({
      documentId: 'd1', number: 1, prefixSuffix: null, year: null, sendStatus: 'sent', notQueued: false, documentFound: true, ...over,
    });

    it('shows none for a sale that needs no look, and the sections of the anomalies stay with the line of none', async () => {
      const { answer, root, text } = await render();
      await answer();
      expect(badgeLinks(root)).toEqual([]);
      expect(text()).toContain('SALES.ANOMALIES.NONE');
    });

    it('shows one badge for one anomaly and a count for more, and takes the focus to the section', async () => {
      const { answer, root } = await render();
      await answer(detail({ anomalies: [anomaly('cycle')] }));
      const [link] = badgeLinks(root);
      expect(link.textContent?.trim()).toBe('SALES.BADGE.ANOMALIES_ONE');
      expect(link.getAttribute('href')).toBe('#sale-anomalies');
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(root.querySelector('h2#sale-anomalies'));
    });

    it('counts the anomalies when there are several', async () => {
      const { answer, root } = await render();
      await answer(detail({ anomalies: [anomaly('cycle'), anomaly('tooDeep'), anomaly('priceMissing')] }));
      expect(badgeLinks(root).map((l) => l.textContent?.trim())).toEqual(['SALES.BADGE.ANOMALIES {"count":3}']);
    });

    it('shows a badge for the differences of the check, and takes the focus to the check', async () => {
      const { answer, root } = await render();
      await answer(
        detail({ serverCheck: { checkedAt: null, status: 'differences', totals: [], lines: [], linesTruncated: false } }),
      );
      const [link] = badgeLinks(root);
      expect(link.textContent?.trim()).toBe('SALES.BADGE.CHECK_DIFFERENCES');
      link.click();
      expect(document.activeElement).toBe(root.querySelector('h2#sale-check'));
    });

    it('shows no badge for a check without differences or without a state', async () => {
      const { answer, root } = await render();
      await answer(detail({ serverCheck: { checkedAt: null, status: null, totals: [], lines: [], linesTruncated: false } }));
      expect(badgeLinks(root)).toEqual([]);
    });

    it('shows a badge for an invoice that was not sent, and takes the focus to the invoice', async () => {
      const { answer, root } = await render();
      await answer(detail({ invoice: invoice({ notQueued: true }) }));
      const [link] = badgeLinks(root);
      expect(link.textContent?.trim()).toBe('SALES.BADGE.NOT_SENT');
      link.click();
      expect(document.activeElement).toBe(root.querySelector('h2#sale-invoice'));
    });

    it('shows no badge for an invoice that went on', async () => {
      const { answer, root } = await render();
      await answer(detail({ invoice: invoice() }));
      expect(badgeLinks(root)).toEqual([]);
    });

    it('keeps the badges in the order of the sections', async () => {
      const { answer, root } = await render();
      await answer(
        detail({
          anomalies: [anomaly('cycle')],
          serverCheck: { checkedAt: null, status: 'differences', totals: [], lines: [], linesTruncated: false },
          invoice: invoice({ sendStatus: 'notQueued' }),
        }),
      );
      expect(badgeLinks(root).map((l) => l.getAttribute('href'))).toEqual(['#sale-anomalies', '#sale-check', '#sale-invoice']);
    });
  });

  describe('the sale read again', () => {
    const reread = async (page: Awaited<ReturnType<typeof render>>) => {
      // The UM mode changes the request: the page reads the sale again while the sale stays on it.
      const mode = TestBed.inject(NonFiscalMode);
      for (let click = 0; click < 7; click++) {
        mode.brandClick(click);
      }
      await page.view();
      return backend().expectOne((r) => r.url === URL);
    };

    it('marks the page busy while the sale is read again, and not otherwise', async () => {
      const page = await render();
      await page.answer();
      const view = () => page.root.querySelector('fc-sale-view')!;
      expect(view().hasAttribute('aria-busy')).toBe(false);
      const request = await reread(page);
      expect(view().getAttribute('aria-busy')).toBe('true');
      request.flush({ data: detail() });
      await page.view();
      expect(view().hasAttribute('aria-busy')).toBe(false);
    });

    it('keeps the sale and warns when a new read fails, then reads again on retry', async () => {
      const page = await render();
      await page.answer();
      const failing = await reread(page);
      // While it reads, the sale stays and there is no warning yet.
      expect(page.root.querySelector('h1')?.textContent).toBe('12-345');
      expect(page.root.querySelector('.warning')).toBeNull();
      failing.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await page.view();
      expect(page.root.querySelector('fc-error-state')).toBeNull();
      expect(page.root.querySelector('h1')?.textContent).toBe('12-345');
      const warning = page.root.querySelector('.warning')!;
      expect(warning.getAttribute('role')).toBe('alert');
      expect(flat(warning)).toContain('SALES.REREAD_FAILED');
      const retry = [...warning.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'COMMON.RETRY')!;
      retry.click();
      await page.view();
      backend().expectOne((r) => r.url === URL).flush({ data: detail({ note: 'Nuova' }) });
      await page.view();
      expect(page.root.querySelector('.warning')).toBeNull();
      expect(page.text()).toContain('SALES.FACT.NOTE Nuova');
    });

    it('does not keep another sale: opening a different one shows the loading state, and an error its error page', async () => {
      const page = await render();
      await page.answer();
      const other = '665f1c2e9b1d4a0012ab4002';
      await page.harness.navigateByUrl(`/groups/${GROUP}/sales/${other}`);
      await page.view();
      expect(page.root.querySelector('h1')).toBeNull();
      expect(page.text()).toContain('COMMON.LOADING');
      const request = backend().expectOne(`${API}/v1/groups/${GROUP}/sales/${other}`);
      request.flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await page.view();
      expect(page.root.querySelector('fc-error-state')).not.toBeNull();
      expect(page.root.querySelector('fc-sale-view')).toBeNull();
    });
  });
});
