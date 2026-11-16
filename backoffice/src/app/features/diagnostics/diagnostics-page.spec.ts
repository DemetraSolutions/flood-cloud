import { CanMatchFn, Route } from '@angular/router';
import { routes } from '../../app.routes';
import { Provider, signal } from '@angular/core';
import { AppConfig } from '../../core/config/app-config';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { COMPANY, COMPANY_2, GROUP, PLACE, PLACE_2 } from '../../../testing/places';
import { signIn } from '../../../testing/session';
import { LAST_GROUP_ID_KEY } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { DiagnosticsPage } from './diagnostics-page';
import { DiagnosticRow } from './diagnostics.types';

const LIST = `${API}/v1/diagnostics/devices`;
const CSV = `${API}/v1/diagnostics/devices.csv`;
const COMPANIES = `${API}/v1/groups/${GROUP}/companies`;
const PLACES = `${API}/v1/groups/${GROUP}/places`;

function row(overrides: Partial<DiagnosticRow> = {}): DiagnosticRow {
  return {
    id: `${PLACE}:0`,
    groupId: GROUP,
    groupName: 'Gruppo Esempio',
    companyId: COMPANY,
    companyName: 'Azienda Esempio Srl',
    companyCode: '01234567890',
    placeId: PLACE,
    placeName: 'Bar Roma',
    deviceId: 'dev0001',
    deviceName: 'Cassa 1',
    deviceType: 'desk',
    appVersion: '1.21.0',
    server: true,
    platform: 'android',
    platformVersion: '14',
    model: 'Pixel',
    lastDataDownload: '2026-11-10T09:30:00.000Z',
    lastSession: '2026-11-11T10:45:00.000Z',
    storeKey: { status: 'active', lastSeenAt: '2026-11-12T08:00:00.000Z', appVersion: '2.0.1' },
    ...overrides,
  };
}

const EMPTY_ROW = row({
  id: `${PLACE_2}:1`,
  companyId: null,
  companyName: null,
  companyCode: null,
  deviceId: null,
  deviceType: null,
  appVersion: null,
  server: false,
  platform: null,
  platformVersion: null,
  model: null,
  lastDataDownload: null,
  lastSession: null,
  storeKey: { status: 'none', lastSeenAt: null, appVersion: null },
});
const ODD_TYPE = row({ id: `${PLACE_2}:2`, deviceType: 'room-handheld' });
const UNKNOWN_TYPE = row({ id: `${PLACE_2}:3`, deviceType: 'weird' });

function page(data: DiagnosticRow[], next: string | null = null) {
  return { data, page: { limit: 50, next } };
}

function names(items: [string, string][], next: string | null = null) {
  return {
    data: items.map(([id, name]) => ({ id, name, companyId: COMPANY })),
    page: { limit: 100, next },
  };
}

