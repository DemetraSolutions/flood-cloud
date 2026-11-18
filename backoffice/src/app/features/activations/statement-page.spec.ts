import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { currentMonth, StatementLine, StatementResponse } from './activations.types';
import { StatementPage } from './statement-page';

const DEALER = '665f1c2e9b1d4a0012ab34d1';
const SUMMARY = `${API}/v1/activations`;
const STATEMENT = `${API}/v1/activations/statements/${DEALER}`;
const CSV = `${STATEMENT}.csv`;
const NBSP = /\s/g;

function line(overrides: Partial<StatementLine> = {}): StatementLine {
  return {
    groupId: 'g1',
    groupName: 'Gruppo Alfa',
    companyId: 'c1',
    companyName: 'Azienda Uno',
    placeId: 'p1',
    placeName: 'Bar Centrale',
    activatedAt: '2026-05-10T10:00:00.000Z',
    plan: 'basic',
    items: [
      { key: 'plan:basic', quantity: 1, unitCents: 2000, amountCents: 2000 },
      { key: 'extraDesk', quantity: 2, unitCents: 500, amountCents: 1000 },
      { key: 'kiosk', quantity: 1, unitCents: 1500, amountCents: 1500 },
    ],
    monthlyCents: 4500,
    months: 7,
    amountCents: 31500,
    flags: ['unpricedPlan', 'expired'],
    projection12Cents: 54000,
    devices: { desks: 3, kiosks: 1, handhelds: 2 },
    ...overrides,
  };
}

function statement(
  data: StatementLine[],
  next: string | null = null,
  overrides: Partial<StatementResponse> = {},
): StatementResponse {
  return {
    data,
    page: { limit: 50, next },
    totals: { places: 3, amountCents: 63000, projection12Cents: 108000 },
    dealer: { id: DEALER, name: 'Dealer Nord' },
    status: 'open',
    renewalBase: { year: 2026, frozen: true },
    prices: { plans: { basic: 2000, advanced: 3000 }, services: { kiosk: 1500, extraDesk: 500 } },
    ...overrides,
  };
}

async function render(url = `/tools/activations/${DEALER}?month=2026-06`, withApi = true) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(withApi ? [] : [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]),
      provideRouter(
        [
          { path: 'tools/activations/:dealerId', component: StatementPage },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', groupId: null, group: null, permissions: ['activations:read'] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const statementRequest = () =>
    backend().expectOne(
      (r) => r.url.startsWith(`${API}/v1/activations/statements/`) && !r.url.endsWith('.csv'),
    );
  const flush = async (body: StatementResponse = statement([line()])) => {
    statementRequest().flush(body);
    await view();
  };
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.trim().replace(NBSP, ' ');
  const button = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    ) as HTMLButtonElement;
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  return { root, view, flush, statementRequest, text, button, search };
}

