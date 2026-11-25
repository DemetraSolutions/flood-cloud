import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TestRequest } from '@angular/common/http/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { SaleRow, SaleSummary } from '../sales/sale.types';
import { ContactPurchases } from './contact-purchases';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const CONTACT = '665f1c2e9b1d4a0012ab3a01';
const COMPANY = '665f1c2e9b1d4a0012ab3411';
const PLACE = '665f1c2e9b1d4a0012ab3421';
const SALES = `${API}/v1/groups/${GROUP}/sales`;
const SUMMARY = `${SALES}/summary`;

function sale(id: string, over: Partial<SaleRow> = {}): SaleRow {
  return {
    id,
    date: '2026-11-20T10:30:00.000Z',
    receiptType: 'receipt',
    nonFiscal: false,
    number: { report: 12, number: 345 },
    fiscalState: null,
    refunds: [],
    unpaid: 0,
    invoiced: false,
    total: 12.5,
    companyId: COMPANY,
    placeId: PLACE,
    cashDesk: 'Cassa 1',
    operator: { id: 'u1', name: 'Mario Verdi' },
    table: 'T4',
    customer: { id: CONTACT, displayName: 'Verdi srl' },
    ...over,
  };
}

const page = (data: SaleRow[], next: string | null = null) => ({ data, page: { limit: 25, next } });
const SUMMARY_BODY = (over: Partial<SaleSummary> = {}) => ({
  data: { total: 1234.5, count: 3, average: 411.5, refunded: 0, ...over },
});

@Component({
  imports: [ContactPurchases],
  template: `<fc-contact-purchases [groupId]="group" [contactId]="contact" [currency]="currency()" />`,
})
class Host {
  readonly group = GROUP;
  readonly contact = CONTACT;
  readonly currency = signal('EUR');
}

interface Options {
  rooms?: boolean;
  noApi?: boolean;
  names?: Record<string, string>;
  namesFail?: boolean;
  places?: { id: string; name: string }[];
}

