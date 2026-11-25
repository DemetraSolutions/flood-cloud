import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { aCardType } from '../../../testing/fidelity';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { FidelityCardList } from './fidelity-card-list';
import { FidelityCardRow } from './fidelity-card.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const TYPE_1 = '665f1c2e9b1d4a0012ab3e01';
const TYPE_2 = '665f1c2e9b1d4a0012ab3e02';
const CONTACT = '665f1c2e9b1d4a0012ab3c01';
const ALL = [
  'fidelity:read',
  'fidelity:update',
  'fidelityCards:export',
  'contacts:read',
  'profile:read',
];
const READ_ONLY = { permissions: ['fidelity:read', 'profile:read'] };
const LIST = `${API}/v1/groups/${GROUP}/fidelity-cards`;
const TYPES = `${API}/v1/groups/${GROUP}/fidelity/card-types`;
const CURRENCIES = `${API}/v1/groups/${GROUP}/lookup/currencies`;

const page = (data: FidelityCardRow[], next: string | null = null) => ({
  data,
  page: { limit: 25, next },
});

function row(id: string, over: Partial<FidelityCardRow> = {}): FidelityCardRow {
  return {
    id,
    code: `FC-${id.slice(-2)}`,
    cardType: { id: TYPE_1, name: 'Gold' },
    enabled: true,
    balance: 12.5,
    totalPoints: 1234,
    contact: { id: CONTACT, displayName: 'Anna Bianchi' },
    contactsCount: 1,
    createdAt: '2026-05-01T10:30:00.000Z',
    ...over,
  };
}

const ID_1 = '665f1c2e9b1d4a0012ab3f01';
const ID_2 = '665f1c2e9b1d4a0012ab3f02';

interface Options {
  /** Answer of the read of the types: `fail` leaves them empty. */
  types?: 'ok' | 'fail';
  /** Answer of the read of the currencies. */
  currencies?: 'ok' | 'empty' | 'fail';
  noApi?: boolean;
}

