import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ActivationsDetail } from './activations-detail';
import { currentMonth, DetailLine, DetailResponse } from './activations.types';

const LINES = `${API}/v1/activations/lines`;
const CSV = `${API}/v1/activations/lines.csv`;
const DEALERS = `${API}/v1/dealers`;
const DEALER = '665f1c2e9b1d4a0012ab34d1';
const NBSP = /\s/g;

function line(overrides: Partial<DetailLine> = {}): DetailLine {
  return {
    dealer: { id: DEALER, name: 'Dealer Nord' },
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
      { key: 'api', quantity: 1, unitCents: 500, amountCents: 500, providers: ['qodeup', 'x'] },
    ],
    monthlyCents: 2500,
    months: 7,
    amountCents: 17500,
    projection12Cents: 30000,
    flags: ['unpricedPlan', 'expired'],
    ...overrides,
  };
}

function detail(data: DetailLine[], next: string | null = null, anomalies = 0): DetailResponse {
  return {
    data,
    page: { limit: 50, next },
    totals: {
      places: 2,
      monthlyCents: 5000,
      amountCents: 35000,
      projection12Cents: 60000,
      anomalies,
    },
    from: '2026-05',
    to: '2026-06',
    referenceYear: 2026,
  };
}

async function render(
  url = '/activations?from=2026-05&to=2026-06',
  profile: Partial<Profile> = {},
  withApi = true,
) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(withApi ? [] : [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]),
      provideRouter(
        [
          { path: 'activations', component: ActivationsDetail },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    role: 'PSA',
    groupId: null,
    group: null,
    permissions: [
      'activations:read',
      'dealers:read',
      'groups:read',
      'companies:read',
      'places:read',
    ],
    ...profile,
  });
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
  const dealers = () =>
    backend()
      .match((r) => r.url === DEALERS)
      .forEach((r) =>
        r.flush({
          data: [fakeDealer({ id: DEALER, businessName: 'Dealer Nord' })],
          page: { limit: 100, next: null },
        }),
      );
  const request = () => backend().expectOne((r) => r.url === LINES);
  const flush = async (body: DetailResponse = detail([line()])) => {
    request().flush(body);
    dealers();
    await view();
  };
  const field = (label: string) => {
    const found = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label);
    return root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${found!.htmlFor}`)!;
  };
  const type = async (label: string, value: string) => {
    const control = field(label);
    control.value = value;
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  return { root, view, request, flush, dealers, field, type, button, search };
}

describe('ActivationsDetail', () => {
  afterEach(() => {
    for (const r of backend().match((q) => q.url === DEALERS)) {
      r.flush({ data: [], page: { limit: 100, next: null } });
    }
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  describe('reading', () => {
    it('asks for the period of the URL and the first page', async () => {
      const { request, view } = await render();
      const req = request();
      expect(req.request.params.get('from')).toBe('2026-05');
      expect(req.request.params.get('to')).toBe('2026-06');
      expect(req.request.params.get('limit')).toBe('50');
      expect(req.request.params.has('dealerId')).toBe(false);
      expect(req.request.params.has('cursor')).toBe(false);
      req.flush(detail([]));
      await view();
    });

    it('starts from the current month for both months', async () => {
      const { request, view, root } = await render('/activations');
      const req = request();
      expect(req.request.params.get('from')).toBe(currentMonth());
      expect(req.request.params.get('to')).toBe(currentMonth());
      req.flush(detail([]));
      await view();
      expect(root.querySelectorAll('input[type=month]')).toHaveLength(2);
    });

    it('shows the totals and a card per place with its price composition', async () => {
      const { root, flush } = await render();
      await flush(
        detail(
          [
            line(),
            line({
              placeId: 'p2',
              placeName: 'Bar Due',
              plan: null,
              activatedAt: 'garbage',
              items: [{ key: 'plan:', quantity: 1, unitCents: null, amountCents: 0 }],
              flags: ['activationDateFromId'],
              devices: { desks: 1, kiosks: 0, handhelds: 0 },
            }),
          ],
          null,
          3,
        ),
      );
      const totals = [...root.querySelectorAll('.totals div')].map((d) =>
        d.textContent?.replace(NBSP, ' ').trim(),
      );
      expect(totals).toEqual([
        'ACTIVATIONS.DETAIL.TOTAL_PLACES2',
        'ACTIVATIONS.DETAIL.TOTAL_MONTHLY50,00 €',
        'ACTIVATIONS.DETAIL.TOTAL_AMOUNT {"year":2026}350,00 €',
        'ACTIVATIONS.COLUMN.PROJECTION600,00 €',
        'ACTIVATIONS.COLUMN.ANOMALIES3',
      ]);
      const amount = root.querySelectorAll('.totals div')[2];
      expect(amount.getAttribute('title')).toBe('ACTIVATIONS.DETAIL.TOTAL_AMOUNT_HINT');
      expect(amount.getAttribute('aria-description')).toBe('ACTIVATIONS.DETAIL.TOTAL_AMOUNT_HINT');
      const cards = [...root.querySelectorAll('.place')];
      expect(cards).toHaveLength(2);
      const first = cards[0];
      expect(first.querySelector('h3')?.textContent).toContain('Dealer Nord');
      expect([...first.querySelectorAll('h3 a')].map((a) => a.getAttribute('href'))).toEqual([
        '/groups/g1/settings',
        '/groups/g1/companies/c1',
        '/groups/g1/places/p1',
      ]);
      const rows = [...first.querySelectorAll('fc-fee-items tbody tr')].map((r) =>
        [...r.querySelectorAll('th, td')].map((c) => c.textContent?.trim().replace(NBSP, ' ')),
      );
      expect(rows).toEqual([
        ['ACTIVATIONS.ITEM.PLAN {"plan":"basic"}', '', '20,00 €', '20,00 €'],
        ['PRICE_SERVICE.API (ACTIVATIONS.PROVIDER.QODEUP, x)', '', '5,00 €', '5,00 €'],
      ]);
      const facts = [...first.querySelectorAll('.facts dd')].map((d) =>
        d.textContent?.trim().replace(NBSP, ' '),
      );
      expect(facts.slice(1)).toEqual(['basic', '7', '175,00 €', '300,00 €']);
      expect(
        [...first.querySelectorAll('.flags fc-status-badge')].map((b) =>
          b.getAttribute('data-tone'),
        ),
      ).toEqual(['warning', 'neutral']);
      const second = cards[1];
      expect(second.querySelectorAll('.facts dd')[0].textContent?.trim()).toBe('—');
      expect(second.querySelectorAll('.facts dd')[1].textContent?.trim()).toBe('—');
      expect(second.querySelector('fc-fee-items tbody')?.textContent).toContain(
        'ACTIVATIONS.ITEM.DEVICES',
      );
      expect(second.querySelector('fc-fee-items tbody')?.textContent).toContain(
        'ACTIVATIONS.ITEM.UNPRICED',
      );
    });

    it('shows no dealer and no links to a user who cannot open them', async () => {
      const { root, flush } = await render('/activations?from=2026-05&to=2026-06', {
        role: 'D',
        permissions: ['activations:read'],
      });
      await flush();
      expect(root.querySelector('.dealer')).toBeNull();
      expect(root.querySelector('h3 a')).toBeNull();
      expect(root.querySelector('h3')?.textContent).toContain('Bar Centrale');
      expect(root.querySelector('form fc-select')).toBeNull();
      expect(root.querySelector('.totals')?.textContent).not.toContain('ANOMALIES');
    });

    it('does not submit the filters as a form', async () => {
      const { root, flush } = await render();
      await flush();
      const submit = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
    });

    it('shows an empty period', async () => {
      const { root, flush } = await render();
      await flush(detail([]));
      expect(root.querySelector('fc-empty-state')).not.toBeNull();
    });

    it('shows the failure of the read, and reads again on retry', async () => {
      const { root, request, view, button, flush } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain(
        'ERRORS.API.INTERNAL_ERROR',
      );
      expect(root.querySelector('fc-cursor-paginator')).toBeNull();
      button('COMMON.RETRY').click();
      await view();
      await flush();
      expect(root.querySelector('.place')).not.toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render('/activations?from=2026-05&to=2026-06', {}, false);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('period', () => {
    it('reads the new period once both months are right, and says what is wrong before', async () => {
      const { root, flush, type, view, request, search } = await render();
      await flush();
      await type('ACTIVATIONS.DETAIL.FROM', '2026-08');
      expect(root.textContent).toContain('ACTIVATIONS.DETAIL.ERROR.ORDER');
      backend().expectNone((r) => r.url === LINES);
      await type('ACTIVATIONS.DETAIL.TO', '2026-09');
      expect(search().get('from')).toBe('2026-08');
      expect(search().get('to')).toBe('2026-09');
      const req = request();
      expect(req.request.params.get('from')).toBe('2026-08');
      req.flush(detail([]));
      await view();
      await type('ACTIVATIONS.DETAIL.TO', 'bad');
      expect(root.textContent).toContain('ACTIVATIONS.DETAIL.ERROR.MONTH');
      await type('ACTIVATIONS.DETAIL.TO', '2029-09');
      expect(root.textContent).not.toContain('ACTIVATIONS.DETAIL.ERROR');
      const long = request();
      expect(long.request.params.get('from')).toBe('2026-08');
      expect(long.request.params.get('to')).toBe('2029-09');
      long.flush(detail([]));
      await view();
    });

    it('reads everything up to the end month when the start is empty, with no from anywhere', async () => {
      const { root, flush, type, request, search, view, field } = await render();
      await flush();
      expect(root.textContent).toContain('ACTIVATIONS.DETAIL.FROM_HINT');
      await type('ACTIVATIONS.DETAIL.FROM', '');
      expect(root.textContent).not.toContain('ACTIVATIONS.DETAIL.ERROR');
      expect(search().has('from')).toBe(false);
      expect(search().get('to')).toBe('2026-06');
      const req = request();
      expect(req.request.params.has('from')).toBe(false);
      expect(req.request.params.get('to')).toBe('2026-06');
      req.flush({ ...detail([]), from: null });
      await view();
      expect(field('ACTIVATIONS.DETAIL.FROM').value).toBe('');
      await type('ACTIVATIONS.DETAIL.TO', '2026-09');
      const next = request();
      expect(next.request.params.has('from')).toBe(false);
      next.flush({ ...detail([]), from: null });
      await view();
      await type('ACTIVATIONS.DETAIL.FROM', '2026-01');
      expect(search().get('from')).toBe('2026-01');
      request().flush(detail([]));
      await view();
    });

    it('opens a link with the end month only on an empty start', async () => {
      const { request, field, view } = await render('/activations?to=2026-06');
      const req = request();
      expect(req.request.params.has('from')).toBe(false);
      expect(req.request.params.get('to')).toBe('2026-06');
      req.flush({ ...detail([]), from: null });
      await view();
      expect(field('ACTIVATIONS.DETAIL.FROM').value).toBe('');
      expect(field('ACTIVATIONS.DETAIL.TO').value).toBe('2026-06');
    });

    it('explains how to narrow the period when there are too many lines', async () => {
      const { root, request, view } = await render('/activations?to=2026-06');
      request().flush(errorBody('CONFLICT', [{ field: 'to', issue: 'tooManyLines' }]), {
        status: 409,
        statusText: 'Conflict',
      });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain(
        'ACTIVATIONS.DETAIL.TOO_MANY_LINES',
      );
    });

    it('does not read a wrong period of the URL', async () => {
      const { root, view } = await render('/activations?from=bad&to=2026-06');
      await view();
      backend().expectNone((r) => r.url === LINES);
      expect(root.textContent).toContain('ACTIVATIONS.DETAIL.ERROR.MONTH');
      expect(root.querySelector('fc-cursor-paginator')).toBeNull();
      expect(root.querySelectorAll('button[disabled]').length).toBeGreaterThan(0);
    });
  });

  describe('dealer', () => {
    it('offers the dealers and the groups without one, and sends the choice', async () => {
      const { field, type, request, flush, view, search, root } = await render();
      await flush();
      const options = [...field('ACTIVATIONS.COLUMN.DEALER').querySelectorAll('option')].map(
        (o) => o.value,
      );
      expect(options).toEqual(['', DEALER, 'none']);
      await type('ACTIVATIONS.COLUMN.DEALER', 'none');
      expect(search().get('dealerId')).toBe('none');
      let req = request();
      expect(req.request.params.get('dealerId')).toBe('none');
      req.flush(detail([]));
      await view();
      await type('ACTIVATIONS.COLUMN.DEALER', DEALER);
      req = request();
      expect(req.request.params.get('dealerId')).toBe(DEALER);
      req.flush(detail([]));
      await view();
      await type('ACTIVATIONS.COLUMN.DEALER', '');
      expect(search().has('dealerId')).toBe(false);
      request().flush(detail([]));
      await view();
      expect(root.querySelector('form fc-select')).not.toBeNull();
    });

    it('drops a wrong dealer of the URL, and a dealer never sends one', async () => {
      const first = await render('/activations?from=2026-05&to=2026-06&dealerId=bad');
      const req = first.request();
      expect(req.request.params.has('dealerId')).toBe(false);
      req.flush(detail([]));
      await first.view();
    });

    it('never sends the dealer of a dealer user', async () => {
      const { request, view } = await render(
        `/activations?from=2026-05&to=2026-06&dealerId=${DEALER}`,
        { role: 'D', permissions: ['activations:read'] },
      );
      const req = request();
      expect(req.request.params.has('dealerId')).toBe(false);
      req.flush(detail([]));
      await view();
    });
  });

  describe('pagination', () => {
    it('goes to the next page, back, and changes the page size', async () => {
      const { root, flush, view, request, button, search } = await render();
      await flush(detail([line()], 'c2'));
      button('PAGINATION.NEXT').click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      let req = request();
      expect(req.request.params.get('cursor')).toBe('c2');
      req.flush(detail([line()], null));
      await view();
      button('PAGINATION.PREVIOUS').click();
      await view();
      expect(search().has('cursor')).toBe(false);
      req = request();
      req.flush(detail([line()], 'c2'));
      await view();
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '25';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('25');
      request().flush(detail([line()]));
      await view();
    });

    it('falls back to the default page size when the URL has a wrong one', async () => {
      const { request, view } = await render('/activations?from=2026-05&to=2026-06&limit=7');
      const req = request();
      expect(req.request.params.get('limit')).toBe('50');
      req.flush(detail([]));
      await view();
    });
  });

  describe('print and CSV', () => {
    let created: Blob[];
    let clicked: HTMLAnchorElement[];

    beforeEach(() => {
      created = [];
      clicked = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      });
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this);
      });
    });

    it('prints the page', async () => {
      const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
      const { flush, button } = await render();
      await flush();
      button('ACTIVATIONS.PRINT').click();
      expect(print).toHaveBeenCalledOnce();
    });

    it('downloads the lines of the period with the dealer, whatever the page', async () => {
      const { flush, button, view, root } = await render(
        `/activations?from=2026-05&to=2026-06&dealerId=${DEALER}&cursor=c1&limit=25`,
      );
      await flush();
      button('ACTIVATIONS.DOWNLOAD').click();
      await view();
      const req = backend().expectOne((r) => r.url === CSV);
      expect(req.request.responseType).toBe('blob');
      expect(req.request.params.keys().sort()).toEqual(['dealerId', 'from', 'to']);
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe(
        'ACTIVATIONS.DOWNLOADING',
      );
      req.flush(new Blob(['a;b']));
      await view();
      expect(created).toHaveLength(1);
      expect(clicked[0].download).toBe('attivazioni-dettaglio_2026-05_2026-06.csv');
      expect(root.querySelector('.download-status')?.textContent?.trim()).toBe('');
    });

    it('downloads the CSV with no start: no from, and the file name says so', async () => {
      const { flush, button, view } = await render('/activations?to=2026-06');
      await flush({ ...detail([line()]), from: null });
      button('ACTIVATIONS.DOWNLOAD').click();
      await view();
      const req = backend().expectOne((r) => r.url === CSV);
      expect(req.request.params.keys()).toEqual(['to']);
      req.flush(new Blob(['a;b']));
      await view();
      expect(clicked[0].download).toBe('attivazioni-dettaglio_inizio_2026-06.csv');
    });

    it.each([
      [409, 'CONFLICT', 'ACTIVATIONS.DETAIL.DOWNLOAD_ERROR.TOO_MANY_LINES'],
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
  });
});
