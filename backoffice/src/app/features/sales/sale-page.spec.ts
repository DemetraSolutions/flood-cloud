import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { SalePage } from './sale-page';
import { SaleDetail } from './sale.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const SALE = '665f1c2e9b1d4a0012ab4001';
const CONTACT = '665f1c2e9b1d4a0012ab3a01';
const COMPANY = '665f1c2e9b1d4a0012ab3411';
const PLACE = '665f1c2e9b1d4a0012ab3421';
const URL = `${API}/v1/groups/${GROUP}/sales/${SALE}`;
const CURRENCIES = `${API}/v1/groups/${GROUP}/lookup/currencies`;

function detail(over: Partial<SaleDetail> = {}): SaleDetail {
  return {
    id: SALE,
    date: '2026-11-20T10:30:00.000Z',
    receiptType: 'receipt',
    nonFiscal: false,
    number: { report: 12, number: 345 },
    fiscalState: null,
    refunds: [],
    unpaid: 0,
    invoiced: false,
    total: 30,
    companyId: COMPANY,
    placeId: PLACE,
    cashDesk: 'Cassa 1',
    operator: { id: 'u1', name: 'Mario Verdi' },
    table: 'T4',
    customer: { id: CONTACT, displayName: 'Verdi srl' },
    products: [
      { productId: 'p1', code: 'C1', name: 'Caffè', quantity: 2, unitPrice: 1.2, discount: 0, variants: null },
      { productId: null, code: null, name: null, quantity: 1.5, unitPrice: 20, discount: 10, variants: '+ Extra x2' },
    ],
    productsCount: 2,
    totals: { total: 30, taxable: 24.59, tax: 5.41, discount: { adjustment: null, percentage: 0, value: 0 } },
    payments: { cash: 30, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 },
    fiscalReceiptInfo: { date: '2026-11-20T10:31:00.000Z', report: 12, number: 345, amount: 30 },
    fidelityCardCode: 'CARD1',
    fidelityCardUsed: true,
    note: 'Senza cipolla',
    ...over,
  };
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
    expect(text()).toMatch(/SALES\.FACT\.RECEIPT 12-345 · /);
    expect(text()).toContain('SALES.FACT.NOTE Senza cipolla');
    const rows = [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
    );
    expect(rows[0]).toEqual(['C1', 'Caffè', '2', '1,20 €', '']);
    expect(rows[1][0]).toBe('');
    expect(rows[1][1]).toBe('+ Extra x2');
    expect(rows[1][2]).toBe('1,5');
    expect(rows[1][3]).toBe('20,00 €');
    expect(rows[1][4]).toMatch(/^10\s*%$/);
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
    expect(text()).not.toContain('SALES.FACT.CARD');
    expect(text()).not.toContain('SALES.FACT.RECEIPT');
    expect(text()).not.toContain('SALES.FACT.NOTE');
    expect(text()).not.toContain('SALES.SECTION.PAYMENTS');
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('SALES.PRODUCT.EMPTY');
  });

  it('shows the receipt of the sale without its date when it has none', async () => {
    const { answer, text } = await render();
    await answer(detail({ fiscalReceiptInfo: { date: null, report: null, number: 9, amount: 1 } }));
    expect(text()).toContain('SALES.FACT.RECEIPT 9');
    expect(text()).not.toContain('·');
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
          { report: 1, number: 2, date: '2026-11-21T09:00:00.000Z', amount: 4 },
          { report: null, number: null, date: null, amount: 0 },
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
    expect(refunds[1].slice(0, 2)).toEqual(['SALES.NO_NUMBER', '']);
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
});