async function render(query = '', profile: Partial<Profile> = {}, options: Options = {}) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(options.noApi === true
        ? [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]
        : []),
      provideRouter(
        [
          { path: 'groups/:groupId/fidelity/cards', component: FidelityCardList },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/fidelity/cards${query}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST && r.method === 'GET');
  const flush = async (data: FidelityCardRow[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const params = (req: ReturnType<typeof request>) =>
    Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  await view();
  for (const read of backend().match((r) => r.url === TYPES)) {
    if (options.types === 'fail') {
      read.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    } else {
      read.flush({
        data: [
          aCardType({
            id: TYPE_1,
            name: 'Gold',
            prepaid: { enabled: true, type: 'multi', taxPercentage: null },
          }),
          aCardType({
            id: TYPE_2,
            name: 'Silver',
            pointsCollect: { enabled: true, collectionIds: ['pc1'] },
          }),
        ],
      });
    }
  }
  for (const read of backend().match((r) => r.url === CURRENCIES)) {
    if (options.currencies === 'fail') {
      read.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    } else {
      read.flush({ data: options.currencies === 'empty' ? [] : [{ code: 'USD' }] });
    }
  }
  await view();
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index]!.querySelectorAll('th, td')].map((c) =>
      c.textContent?.replace(/\s+/g, ' ').trim(),
    );
  const headers = () => [...root.querySelectorAll('thead th')].map((c) => c.textContent?.trim());
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const selects = () => [
    ...root.querySelectorAll<HTMLSelectElement>('form.filters fc-select select'),
  ];
  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await view();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
  };
  return {
    root,
    view,
    request,
    flush,
    params,
    rows,
    cells,
    headers,
    search,
    selects,
    choose,
    type,
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('FidelityCardList', () => {
  describe('table', () => {
    it('requests the cards by code and shows their columns', async () => {
      const { request, params, view, root, headers, cells } = await render();
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'code' });
      req.flush(page([row(ID_1)]));
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('FIDELITY_CARDS.TITLE');
      expect(root.querySelector('.hint')?.textContent).toBe('FIDELITY_CARDS.HINT');
      expect(headers()).toEqual([
        'FIDELITY_CARDS.COLUMN.CODE',
        'FIDELITY_CARDS.COLUMN.TYPE',
        'FIDELITY_CARDS.COLUMN.CUSTOMER',
        'FIDELITY_CARDS.COLUMN.BALANCE',
        'FIDELITY_CARDS.COLUMN.POINTS',
        'FIDELITY_CARDS.COLUMN.CREATED',
        'FIDELITY_CARDS.COLUMN.STATE',
      ]);
      const first = cells(0);
      expect(first[0]).toBe('FC-01');
      expect(first[1]).toBe('Gold');
      expect(first[2]).toBe('Anna Bianchi');
      expect(first[3]).toMatch(/12[.,]50/);
      expect(first[3]).toMatch(/\$|USD/);
      expect(first[4]).toBe('FIDELITY_CARDS.LIST.NONE');
      expect(first[5]).not.toBe('');
      expect(first[6]).toBe('FIDELITY_CARDS.STATE.ENABLED');
      const links = [...root.querySelectorAll('tbody tr a')].map((a) => a.getAttribute('href'));
      expect(links).toEqual([
        `/groups/${GROUP}/fidelity/cards/${ID_1}`,
        `/groups/${GROUP}/contacts/${CONTACT}`,
      ]);
    });

    it('shows the points only for a type that collects them and the credit only for a prepaid one', async () => {
      const { flush, cells } = await render();
      await flush([
        row(ID_1, { cardType: { id: TYPE_2, name: 'Silver' }, balance: 3 }),
        row(ID_2, { balance: null }),
      ]);
      expect(cells(0)[3]).toBe('FIDELITY_CARDS.LIST.NONE');
      expect(cells(0)[4]).toMatch(/^1.?234$/);
      expect(cells(1)[3]).toBe('FIDELITY_CARDS.LIST.NONE');
    });

    it('shows no credit and no points for a type that is gone', async () => {
      const { flush, cells } = await render();
      await flush([row(ID_1, { cardType: null, createdAt: null })]);
      expect(cells(0)[1]).toBe('FIDELITY_CARDS.TYPE_GONE');
      expect(cells(0)[3]).toBe('FIDELITY_CARDS.LIST.NONE');
      expect(cells(0)[4]).toBe('FIDELITY_CARDS.LIST.NONE');
      expect(cells(0)[5]).toBe('');
    });

    it('shows a type without a name as empty', async () => {
      const { flush, cells } = await render();
      await flush([row(ID_1, { cardType: { id: TYPE_1, name: null } })]);
      expect(cells(0)[1]).toBe('');
    });

    it.each(['empty', 'fail'] as const)(
      'uses euro when the currencies are %s',
      async (currencies) => {
        const { flush, cells } = await render('', {}, { currencies });
        await flush([row(ID_1)]);
        expect(cells(0)[3]).toMatch(/€|EUR/);
      },
    );

    it('leaves the credit and the points empty when the types cannot be read', async () => {
      const { flush, cells, selects } = await render('', {}, { types: 'fail' });
      await flush([row(ID_1)]);
      expect(cells(0)[3]).toBe('FIDELITY_CARDS.LIST.NONE');
      expect(cells(0)[4]).toBe('FIDELITY_CARDS.LIST.NONE');
      expect(selects()[0]!.options).toHaveLength(1);
    });

    it('shows the first customer with the others counted, a nameless one and none', async () => {
      const { flush, cells, rows } = await render();
      await flush([
        row(ID_1, { contactsCount: 3 }),
        row(ID_2, { contact: { id: CONTACT, displayName: null } }),
        row('665f1c2e9b1d4a0012ab3f03', { contact: null, contactsCount: 0 }),
      ]);
      expect(cells(0)[2]).toBe('Anna Bianchi FIDELITY_CARDS.LIST.MORE_CUSTOMERS {"count":2}');
      expect(cells(1)[2]).toBe('FIDELITY_CARDS.LIST.CUSTOMER');
      expect(cells(2)[2]).toBe('FIDELITY_CARDS.LIST.NO_CUSTOMER');
      expect(rows()[2]!.querySelectorAll('td a')).toHaveLength(0);
    });

    it('shows the customer as plain text without contacts:read', async () => {
      const { flush, cells, rows } = await render('', READ_ONLY);
      await flush([row(ID_1, { contactsCount: 2 })]);
      expect(cells(0)[2]).toBe('Anna Bianchi FIDELITY_CARDS.LIST.MORE_CUSTOMERS {"count":1}');
      expect(rows()[0]!.querySelectorAll('td a')).toHaveLength(0);
    });

    it('shows the state with text', async () => {
      const { flush, cells, root } = await render();
      await flush([row(ID_1, { enabled: false })]);
      expect(cells(0)[6]).toBe('FIDELITY_CARDS.STATE.DISABLED');
      expect(root.querySelector('fc-status-badge')).not.toBeNull();
    });

    it('shows the loading state, then the empty one with the way to create', async () => {
      const { request, view, root } = await render();
      expect(root.querySelector('fc-skeleton')).not.toBeNull();
      request().flush(page([]));
      await view();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('FIDELITY_CARDS.EMPTY');
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/fidelity/cards/new`,
      );
    });

    it('offers to create only with fidelity:update', async () => {
      const allowed = await render();
      await allowed.flush([]);
      expect(
        allowed.root.querySelector('.page-header a:not(.import-export)')?.getAttribute('href'),
      ).toBe(`/groups/${GROUP}/fidelity/cards/new`);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const limited = await render('', READ_ONLY);
      await limited.flush([]);
      expect(limited.root.querySelector('.page-header a:not(.import-export)')).toBeNull();
      expect(limited.root.querySelector('fc-empty-state a')).toBeNull();
    });

    it('links to the import and export of the cards of the group', async () => {
      const { root, flush } = await render();
      await flush([]);
      const link = root.querySelector('.page-header a.import-export');
      expect(link?.getAttribute('href')).toBe(
        `/groups/${GROUP}/tools/fidelity-cards-import-export`,
      );
      expect(link?.textContent?.trim()).toBe('CATALOG_XLSX.LINK');
    });

    it('hides the link to the import and export without fidelityCards:export', async () => {
      const { root, flush } = await render('', READ_ONLY);
      await flush([]);
      expect(root.querySelector('a.import-export')).toBeNull();
    });

    it('shows the error state with the request id and retries', async () => {
      const { request, view, root } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-3' },
      });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('FIDELITY_CARDS.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('req-3');
      state.querySelector('button')!.click();
      await view();
      request().flush(page([row(ID_1)]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('asks to narrow the text when the search was too slow', async () => {
      const { request, view, root } = await render('?q=ro');
      request().flush(errorBody('SERVICE_UNAVAILABLE'), { status: 503, statusText: 'x' });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('FIDELITY_CARDS.LIST.TOO_SLOW');
      expect(state.textContent).not.toContain('ERRORS.API.SERVICE_UNAVAILABLE');
    });

    it('shows the generic error for a failure that is not an API error', async () => {
      const { view, root } = await render('', {}, { noApi: true });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('parameters in the URL', () => {
    it('reads all of them from the URL', async () => {
      const { request, params, view, selects, root } = await render(
        `?q=%20ann%20&cardTypeId=${TYPE_2}&enabled=false&sort=-createdAt&limit=50&cursor=abc`,
      );
      const req = request();
      expect(params(req)).toEqual({
        limit: '50',
        sort: '-createdAt',
        q: 'ann',
        cardTypeId: TYPE_2,
        enabled: 'false',
        cursor: 'abc',
      });
      await view();
      expect(selects()[0]!.value).toBe(TYPE_2);
      expect(selects()[1]!.value).toBe('false');
      expect(root.querySelector<HTMLInputElement>('input[type=search]')!.value).toBe(' ann ');
      req.flush(page([]));
    });

    it('accepts the enabled state true and the ascending sorts', async () => {
      const { request, params, view } = await render('?enabled=true&sort=updatedAt');
      const req = request();
      expect(params(req)).toMatchObject({ enabled: 'true', sort: 'updatedAt' });
      req.flush(page([]));
      await view();
    });

    it('ignores what is not valid', async () => {
      const { request, params, view, selects, root } = await render(
        '?q=%20&cardTypeId=zzz&enabled=maybe&sort=price&limit=7',
      );
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'code' });
      await view();
      expect(selects()[0]!.value).toBe('');
      expect(selects()[1]!.value).toBe('');
      expect(root.querySelector<HTMLInputElement>('input[type=search]')!.value).toBe(' ');
      req.flush(page([]));
    });

    it('shows the sort of the URL in the header', async () => {
      const { flush, root } = await render('?sort=-code');
      await flush([row(ID_1)]);
      const sorted = [...root.querySelectorAll('th')].filter(
        (th) => th.getAttribute('aria-sort') !== null,
      );
      expect(
        sorted.map((th) => [th.textContent?.trim(), th.getAttribute('aria-sort')]),
      ).toContainEqual(['FIDELITY_CARDS.COLUMN.CODE', 'descending']);
    });
  });

  describe('filters', () => {
    it('filters by type and by state, then clears the filters', async () => {
      const { flush, selects, choose, search, request, params } = await render();
      await flush([]);
      expect([...selects()[0]!.options].map((o) => o.textContent?.trim())).toEqual([
        'FIDELITY_CARDS.FILTER.ALL_TYPES',
        'Gold',
        'Silver',
      ]);
      expect([...selects()[1]!.options].map((o) => o.textContent?.trim())).toEqual([
        'FIDELITY_CARDS.STATE.ALL',
        'FIDELITY_CARDS.STATE.ENABLED',
        'FIDELITY_CARDS.STATE.DISABLED',
      ]);
      await choose(selects()[0]!, TYPE_1);
      expect(search().get('cardTypeId')).toBe(TYPE_1);
      let req = request();
      expect(params(req)['cardTypeId']).toBe(TYPE_1);
      req.flush(page([]));
      await choose(selects()[1]!, 'true');
      expect(search().get('enabled')).toBe('true');
      req = request();
      expect(params(req)['enabled']).toBe('true');
      req.flush(page([]));
      await choose(selects()[0]!, '');
      await flush([]);
      await choose(selects()[1]!, '');
      expect(search().has('cardTypeId')).toBe(false);
      expect(search().has('enabled')).toBe(false);
      await flush([]);
    });

    it('puts the search in the URL once typing pauses, and clears it', async () => {
      const { flush, root, search, type } = await render();
      await flush([]);
      const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
      await type(input, 'ann ');
      expect(search().get('q')).toBe('ann');
      await flush([]);
      await type(input, ' ');
      expect(search().has('q')).toBe(false);
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('sort and pagination', () => {
    it('sorts by code and by creation date, both ways', async () => {
      const { flush, root, view, search } = await render();
      await flush([row(ID_1)]);
      const sorts = () => [...root.querySelectorAll<HTMLButtonElement>('th button.sort')];
      const click = async (index: number, expected: string) => {
        sorts()[index]!.click();
        await view();
        expect(search().get('sort')).toBe(expected);
        await flush([row(ID_1)]);
      };
      await click(1, 'createdAt');
      await click(1, '-createdAt');
      await click(0, 'code');
      await click(0, '-code');
    });

    it('changes the page size and walks the pages back and forth', async () => {
      const { flush, root, view, search } = await render();
      await flush([row(ID_1)], 'c1');
      const [previous, next] = [
        ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button'),
      ];
      expect(previous!.disabled).toBe(true);
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([row(ID_1)], 'c2');
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([row(ID_1)]);
      previous!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([row(ID_1)], 'c2');
      previous!.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([row(ID_1)], 'c1');
      const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      size.value = '50';
      size.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      expect(search().has('cursor')).toBe(false);
      await flush([row(ID_1)]);
    });
  });
});