async function render(options: Options = {}) {
  const reference = {
    companyNames: vi.fn(async () => (options.namesFail ? Promise.reject(new Error('403')) : { [COMPANY]: 'Acme srl' })),
    placeNames: vi.fn(async () => ({ [PLACE]: 'Bar Roma' })),
  };
  const store = {
    page: vi.fn(async () => ({
      data: options.places ?? [{ id: PLACE, name: 'Bar Roma' }],
      page: { limit: 100, next: null },
    })),
  };
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(options.noApi ? [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }] : []),
      { provide: ReferenceApi, useValue: reference },
      { provide: ReferenceStore, useValue: store },
      provideRouter([]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    role: 'SA',
    permissions: ['contacts:read', 'sales:read'],
    groupFeatures: fakeFeatureFlags(false, { rooms: options.rooms ?? false }),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fixture = TestBed.createComponent(Host);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  /** The reads of a URL that are still wanted (a read replaced by a newer one was cancelled). */
  const live = (url: string) => backend().match((r) => r.url === url).filter((r) => !r.cancelled);
  const only = (url: string) => {
    const requests = live(url);
    expect(requests).toHaveLength(1);
    return requests[0];
  };
  const list = () => only(SALES);
  const summary = () => only(SUMMARY);
  const params = (request: TestRequest) =>
    Object.fromEntries(request.request.params.keys().map((key) => [key, request.request.params.get(key)]));
  /** Answers the two reads the tab makes; returns the parameters they carried. */
  const answer = async (rows: SaleRow[], next: string | null = null, totals: Partial<SaleSummary> = {}) => {
    const [l, s] = [list(), summary()];
    const sent = { list: params(l), summary: params(s) };
    l.flush(page(rows, next));
    s.flush(SUMMARY_BODY(totals));
    await view();
    return sent;
  };
  /** Answers the read of a page (the totals are not read again). */
  const answerPage = async (rows: SaleRow[], next: string | null = null) => {
    const l = list();
    const sent = params(l);
    l.flush(page(rows, next));
    await view();
    return sent;
  };
  const cells = (index: number) =>
    [...root.querySelectorAll('tbody tr')[index]!.querySelectorAll('th, td')].map((cell) =>
      cell.textContent?.replace(/\s+/g, ' ').trim(),
    );
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const dates = () => [...root.querySelectorAll<HTMLInputElement>('input[type="date"]')];
  return { fixture, root, view, list, summary, live, answer, answerPage, cells, type, dates, reference, store };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('ContactPurchases', () => {
  it('reads the sales and the totals of the contact, with no period', async () => {
    const { answer } = await render();
    expect(await answer([])).toEqual({
      list: { contactId: CONTACT, limit: '25' },
      summary: { contactId: CONTACT },
    });
  });

  it('shows the tiles in the currency of the group, without the refunds when there are none', async () => {
    const { answer, root, fixture, view } = await render();
    await answer([sale('s1')]);
    const tiles = () =>
      [...root.querySelectorAll('.tiles li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(tiles()).toHaveLength(3);
    expect(tiles()[0]).toMatch(/^SALES\.TILE\.SOLD1234,50\s*€$/);
    expect(tiles()[1]).toBe('SALES.TILE.COUNT3');
    expect(tiles()[2]).toMatch(/^SALES\.TILE\.AVERAGE411,50\s*€$/);
    fixture.componentInstance.currency.set('USD');
    await view();
    expect(tiles()[0]).toContain('USD');
  });

  it('adds the refunds tile when something was refunded', async () => {
    const { answer, root } = await render();
    await answer([sale('s1')], null, { refunded: 10 });
    const tiles = [...root.querySelectorAll('.tiles li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(tiles).toHaveLength(4);
    expect(tiles[3]).toMatch(/^SALES\.TILE\.REFUNDED10,00\s*€$/);
  });

  it('lists the sales with the number and its badges, date, time, amount, company, store, cash desk and operator', async () => {
    const { answer, root, cells } = await render();
    await answer([
      sale('s1'),
      sale('s2', {
        receiptType: 'invoice',
        number: null,
        fiscalState: 'refunded',
        refunds: [{ report: 1, number: 2 }],
        unpaid: 3,
        invoiced: true,
        nonFiscal: true,
        date: null,
        companyId: null,
        placeId: 'ffffffffffffffffffffffff',
        cashDesk: null,
        operator: null,
      }),
    ]);
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
      'SALES.COLUMN.NUMBER',
      'SALES.COLUMN.DATE',
      'SALES.COLUMN.TIME',
      'SALES.COLUMN.TOTAL',
      'SALES.COLUMN.COMPANY',
      'SALES.COLUMN.PLACE',
      'SALES.COLUMN.CASH_DESK',
      'SALES.COLUMN.OPERATOR',
    ]);
    const first = cells(0);
    expect(first[0]).toBe('12-345');
    expect(first[1]).not.toBe('');
    expect(first[2]).not.toBe('');
    expect(first[3]).toMatch(/^12,50\s*€$/);
    expect(first.slice(4)).toEqual(['Acme srl', 'Bar Roma', 'Cassa 1', 'Mario Verdi']);
    expect(root.querySelector<HTMLAnchorElement>('tbody tr a')!.getAttribute('href')).toBe(`/groups/${GROUP}/sales/s1`);
    const second = cells(1);
    expect(second[0]).toContain('SALES.NO_NUMBER');
    for (const badge of ['INVOICE', 'NON_FISCAL', 'UNPAID', 'INVOICED']) {
      expect(second[0]).toContain(`SALES.BADGE.${badge}`);
    }
    expect(second[0]).toContain('SALES.BADGE.REFUNDED_NUMBERS {"numbers":"1-2"}');
    expect(second[1]).toBe('');
    expect(second[4]).toBe('');
    expect(second[5]).toBe('…ffffff');
    expect(second.slice(6)).toEqual(['', '']);
  });

  it('shows the table column only for a group with the rooms function', async () => {
    const without = await render();
    await without.answer([sale('s1')]);
    expect(without.root.textContent).not.toContain('SALES.COLUMN.TABLE');
    TestBed.resetTestingModule();
    document.body.replaceChildren();
    const rooms = await render({ rooms: true });
    await rooms.answer([sale('s1'), sale('s2', { table: null })]);
    expect(rooms.root.textContent).toContain('SALES.COLUMN.TABLE');
    expect(rooms.cells(0)[8]).toBe('T4');
    expect(rooms.cells(1)[8]).toBe('');
  });

  it('shows the short ids when the names cannot be read', async () => {
    const { answer, cells } = await render({ namesFail: true });
    await answer([sale('s1')]);
    expect(cells(0)[4]).toBe('…ab3411');
    expect(cells(0)[5]).toBe('…ab3421');
  });

  it('offers the stores of the group in the filter', async () => {
    const { root, answer } = await render({ places: [{ id: PLACE, name: 'Bar Roma' }, { id: 'p2', name: 'Bar Milano' }] });
    await answer([]);
    expect([...root.querySelectorAll('select option')].map((o) => o.textContent?.trim())).toEqual(
      expect.arrayContaining(['SALES.FILTER.ALL_PLACES', 'Bar Roma', 'Bar Milano']),
    );
  });

  it('filters by period and store, sending both ends of the period, and starts again from the first page', async () => {
    const { answer, answerPage, view, root, type, dates } = await render();
    await answer([sale('s1')], 'c1');
    root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')[1]!.click();
    await view();
    expect((await answerPage([sale('s2')]))['cursor']).toBe('c1');
    await type(dates()[0], '2026-11-01');
    await type(dates()[1], '2026-11-30');
    const select = root.querySelector<HTMLSelectElement>('select')!;
    select.value = PLACE;
    select.dispatchEvent(new Event('change'));
    await view();
    const sent = await answer([]);
    expect(sent.list['cursor']).toBeUndefined();
    expect(sent.list['placeId']).toBe(PLACE);
    expect(sent.list['from']).toBe(new Date(2026, 10, 1).toISOString());
    expect(sent.list['to']).toBe(new Date(2026, 11, 1).toISOString());
    expect(sent.summary).toEqual({ contactId: CONTACT, placeId: PLACE, from: sent.list['from'], to: sent.list['to'] });
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('SALES.EMPTY');
  });

  it('asks for nothing and says so when the period ends before it starts', async () => {
    const { answer, live, root, type, dates } = await render();
    await answer([sale('s1')]);
    await type(dates()[1], '2026-11-01');
    await answer([sale('s1')]);
    await type(dates()[0], '2026-11-30');
    expect(live(SALES)).toHaveLength(0);
    expect(live(SUMMARY)).toHaveLength(0);
    expect(root.querySelector('fc-data-table')).toBeNull();
    expect(root.textContent).toContain('SALES.FILTER.RANGE_ERROR');
  });

  it('asks for the non fiscal sales only while the UM mode is on, and reads again from the first page when it changes', async () => {
    const { answer, answerPage, view, root } = await render();
    await answer([sale('s1')], 'c1');
    root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')[1]!.click();
    await view();
    await answerPage([sale('s2')]);
    const mode = TestBed.inject(NonFiscalMode);
    for (let click = 0; click < 7; click++) {
      mode.brandClick(click);
    }
    await view();
    const on = await answer([sale('p1', { nonFiscal: true })]);
    expect(on.list['nonFiscal']).toBe('include');
    expect(on.list['cursor']).toBeUndefined();
    expect(on.summary['nonFiscal']).toBe('include');
    expect(root.textContent).toContain('SALES.BADGE.NON_FISCAL');
    mode.brandClick(1_000);
    await view();
    const off = await answer([]);
    expect(off.list['nonFiscal']).toBeUndefined();
    expect(off.summary['nonFiscal']).toBeUndefined();
  });

  it('walks the pages back and forth and changes the page size', async () => {
    const { answer, answerPage, view, root } = await render();
    await answer([sale('s1')], 'c1');
    const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')];
    expect(buttons()[0].disabled).toBe(true);
    buttons()[1].click();
    await view();
    expect((await answerPage([sale('s2')], 'c2'))['cursor']).toBe('c1');
    buttons()[0].click();
    await view();
    expect((await answerPage([sale('s1')], 'c1'))['cursor']).toBeUndefined();
    const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
    size.value = '50';
    size.dispatchEvent(new Event('change'));
    await view();
    const sent = await answerPage([]);
    expect(sent['limit']).toBe('50');
    expect(sent['cursor']).toBeUndefined();
  });

  it('says the read is too slow when the server gives up (503) and retries both reads', async () => {
    const { list, summary, view, root, answer } = await render();
    list().flush(errorBody('SERVICE_UNAVAILABLE'), { status: 503, statusText: 'x', headers: { 'X-Request-Id': 'req-1' } });
    summary().flush(SUMMARY_BODY());
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('SALES.LOAD_ERROR');
    expect(state.textContent).toContain('SALES.TOO_SLOW');
    expect(state.textContent).toContain('req-1');
    state.querySelector('button')!.click();
    await view();
    await answer([sale('s1')]);
    expect(root.querySelector('fc-error-state')).toBeNull();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('shows the message of any other failure, also when only the totals failed', async () => {
    const { list, summary, view, root } = await render();
    list().flush(page([sale('s1')]));
    summary().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
  });

  it('shows the generic message for a failure that is not an API error', async () => {
    const { root, view } = await render({ noApi: true });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('shows the loading state first', async () => {
    const { root, answer } = await render();
    expect(root.querySelector('fc-skeleton')).not.toBeNull();
    await answer([]);
  });
});