describe('StatementPage', () => {
  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  describe('reading', () => {
    it('asks for the dealer, the month, the section and the first page', async () => {
      const { statementRequest, view } = await render();
      const req = statementRequest();
      expect(req.request.params.get('month')).toBe('2026-06');
      expect(req.request.params.get('section')).toBe('activations');
      expect(req.request.params.get('limit')).toBe('50');
      expect(req.request.params.has('cursor')).toBe(false);
      req.flush(statement([]));
      await view();
    });

    it('starts from the current month and the activations when the URL has wrong values', async () => {
      const { statementRequest, view } = await render(
        `/tools/activations/${DEALER}?month=bad&section=bad&limit=7`,
      );
      const req = statementRequest();
      expect(req.request.params.get('month')).toBe(currentMonth());
      expect(req.request.params.get('section')).toBe('activations');
      expect(req.request.params.get('limit')).toBe('50');
      req.flush(statement([]));
      await view();
    });

    it('shows the dealer, the state of the month, what the tab contains and the totals', async () => {
      const { text, flush, root } = await render();
      expect(root.textContent).toContain('COMMON.LOADING');
      await flush();
      expect(text('h1')).toBe('ACTIVATIONS.STATEMENT.TITLE {"dealer":"Dealer Nord"}');
      expect(text('.summary')).toContain(
        'ACTIVATIONS.STATEMENT.INVOICES_OF {"month":"giugno 2026"}',
      );
      expect(text('.summary')).toContain('ACTIVATIONS.STATUS.OPEN');
      expect(text('.intro')).toBe(
        'ACTIVATIONS.STATEMENT.INTRO.ACTIVATIONS {"activity":"maggio 2026"}',
      );
      expect(text('.totals')).toContain('3');
      expect(text('.totals')).toContain('630,00 €');
      expect(text('.totals')).toContain('1080,00 €');
      expect(root.querySelector('a[href^="/tools/activations?month=2026-06"]')).not.toBeNull();
    });

    it('shows a closed month', async () => {
      const { text, flush } = await render();
      await flush(statement([line()], null, { status: 'closed' }));
      expect(text('.summary')).toContain('ACTIVATIONS.STATUS.CLOSED');
    });

    it('names the dealer generically while the statement is not read', async () => {
      const { text, flush } = await render();
      expect(text('h1')).toContain('"dealer":"ACTIVATIONS.STATEMENT.DEALER"');
      expect(text('.summary')).not.toContain('ACTIVATIONS.STATUS');
      await flush();
    });

    it('lists the places grouped by group and company, with items, amounts and notes', async () => {
      const { root, flush, text } = await render();
      await flush(
        statement([
          line(),
          line({
            placeId: 'p2',
            placeName: 'Bar Due',
            plan: null,
            activatedAt: 'garbage',
            items: [{ key: 'plan:', quantity: 1, unitCents: null, amountCents: 0 }],
            devices: undefined,
            monthlyCents: 0,
            amountCents: 0,
            projection12Cents: 0,
            flags: ['activationDateFromId', 'somethingNew'],
          }),
          line({
            placeId: 'p3',
            companyId: 'c2',
            companyName: 'Azienda Due',
            placeName: 'Bar Tre',
            flags: [],
          }),
          line({
            placeId: 'p4',
            groupId: 'g2',
            groupName: 'Gruppo Beta',
            companyId: 'c3',
            companyName: 'Azienda Tre',
            placeName: 'Bar Quattro',
          }),
        ]),
      );
      expect([...root.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toEqual([
        'Gruppo Alfa',
        'Gruppo Beta',
      ]);
      expect(
        [...root.querySelectorAll('.scroll > table > caption')].map((c) => c.textContent?.trim()),
      ).toEqual(['Azienda Uno', 'Azienda Due', 'Azienda Tre']);
      const places = [...root.querySelectorAll('.scroll > table > tbody > tr')];
      const first = places[0];
      const cells = [...first.querySelectorAll(':scope > th, :scope > td')].map((c) =>
        c.textContent?.trim().replace(NBSP, ' '),
      );
      expect(cells[0]).toBe('Bar Centrale');
      expect(cells[1]).toContain('2026');
      expect(cells[2]).toBe('basic');
      const feeRows = (tr: Element) =>
        [...tr.querySelectorAll('fc-fee-items tbody tr')].map((row) =>
          [...row.querySelectorAll('th, td')].map((c) => c.textContent?.trim().replace(NBSP, ' ')),
        );
      expect(feeRows(first)).toEqual([
        ['ACTIVATIONS.ITEM.PLAN {"plan":"basic"}', '', '20,00 €', '20,00 €'],
        ['PRICE_SERVICE.EXTRA_DESK', '×2', '5,00 €', '10,00 €'],
        ['PRICE_SERVICE.KIOSK', '', '15,00 €', '15,00 €'],
        ['ACTIVATIONS.ITEM.DEVICES {"desks":3,"kiosks":1,"handhelds":2}'],
      ]);
      expect(first.querySelector('fc-fee-items tfoot')?.textContent?.replace(NBSP, ' ')).toContain(
        '45,00 €',
      );
      expect(cells.slice(4, 7)).toEqual(['7', '315,00 €', '540,00 €']);
      expect(
        [...first.querySelectorAll('fc-status-badge')].map((b) => [
          b.textContent?.trim(),
          b.getAttribute('data-tone'),
        ]),
      ).toEqual([
        ['ACTIVATIONS.FLAG.UNPRICED_PLAN', 'warning'],
        ['ACTIVATIONS.FLAG.EXPIRED', 'neutral'],
      ]);
      const second = places[1];
      expect(feeRows(second)).toEqual([
        ['ACTIVATIONS.ITEM.NO_PLAN', '', 'ACTIVATIONS.ITEM.UNPRICED', '0,00 €'],
      ]);
      const dashes = [...second.querySelectorAll(':scope > th, :scope > td')].map((c) =>
        c.textContent?.trim(),
      );
      expect(dashes[1]).toBe('—');
      expect(dashes[2]).toBe('—');
      expect(
        [...second.querySelectorAll('fc-status-badge')].map((b) => b.textContent?.trim()),
      ).toEqual(['ACTIVATIONS.FLAG.DATE_FROM_ID', 'somethingNew']);
      expect(text('.prices')).toContain('ACTIVATIONS.STATEMENT.PRICES');
    });

    it('lists the prices applied, plans first', async () => {
      const { root, flush } = await render();
      await flush();
      expect(
        [...root.querySelectorAll('.prices li')].map((li) =>
          li.textContent?.trim().replace(NBSP, ' '),
        ),
      ).toEqual([
        'ACTIVATIONS.ITEM.PLAN {"plan":"advanced"}: 30,00 €',
        'ACTIVATIONS.ITEM.PLAN {"plan":"basic"}: 20,00 €',
        'PRICE_SERVICE.EXTRA_DESK: 5,00 €',
        'PRICE_SERVICE.KIOSK: 15,00 €',
      ]);
    });

    it('leaves out the list of prices and the projection when the backend sends none', async () => {
      const { root, flush } = await render();
      await flush(
        statement([line()], null, {
          prices: { plans: {}, services: {} },
          totals: { places: 1, amountCents: 100 },
        }),
      );
      expect(root.querySelector('.prices')).toBeNull();
      expect(root.querySelectorAll('.totals div')).toHaveLength(2);
    });

    it('shows an empty section', async () => {
      const { root, flush } = await render();
      await flush(statement([]));
      expect(root.querySelector('fc-empty-state')).not.toBeNull();
      expect(root.querySelector('table')).toBeNull();
    });

    it('shows the failure of the read, and reads again on retry', async () => {
      const { root, view, statementRequest, button } = await render();
      statementRequest().flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.NOT_FOUND');
      button('COMMON.RETRY').click();
      await view();
      statementRequest().flush(statement([line()]));
      await view();
      expect(root.querySelector('table')).not.toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(`/tools/activations/${DEALER}?month=2026-06`, false);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('tabs', () => {
    it('shows the renewals with the columns that belong to them', async () => {
      const { root, flush, view, statementRequest, text, search } = await render();
      await flush();
      expect(root.querySelectorAll('.scroll > table > thead th')).toHaveLength(8);
      root.querySelector<HTMLElement>('#statement-tab-renewals')!.click();
      await view();
      expect(search().get('section')).toBe('renewals');
      const req = statementRequest();
      expect(req.request.params.get('section')).toBe('renewals');
      req.flush(statement([line()]));
      await view();
      expect(text('.intro')).toBe(
        'ACTIVATIONS.STATEMENT.INTRO.RENEWALS {"month":"giugno","year":2026}',
      );
      expect(root.querySelectorAll('.scroll > table > thead th')).toHaveLength(6);
      expect(root.querySelector('#statement-panel-renewals')).not.toBeNull();
    });
  });

  describe('pagination', () => {
    it('goes to the next page, back, and changes the page size', async () => {
      const { root, flush, view, statementRequest, button, search } = await render();
      await flush(statement([line()], 'c2'));
      button('PAGINATION.NEXT').click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      let req = statementRequest();
      expect(req.request.params.get('cursor')).toBe('c2');
      req.flush(statement([line({ placeId: 'p9' })], null));
      await view();
      button('PAGINATION.PREVIOUS').click();
      await view();
      expect(search().has('cursor')).toBe(false);
      req = statementRequest();
      expect(req.request.params.has('cursor')).toBe(false);
      req.flush(statement([line()], 'c2'));
      await view();
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '25';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('25');
      statementRequest().flush(statement([line()]));
      await view();
    });
  });

  describe('print', () => {
    it('prints the page', async () => {
      const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
      const { flush, button } = await render();
      await flush();
      button('ACTIVATIONS.PRINT').click();
      expect(print).toHaveBeenCalledOnce();
    });
  });

  describe('CSV download', () => {
    let created: Blob[];
    let revoked: string[];
    let clicked: HTMLAnchorElement[];

    beforeEach(() => {
      created = [];
      revoked = [];
      clicked = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      });
      URL.revokeObjectURL = vi.fn((url: string) => {
        revoked.push(url);
      });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this);
      });
    });

    it('downloads the lines of the tab, whatever the page', async () => {
      const { flush, button, view, root } = await render(
        `/tools/activations/${DEALER}?month=2026-06&section=renewals&cursor=c1&limit=25`,
      );
      await flush();
      button('ACTIVATIONS.DOWNLOAD').click();
      await view();
      const req = backend().expectOne((r) => r.url === CSV);
      expect(req.request.responseType).toBe('blob');
      expect(req.request.params.keys().sort()).toEqual(['month', 'section']);
      expect(req.request.params.get('section')).toBe('renewals');
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe(
        'ACTIVATIONS.DOWNLOADING',
      );
      req.flush(new Blob(['a;b']));
      await view();
      expect(created).toHaveLength(1);
      expect(clicked[0].download).toBe(`activations_${DEALER}_2026-06_renewals.csv`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(revoked).toEqual(['blob:test']);
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe('');
    });

    it.each([
      [413, 'PAYLOAD_TOO_LARGE', 'ACTIVATIONS.DOWNLOAD_ERROR.TOO_LARGE'],
      [429, 'RATE_LIMITED', 'ACTIVATIONS.DOWNLOAD_ERROR.TOO_MANY'],
      [500, 'INTERNAL_ERROR', 'ACTIVATIONS.DOWNLOAD_ERROR.GENERIC'],
    ])('maps a %i failure to its message', async (status, code, key) => {
      const { flush, button, view, root } = await render();
      await flush();
      button('ACTIVATIONS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .flush(new Blob([JSON.stringify(errorBody(code))]), { status, statusText: code });
      await view();
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe(key);
      expect(created).toHaveLength(0);
    });

    it('reports a failure to save as generic', async () => {
      const { flush, button, view, root } = await render();
      await flush();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        throw new Error('blocked');
      });
      button('ACTIVATIONS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .flush(new Blob(['x']));
      await view();
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe(
        'ACTIVATIONS.DOWNLOAD_ERROR.GENERIC',
      );
    });

    it('reports a network failure as generic', async () => {
      const { flush, button, view, root } = await render();
      await flush();
      button('ACTIVATIONS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .error(new ProgressEvent('error'));
      await view();
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe(
        'ACTIVATIONS.DOWNLOAD_ERROR.GENERIC',
      );
    });
  });
});