async function render(
  url = '/tools/diagnostics',
  profile: Partial<Profile> = {},
  group: string | null = null,
  extra: Provider[] = [],
) {
  if (group !== null) {
    sessionStorage.setItem(LAST_GROUP_ID_KEY, group);
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'tools/diagnostics', component: DiagnosticsPage },
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
    permissions: ['places:read', 'companies:read', 'profile:read'],
    ...profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const router = TestBed.inject(Router);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST);
  const flush = async (data: DiagnosticRow[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  /** Answers the lookups of a group (companies and places), when a group is chosen. */
  const lookups = async () => {
    backend()
      .expectOne((r) => r.url === COMPANIES)
      .flush(
        names([
          [COMPANY, 'Azienda Esempio Srl'],
          [COMPANY_2, 'Altra Azienda'],
        ]),
      );
    backend()
      .expectOne((r) => r.url === PLACES)
      .flush({
        data: [
          { id: PLACE, name: 'Bar Roma', companyId: COMPANY },
          { id: PLACE_2, name: 'Bar Milano', companyId: COMPANY_2 },
        ],
        page: { limit: 100, next: null },
      });
    await view();
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const fieldOrNull = (label: string) => {
    const found = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label);
    return found === undefined
      ? null
      : root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${found.htmlFor}`);
  };
  const field = (label: string) => fieldOrNull(label)!;
  const choose = async (label: string, value: string) => {
    const control = field(label);
    control.value = value;
    control.dispatchEvent(new Event('change'));
    await view();
  };
  const search = () => new URL(router.url, 'http://x').searchParams;
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  return {
    harness,
    root,
    router,
    view,
    request,
    flush,
    lookups,
    rows,
    cells,
    field,
    fieldOrNull,
    choose,
    search,
    button,
  };
}

describe('DiagnosticsPage', () => {
  beforeEach(() => sessionStorage.clear());

  afterEach(() => {
    for (const request of backend().match(() => true)) {
      request.flush(names([]));
    }
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  describe('table', () => {
    it('requests the first page with the default limit and no group', async () => {
      const { request, view } = await render();
      const req = request();
      expect(req.request.params.keys()).toEqual(['limit']);
      expect(req.request.params.get('limit')).toBe('50');
      req.flush(page([]));
      await view();
    });

    it('shows a row per device with the group column when no group is chosen', async () => {
      const { flush, cells, root } = await render();
      await flush([row(), EMPTY_ROW, ODD_TYPE, UNKNOWN_TYPE]);
      expect(root.querySelector('h1')?.textContent).toBe('DIAGNOSTICS.TITLE');
      expect(root.querySelector('caption')?.textContent?.trim()).toBe('DIAGNOSTICS.TITLE');
      expect([...root.querySelectorAll('thead th')].map((th) => th.getAttribute('scope'))).toEqual(
        Array(16).fill('col'),
      );
      const first = cells(0);
      expect(first).toHaveLength(16);
      expect(first.slice(0, 2)).toEqual(['Gruppo Esempio', 'Azienda Esempio Srl']);
      expect(first[2]).toBe('01234567890');
      expect(first[5]).toBe('DIAGNOSTICS.TYPE.DESK');
      expect(first[6]).toBe('1.21.0');
      expect(first[7]).toBe('DIAGNOSTICS.YES');
      expect(first[11]).toMatch(/2026/);
      expect(first[13]).toBe('DIAGNOSTICS.STORE_KEY.ACTIVE');
      expect(first[14]).toMatch(/2026/);
      expect(first[15]).toBe('2.0.1');
      const empty = cells(1);
      expect(empty.slice(1)).toEqual([
        '—',
        '—',
        'Bar Roma',
        'Cassa 1',
        '—',
        '—',
        'DIAGNOSTICS.NO',
        '—',
        '—',
        '—',
        '—',
        '—',
        'DIAGNOSTICS.STORE_KEY.NONE',
        '—',
        '—',
      ]);
      expect(cells(2)[5]).toBe('DIAGNOSTICS.TYPE.ROOM_HANDHELD');
      expect(cells(3)[5]).toBe('weird');
    });

    it('shows a loading table, then an empty state', async () => {
      const { request, root, view } = await render();
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      request().flush(page([]));
      await view();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain(
        'DIAGNOSTICS.EMPTY_MESSAGE',
      );
    });

    it('shows the error and retries', async () => {
      const { request, root, view } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('DIAGNOSTICS.LOAD_ERROR');
      expect(root.querySelector('table')).toBeNull();
      root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
      await view();
      request().flush(page([row()]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(undefined, {}, null, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('group', () => {
    it('sends the working group, hides the group column and offers company and place filters', async () => {
      const { request, lookups, view, cells, field } = await render(undefined, {}, GROUP);
      const req = request();
      expect(req.request.params.get('groupId')).toBe(GROUP);
      req.flush(page([row()]));
      await lookups();
      await view();
      expect(cells(0)).toHaveLength(15);
      expect(cells(0)[0]).toBe('Azienda Esempio Srl');
      const companies = field('DIAGNOSTICS.FILTER.COMPANY') as HTMLSelectElement;
      expect([...companies.options].map((o) => o.textContent?.trim())).toEqual([
        'DIAGNOSTICS.FILTER.ALL_COMPANIES',
        'Azienda Esempio Srl',
        'Altra Azienda',
      ]);
      const places = field('DIAGNOSTICS.FILTER.PLACE') as HTMLSelectElement;
      expect(places.options).toHaveLength(3);
    });

    it('narrows the places to the chosen company', async () => {
      const { request, lookups, view, field } = await render(
        `/tools/diagnostics?companyId=${COMPANY_2}`,
        {},
        GROUP,
      );
      request().flush(page([]));
      await lookups();
      await view();
      const places = field('DIAGNOSTICS.FILTER.PLACE') as HTMLSelectElement;
      expect([...places.options].map((o) => o.textContent?.trim())).toEqual([
        'DIAGNOSTICS.FILTER.ALL_PLACES',
        'Bar Milano',
      ]);
    });

    it('does not read the companies, nor offer their filter, without companies:read', async () => {
      const { request, view, fieldOrNull } = await render(
        undefined,
        { permissions: ['places:read'] },
        GROUP,
      );
      request().flush(page([]));
      backend()
        .expectOne((r) => r.url === PLACES)
        .flush({
          data: [{ id: PLACE, name: 'Bar Roma', companyId: COMPANY }],
          page: { limit: 100, next: null },
        });
      await view();
      expect(fieldOrNull('DIAGNOSTICS.FILTER.COMPANY')).toBeNull();
      expect(fieldOrNull('DIAGNOSTICS.FILTER.PLACE')).not.toBeNull();
    });

    it('uses the own group of a group administrator', async () => {
      const { request, view, root } = await render(undefined, {
        role: 'SA',
        groupId: GROUP,
        permissions: ['places:read'],
      });
      expect(request().request.params.get('groupId')).toBe(GROUP);
      backend()
        .match((r) => r.url === PLACES)
        .forEach((r) => r.flush(names([])));
      await view();
      expect(root.querySelector('thead')?.textContent).not.toContain('DIAGNOSTICS.COLUMN.GROUP');
    });

    it('ignores company and place filters while no group is chosen', async () => {
      const { request, fieldOrNull, view } = await render(
        `/tools/diagnostics?companyId=${COMPANY}&placeId=${PLACE}`,
      );
      expect(request().request.params.keys()).toEqual(['limit']);
      await view();
      expect(fieldOrNull('DIAGNOSTICS.FILTER.COMPANY')).toBeNull();
      expect(fieldOrNull('DIAGNOSTICS.FILTER.PLACE')).toBeNull();
    });
  });

  describe('filters in the URL', () => {
    it('sends the filters it finds in the URL', async () => {
      const { request } = await render(
        `/tools/diagnostics?q=%20bar%20&companyId=${COMPANY}&placeId=${PLACE}&type=kiosk&cursor=c1&limit=25`,
        {},
        GROUP,
      );
      const { params } = request().request;
      expect(params.get('groupId')).toBe(GROUP);
      expect(params.get('q')).toBe('bar');
      expect(params.get('companyId')).toBe(COMPANY);
      expect(params.get('placeId')).toBe(PLACE);
      expect(params.get('type')).toBe('kiosk');
      expect(params.get('cursor')).toBe('c1');
      expect(params.get('limit')).toBe('25');
    });

    it('ignores the invalid filters and limits the search to 64 characters', async () => {
      const { request } = await render(
        `/tools/diagnostics?companyId=xyz&placeId=abc&type=nope&limit=7&q=${'a'.repeat(80)}`,
        {},
        GROUP,
      );
      const { params } = request().request;
      expect(params.keys().sort()).toEqual(['groupId', 'limit', 'q']);
      expect(params.get('q')).toBe('a'.repeat(64));
      expect(params.get('limit')).toBe('50');
    });

    it('shows the filters of the URL in the controls', async () => {
      const { request, lookups, field, view } = await render(
        `/tools/diagnostics?q=x&type=tgm&companyId=${COMPANY}&placeId=${PLACE}`,
        {},
        GROUP,
      );
      request().flush(page([]));
      await lookups();
      await view();
      expect(field('DIAGNOSTICS.FILTER.SEARCH').value).toBe('x');
      expect(field('DIAGNOSTICS.FILTER.TYPE').value).toBe('tgm');
      expect(field('DIAGNOSTICS.FILTER.COMPANY').value).toBe(COMPANY);
      expect(field('DIAGNOSTICS.FILTER.PLACE').value).toBe(PLACE);
    });

    it('changes the filters in the URL, resets the cursor and drops the place with a new company', async () => {
      const { request, lookups, view, choose, search, router } = await render(
        `/tools/diagnostics?cursor=c9&placeId=${PLACE}`,
        {},
        GROUP,
      );
      request().flush(page([]));
      await lookups();
      await choose('DIAGNOSTICS.FILTER.TYPE', 'kiosk');
      expect(search().get('type')).toBe('kiosk');
      expect(search().has('cursor')).toBe(false);
      request().flush(page([]));
      await view();
      await choose('DIAGNOSTICS.FILTER.PLACE', PLACE_2);
      expect(search().get('placeId')).toBe(PLACE_2);
      request().flush(page([]));
      await view();
      await choose('DIAGNOSTICS.FILTER.COMPANY', COMPANY_2);
      expect(search().get('companyId')).toBe(COMPANY_2);
      expect(search().has('placeId')).toBe(false);
      request().flush(page([]));
      await view();
      for (const [label, name] of [
        ['DIAGNOSTICS.FILTER.COMPANY', 'companyId'],
        ['DIAGNOSTICS.FILTER.TYPE', 'type'],
      ]) {
        await choose(label, '');
        expect(search().has(name)).toBe(false);
        request().flush(page([]));
        await view();
      }
      expect(router.url).toBe('/tools/diagnostics');
    });

    it('searches after the user stops typing', async () => {
      const { request, field, search, view } = await render();
      request().flush(page([]));
      await view();
      const input = field('DIAGNOSTICS.FILTER.SEARCH');
      input.value = ' bar ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('q')).toBe('bar');
      request().flush(page([]));
      await view();
      input.value = '  ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().has('q')).toBe(false);
      request().flush(page([]));
      await view();
    });
  });

  describe('search form', () => {
    it('does not submit the page', async () => {
      const { request, root, view } = await render();
      request().flush(page([]));
      await view();
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('pagination', () => {
    it('moves along the cursors and changes the page size', async () => {
      const { request, flush, button, view, search, field, choose } = await render();
      await flush([row()], 'c1');
      expect(button('PAGINATION.PREVIOUS').disabled).toBe(true);
      button('PAGINATION.NEXT').click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      const second = request();
      expect(second.request.params.get('cursor')).toBe('c1');
      second.flush(page([row()], 'c2'));
      await view();
      button('PAGINATION.NEXT').click();
      await view();
      request().flush(page([row()]));
      await view();
      expect(button('PAGINATION.NEXT').disabled).toBe(true);
      button('PAGINATION.PREVIOUS').click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      request().flush(page([row()], 'c2'));
      await view();
      button('PAGINATION.PREVIOUS').click();
      await view();
      expect(search().has('cursor')).toBe(false);
      request().flush(page([row()], 'c1'));
      await view();
      await choose('PAGINATION.PER_PAGE', '100');
      expect(search().get('limit')).toBe('100');
      expect(field('PAGINATION.PER_PAGE')).not.toBeNull();
      expect(request().request.params.get('limit')).toBe('100');
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

    it('downloads the file with the filters of the table and without the page', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-16T10:00:00Z') });
      try {
        const { request, flush, button, view, root } = await render(
          `/tools/diagnostics?q=bar&type=kiosk&cursor=c1&limit=25`,
          {},
          GROUP,
        );
        request().flush(page([row()]));
        backend()
          .match((r) => r.url === COMPANIES || r.url === PLACES)
          .forEach((r) => r.flush(names([])));
        await view();
        button('DIAGNOSTICS.DOWNLOAD').click();
        await view();
        const req = backend().expectOne((r) => r.url === CSV);
        expect(req.request.method).toBe('GET');
        expect(req.request.responseType).toBe('blob');
        expect(req.request.params.keys().sort()).toEqual(['groupId', 'q', 'type']);
        expect(button('DIAGNOSTICS.DOWNLOAD').disabled).toBe(true);
        expect(button('DIAGNOSTICS.DOWNLOAD').getAttribute('aria-busy')).toBe('true');
        expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
          'DIAGNOSTICS.DOWNLOADING',
        );
        req.flush(new Blob(['a;b']));
        await view();
        expect(created).toHaveLength(1);
        expect(clicked[0].download).toBe('devices-diagnostic_2026-11-16.csv');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(revoked).toEqual(['blob:test']);
        expect(button('DIAGNOSTICS.DOWNLOAD').disabled).toBe(false);
        expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
        void flush;
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      [413, 'PAYLOAD_TOO_LARGE', 'DIAGNOSTICS.DOWNLOAD_ERROR.TOO_LARGE'],
      [429, 'RATE_LIMITED', 'DIAGNOSTICS.DOWNLOAD_ERROR.TOO_MANY'],
      [500, 'INTERNAL_ERROR', 'DIAGNOSTICS.DOWNLOAD_ERROR.GENERIC'],
    ])('maps a %i failure to its message', async (status, code, key) => {
      const { flush, button, view, root } = await render();
      await flush([row()]);
      button('DIAGNOSTICS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .flush(new Blob([JSON.stringify(errorBody(code))]), { status, statusText: code });
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(key);
      expect(button('DIAGNOSTICS.DOWNLOAD').disabled).toBe(false);
      expect(created).toHaveLength(0);
    });

    it('reports a network failure and a failure to save as generic', async () => {
      const { flush, button, view, root } = await render();
      await flush([row()]);
      button('DIAGNOSTICS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .error(new ProgressEvent('error'));
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'DIAGNOSTICS.DOWNLOAD_ERROR.GENERIC',
      );
      // A new attempt clears the message; saving fails with a plain error.
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        throw new Error('blocked');
      });
      button('DIAGNOSTICS.DOWNLOAD').click();
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'DIAGNOSTICS.DOWNLOADING',
      );
      backend()
        .expectOne((r) => r.url === CSV)
        .flush(new Blob(['x']));
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'DIAGNOSTICS.DOWNLOAD_ERROR.GENERIC',
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(revoked).toEqual(['blob:test']);
    });
  });
});

describe('diagnostics route', () => {
  function route() {
    const find = (list: readonly Route[]): Route | undefined => {
      for (const item of list) {
        if (item.path === 'tools/diagnostics') {
          return item;
        }
        const found = find(item.children ?? []);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };
    return find(routes) as Route;
  }

  it('is protected by the places:read permission and titled', async () => {
    const found = route();
    expect(found.title).toBe('DIAGNOSTICS.TITLE');
    expect(found.canMatch).toHaveLength(1);
    expect(await found.loadComponent?.()).toBe(DiagnosticsPage);
  });

  it.each([
    [['places:read'], true],
    [['profile:read'], false],
  ])('matches only with the permission (%j)', (permissions, allowed) => {
    TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
    signIn({ role: 'SA', permissions });
    const guard = (route().canMatch as CanMatchFn[])[0];
    expect(TestBed.runInInjectionContext(() => guard(route(), [], {} as never)) === true).toBe(
      allowed,
    );
  });
});
