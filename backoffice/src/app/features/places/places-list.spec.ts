import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import {
  COMPANY,
  COMPANY_2,
  COUNTRIES,
  ETAG,
  GROUP,
  PLACE,
  PLACE_2,
  fakeListItem,
  fakePlace,
} from '../../../testing/places';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { PlacesList } from './places-list';
import { PlaceListItem } from './place.types';

const LIST = `${API}/v1/groups/${GROUP}/places`;
const COMPANIES = `${API}/v1/groups/${GROUP}/companies`;
const PLACE_3 = '665f1c2e9b1d4a0012ab34b5';
const COPY = '665f1c2e9b1d4a0012ab34c9';
const ALL = [
  'places:read',
  'places:create',
  'places:trash',
  'places:delete',
  'companies:read',
  'profile:read',
];

const ONE = fakeListItem();
const TWO = fakeListItem({
  id: PLACE_2,
  name: 'Bar Milano',
  companyId: COMPANY_2,
  plan: 'legacy-plan',
  status: 'disabled',
  city: null,
  expirationDate: null,
});
const TRASHED = fakeListItem({ id: PLACE_3, name: 'Bar Torino', trashed: true, plan: null });

function page(data: PlaceListItem[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

function companiesPage(ids: [string, string][], next: string | null = null) {
  return {
    data: ids.map(([id, name]) => ({ id, name, trashed: false })),
    page: { limit: 100, next },
  };
}

async function render(
  url = `/groups/${GROUP}/places`,
  profile: Partial<Profile> = {},
  extra: Provider[] = [],
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/places', component: PlacesList },
          { path: 'groups/:groupId/places/:placeId', children: [] },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', groupId: null, group: null, permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const router = TestBed.inject(Router);
  const request = () => backend().expectOne((r) => r.url === LIST);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const countries = async (body: unknown = COUNTRIES) => {
    backend()
      .expectOne(`${API}/v1/countries`)
      .flush(body as object);
    await view();
  };
  /** Answers the (single page of the) companies of the group. */
  const companies = async (
    ids: [string, string][] = [
      [COMPANY, 'Azienda Esempio Srl'],
      [COMPANY_2, 'Altra Azienda'],
    ],
  ) => {
    backend()
      .expectOne((r) => r.url === COMPANIES)
      .flush(companiesPage(ids));
    await view();
  };
  const flush = async (data: PlaceListItem[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  /** Answers the countries and the companies, then the first page of the places. */
  const load = async (data: PlaceListItem[], next: string | null = null) => {
    await countries();
    await companies();
    return flush(data, next);
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim()).slice(0, 6);
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
  const buttonsOf = (index: number) =>
    [...rows()[index].querySelectorAll<HTMLButtonElement>('td.actions .panel button')].map((b) =>
      b.textContent?.trim(),
    );
  return {
    harness,
    root,
    router,
    request,
    flush,
    load,
    countries,
    companies,
    view,
    rows,
    cells,
    field,
    fieldOrNull,
    choose,
    search,
    buttonsOf,
  };
}

afterEach(() => {
  // Tests that do not care about countries or companies leave their reads unanswered.
  for (const request of backend().match(`${API}/v1/countries`)) {
    request.flush(COUNTRIES);
  }
  for (const request of backend().match((r) => r.url === COMPANIES)) {
    request.flush(companiesPage([]));
  }
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('PlacesList', () => {
  describe('content', () => {
    it('requests the first page of the places with the defaults', async () => {
      const { request, countries } = await render();
      const req = request();
      expect(req.request.method).toBe('GET');
      expect(req.request.params.get('limit')).toBe('25');
      expect(req.request.params.get('sort')).toBe('name');
      expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
      req.flush(page([]));
      await countries();
    });

    it('shows one row per place with its data and a link to the detail', async () => {
      const { load, cells, root } = await render(undefined, { permissions: ALL });
      await load([ONE, TWO, TRASHED]);
      expect(root.querySelector('h1')?.textContent).toBe('PLACES.TITLE');
      expect(cells(0)).toEqual([
        'Bar Roma',
        'Azienda Esempio Srl',
        'Milano',
        'PLACES.PLAN.ADVANCED',
        '2030-01-01',
        'PLACES.STATUS.ACTIVE',
      ]);
      expect(cells(1)).toEqual([
        'Bar Milano',
        'Altra Azienda',
        '',
        'legacy-plan',
        '',
        'PLACES.STATUS.DISABLED',
      ]);
      expect(cells(2)).toEqual([
        'Bar Torino',
        'Azienda Esempio Srl',
        'Milano',
        '',
        '2030-01-01',
        'PLACES.STATUS.TRASHED',
      ]);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/places/${PLACE}`,
      );
    });

    it('labels the plan of a hyphenated plan name', async () => {
      const { load, cells } = await render();
      await load([fakeListItem({ plan: 'tgm-secondary' })]);
      expect(cells(0)[3]).toBe('PLACES.PLAN.TGM_SECONDARY');
    });

    it('shows no company name when the company is not known', async () => {
      const { countries, companies, flush, cells } = await render();
      await countries();
      await companies([]);
      await flush([ONE]);
      expect(cells(0)[1]).toBe('');
    });

    it('explains an empty list and offers to create a place', async () => {
      const { load, root } = await render();
      await load([]);
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('PLACES.EMPTY_MESSAGE');
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/places/new`,
      );
      expect(root.querySelector('a.new')?.getAttribute('href')).toBe(`/groups/${GROUP}/places/new`);
    });

    it('does not offer to create without the permission', async () => {
      const { countries, flush, root } = await render(undefined, {
        permissions: ['places:read'],
      });
      await countries();
      await flush([]);
      expect(root.querySelector('a.new')).toBeNull();
      expect(root.querySelector('fc-empty-state a')).toBeNull();
    });

    it('shows a loading table while it reads', async () => {
      const { request, root, countries, companies } = await render();
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      request().flush(page([]));
      await countries();
      await companies();
    });
  });

  describe('companies of the group', () => {
    it('reads the companies of the group in pages of 100', async () => {
      const { countries, flush, root } = await render();
      const req = backend().expectOne((r) => r.url === COMPANIES);
      expect(req.request.params.get('limit')).toBe('100');
      expect(req.request.params.has('cursor')).toBe(false);
      req.flush(companiesPage([[COMPANY, 'Azienda Esempio Srl']]));
      await countries();
      await flush([]);
      expect(root.textContent).not.toContain('PLACES.LIST_ERROR');
    });

    it('offers the company filter with the companies', async () => {
      const { load, field } = await render();
      await load([ONE]);
      const select = field('PLACES.FILTER.COMPANY') as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
        'PLACES.FILTER.ALL_COMPANIES',
        'Azienda Esempio Srl',
        'Altra Azienda',
      ]);
    });

    it('reads at most five pages of companies', async () => {
      const { countries, flush, view, root } = await render();
      for (let n = 1; n <= 5; n++) {
        const req = backend().expectOne((r) => r.url === COMPANIES);
        expect(req.request.params.get('cursor')).toBe(n === 1 ? null : `c${n - 1}`);
        req.flush(companiesPage([[`665f1c2e9b1d4a0012ab34b${n}`, `Azienda ${n}`]], `c${n}`));
        await view();
      }
      await countries();
      backend().expectNone((r) => r.url === COMPANIES);
      await flush([]);
      expect(root.querySelector('fc-select')).not.toBeNull();
    });

    it('does not read the companies, nor offer the filter, without companies:read', async () => {
      const { countries, flush, fieldOrNull } = await render(undefined, {
        permissions: ['places:read'],
      });
      await countries();
      await flush([ONE]);
      expect(fieldOrNull('PLACES.FILTER.COMPANY')).toBeNull();
    });

    it('does not offer the company filter when there are no companies', async () => {
      const { countries, companies, flush, fieldOrNull } = await render();
      await countries();
      await companies([]);
      await flush([]);
      expect(fieldOrNull('PLACES.FILTER.COMPANY')).toBeNull();
    });
  });

  describe('filters in the URL', () => {
    it('sends the filters it finds in the URL', async () => {
      const { request } = await render(
        `/groups/${GROUP}/places?q=%20bar%20&companyId=${COMPANY}&status=disabled&plan=basic&trashed=true&country=IT&province=MI&cursor=c1&limit=50&sort=-expirationDate`,
      );
      const { params } = request().request;
      expect(params.get('q')).toBe('bar');
      expect(params.get('companyId')).toBe(COMPANY);
      expect(params.get('status')).toBe('disabled');
      expect(params.get('plan')).toBe('basic');
      expect(params.get('trashed')).toBe('true');
      expect(params.get('country')).toBe('IT');
      expect(params.get('province')).toBe('MI');
      expect(params.get('cursor')).toBe('c1');
      expect(params.get('limit')).toBe('50');
      expect(params.get('sort')).toBe('-expirationDate');
    });

    it('ignores the invalid filters of the URL', async () => {
      const { request } = await render(
        `/groups/${GROUP}/places?companyId=xyz&status=nope&plan=bad%20plan&trashed=maybe&country=it&province=12345678901&limit=7&sort=city`,
      );
      expect(request().request.params.keys().sort()).toEqual(['limit', 'sort']);
    });

    it('sorts by name when the sort is invalid and accepts the other valid ones', async () => {
      const first = await render(`/groups/${GROUP}/places?sort=name`);
      expect(first.request().request.params.get('sort')).toBe('name');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const second = await render(`/groups/${GROUP}/places?sort=-name`);
      expect(second.request().request.params.get('sort')).toBe('-name');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const third = await render(`/groups/${GROUP}/places?sort=expirationDate`);
      expect(third.request().request.params.get('sort')).toBe('expirationDate');
    });

    it('shows the filters of the URL in the controls', async () => {
      const { countries, companies, request, field, view } = await render(
        `/groups/${GROUP}/places?country=IT&province=RM&q=x&trashed=true&plan=basic&status=active&companyId=${COMPANY_2}`,
      );
      request().flush(page([]));
      await countries();
      await companies();
      await view();
      expect(field('PLACES.FILTER.COUNTRY').value).toBe('IT');
      expect(field('PLACES.FILTER.PROVINCE').value).toBe('RM');
      expect(field('PLACES.FILTER.SEARCH').value).toBe('x');
      expect(field('PLACES.FILTER.PLAN').value).toBe('basic');
      expect(field('PLACES.FILTER.STATUS').value).toBe('active');
      expect(field('PLACES.FILTER.COMPANY').value).toBe(COMPANY_2);
      expect((field('PLACES.FILTER.TRASHED') as HTMLInputElement).checked).toBe(true);
    });

    it('offers the province only for a country that has areas', async () => {
      const { load, fieldOrNull } = await render(`/groups/${GROUP}/places?country=FR`);
      await load([]);
      expect(fieldOrNull('PLACES.FILTER.PROVINCE')).toBeNull();
    });

    it('changes every filter in the URL, one at a time, and resets the cursor', async () => {
      const { load, choose, field, search, request, view, router } = await render(
        `/groups/${GROUP}/places?cursor=c9`,
      );
      await load([]);
      const apply = async (label: string, value: string) => {
        await choose(label, value);
      };
      await apply('PLACES.FILTER.STATUS', 'active');
      expect(search().get('status')).toBe('active');
      expect(search().has('cursor')).toBe(false);
      request().flush(page([]));
      await view();
      await apply('PLACES.FILTER.COMPANY', COMPANY);
      expect(search().get('companyId')).toBe(COMPANY);
      expect(search().get('status')).toBe('active');
      request().flush(page([]));
      await view();
      await apply('PLACES.FILTER.PLAN', 'basic');
      expect(search().get('plan')).toBe('basic');
      request().flush(page([]));
      await view();
      await apply('PLACES.FILTER.COUNTRY', 'IT');
      expect(search().get('country')).toBe('IT');
      request().flush(page([]));
      await view();
      await apply('PLACES.FILTER.PROVINCE', 'RM');
      expect(search().get('province')).toBe('RM');
      request().flush(page([]));
      await view();
      // A new country drops the province.
      await apply('PLACES.FILTER.COUNTRY', 'FR');
      expect(search().get('country')).toBe('FR');
      expect(search().has('province')).toBe(false);
      request().flush(page([]));
      await view();
      const box = field('PLACES.FILTER.TRASHED') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('trashed')).toBe('true');
      request().flush(page([]));
      await view();
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('trashed')).toBe(false);
      request().flush(page([]));
      await view();
      for (const [label, name] of [
        ['PLACES.FILTER.COUNTRY', 'country'],
        ['PLACES.FILTER.COMPANY', 'companyId'],
        ['PLACES.FILTER.PLAN', 'plan'],
        ['PLACES.FILTER.STATUS', 'status'],
      ]) {
        await apply(label, '');
        expect(search().has(name)).toBe(false);
        request().flush(page([]));
        await view();
      }
      expect(router.url).toBe(`/groups/${GROUP}/places`);
    });

    it('searches after the user stops typing', async () => {
      const { load, field, search, request, view } = await render();
      await load([]);
      const input = field('PLACES.FILTER.SEARCH');
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

    it('does not submit the filters form', async () => {
      const { load, root, view } = await render();
      await load([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      await view();
      expect(event.defaultPrevented).toBe(true);
    });

    it('sorts, changes the page size and pages with the cursor', async () => {
      const { load, root, search, request, view } = await render();
      await load([ONE], 'c2');
      root.querySelector<HTMLButtonElement>('th button')!.click();
      await view();
      expect(search().get('sort')).toBe('-name');
      request().flush(page([ONE], 'c2'));
      await view();
      root.querySelector<HTMLButtonElement>('th button')!.click();
      await view();
      expect(search().get('sort')).toBe('name');
      request().flush(page([ONE], 'c2'));
      await view();
      const [previous, next] = [
        ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator button'),
      ];
      expect(previous.disabled).toBe(true);
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      request().flush(page([TWO], 'c3'));
      await view();
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c3');
      request().flush(page([TRASHED]));
      await view();
      previous.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      request().flush(page([TWO], 'c3'));
      await view();
      previous.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      request().flush(page([ONE], 'c2'));
      await view();
      const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      size.value = '50';
      size.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      request().flush(page([ONE]));
      await view();
    });

    it('sorts by expiration date and keeps the direction toggle', async () => {
      const { load, root, search, request, view } = await render();
      await load([ONE]);
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('th button')];
      buttons[1].click();
      await view();
      expect(search().get('sort')).toBe('expirationDate');
      request().flush(page([ONE]));
      await view();
    });
  });

  describe('inline renewal', () => {
    it('is offered to platform administrators with places:update, on rows not in the trash', async () => {
      const { load, rows } = await render(undefined, { permissions: [...ALL, 'places:update'] });
      await load([ONE, TRASHED, TWO]);
      const renewal = (index: number) => rows()[index].querySelector('fc-place-renewal');
      expect(renewal(0)).not.toBeNull();
      expect(renewal(0)?.querySelector<HTMLInputElement>('input[type=date]')?.value).toBe(
        '2030-01-01',
      );
      expect(renewal(1)).toBeNull();
      expect(rows()[1].textContent).toContain('2030-01-01');
      expect(renewal(2)?.querySelector<HTMLInputElement>('input[type=date]')?.value).toBe('');
    });

    it('is offered to dealers', async () => {
      const { load, rows } = await render(undefined, {
        role: 'D',
        permissions: [...ALL, 'places:update'],
      });
      await load([ONE]);
      expect(rows()[0].querySelector('fc-place-renewal')).not.toBeNull();
    });

    it.each(['SA', 'CA', 'PA'] as const)('is not offered to %s', async (role) => {
      const { load, rows, cells } = await render(undefined, {
        role,
        permissions: [...ALL, 'places:update'],
      });
      await load([ONE]);
      expect(rows()[0].querySelector('fc-place-renewal')).toBeNull();
      expect(cells(0)[4]).toBe('2030-01-01');
    });

    it('is not offered without places:update', async () => {
      const { load, rows } = await render();
      await load([ONE]);
      expect(rows()[0].querySelector('fc-place-renewal')).toBeNull();
    });

    it('reloads the list after a renewal', async () => {
      const { load, rows, view, request } = await render(undefined, {
        permissions: [...ALL, 'places:update'],
      });
      await load([ONE]);
      const input = rows()[0].querySelector<HTMLInputElement>('fc-place-renewal input')!;
      input.value = '2031-02-03';
      input.dispatchEvent(new Event('input'));
      await view();
      rows()[0].querySelector<HTMLButtonElement>('fc-place-renewal button')!.click();
      await view();
      backend()
        .expectOne(`${LIST}/${PLACE}`)
        .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
      await view();
      const put = backend().expectOne(`${LIST}/${PLACE}/license`);
      expect(put.request.method).toBe('PUT');
      put.flush({ data: fakePlace() });
      await view();
      request().flush(page([ONE]));
      await view();
    });
  });

  describe('row actions', () => {
    it('offers duplicate and trash on a place, restore and delete on one in the trash', async () => {
      const { load, buttonsOf } = await render();
      await load([ONE, TRASHED]);
      expect(buttonsOf(0)).toEqual(['PLACES.ACTION.DUPLICATE', 'PLACES.ACTION.TRASH']);
      expect(buttonsOf(1)).toEqual(['PLACES.ACTION.RESTORE', 'PLACES.ACTION.DELETE']);
    });

    it('offers only what the permissions allow', async () => {
      const trashOnly = await render(undefined, { permissions: ['places:read', 'places:trash'] });
      await trashOnly.countries();
      await trashOnly.flush([ONE, TRASHED]);
      expect(trashOnly.buttonsOf(0)).toEqual(['PLACES.ACTION.TRASH']);
      expect(trashOnly.buttonsOf(1)).toEqual(['PLACES.ACTION.RESTORE']);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const deleteOnly = await render(undefined, {
        permissions: ['places:read', 'places:delete'],
      });
      await deleteOnly.countries();
      await deleteOnly.flush([ONE, TRASHED]);
      expect(deleteOnly.buttonsOf(0)).toEqual([]);
      expect(deleteOnly.buttonsOf(1)).toEqual(['PLACES.ACTION.DELETE']);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const createOnly = await render(undefined, {
        permissions: ['places:read', 'places:create'],
      });
      await createOnly.countries();
      await createOnly.flush([ONE, TRASHED]);
      expect(createOnly.buttonsOf(0)).toEqual(['PLACES.ACTION.DUPLICATE']);
      expect(createOnly.buttonsOf(1)).toEqual([]);
    });

    it('offers no menu to a user who cannot create, trash or delete', async () => {
      const { countries, flush, rows } = await render(undefined, { permissions: ['places:read'] });
      await countries();
      await flush([ONE]);
      expect(rows()[0].querySelector('fc-actions-menu')).toBeNull();
    });

    it('opens the confirmation to delete and restores at once', async () => {
      const { load, rows, root, view, request } = await render();
      await load([TRASHED]);
      rows()[0].querySelector<HTMLButtonElement>('td.actions > fc-actions-menu button')!.click();
      await view();
      const [restore, remove] = [
        ...rows()[0].querySelectorAll<HTMLButtonElement>('td.actions .panel button'),
      ];
      remove.click();
      await view();
      expect(root.querySelector('dialog[open]')?.textContent).toContain(
        'PLACES.ACTION.CONFIRM.DELETE {"name":"Bar Torino"}',
      );
      [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
        .find((b) => b.textContent?.trim() === 'COMMON.CANCEL')!
        .click();
      await view();
      restore.click();
      await view();
      backend()
        .expectOne(`${LIST}/${PLACE_3}`)
        .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
      await view();
      backend().expectOne(`${LIST}/${PLACE_3}/restore`).flush({ data: fakePlace() });
      await view();
      request().flush(page([]));
      await view();
    });

    it('trashes a place with the version of the detail and reloads the list', async () => {
      const { load, rows, root, view, request } = await render();
      await load([ONE]);
      rows()[0].querySelector<HTMLButtonElement>('td.actions > fc-actions-menu button')!.click();
      await view();
      [...rows()[0].querySelectorAll<HTMLButtonElement>('td.actions .panel button')]
        .find((b) => b.textContent?.trim() === 'PLACES.ACTION.TRASH')!
        .click();
      await view();
      [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
        .find((b) => b.textContent?.trim() === 'PLACES.ACTION.LABEL.TRASH')!
        .click();
      await view();
      backend()
        .expectOne(`${LIST}/${PLACE}`)
        .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
      await view();
      const post = backend().expectOne(`${LIST}/${PLACE}/trash`);
      expect(post.request.headers.get('If-Match')).toBe(ETAG);
      post.flush({ data: fakePlace({ trashed: true }) });
      await view();
      request().flush(page([]));
      await view();
    });

    it('opens the copy after a duplication', async () => {
      const { load, rows, root, view, router } = await render();
      await load([ONE]);
      rows()[0].querySelector<HTMLButtonElement>('td.actions > fc-actions-menu button')!.click();
      await view();
      [...rows()[0].querySelectorAll<HTMLButtonElement>('td.actions .panel button')]
        .find((b) => b.textContent?.trim() === 'PLACES.ACTION.DUPLICATE')!
        .click();
      await view();
      [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
        .find((b) => b.textContent?.trim() === 'PLACES.ACTION.LABEL.DUPLICATE')!
        .click();
      await view();
      const post = backend().expectOne(`${LIST}/${PLACE}/duplicate`);
      expect(post.request.method).toBe('POST');
      expect(post.request.headers.has('Idempotency-Key')).toBe(true);
      post.flush({ data: fakePlace({ id: COPY }) }, { status: 201, statusText: 'Created' });
      await view();
      expect(router.url).toBe(`/groups/${GROUP}/places/${COPY}`);
    });
  });

  describe('errors and the working group', () => {
    it('shows an error state with the request id and retries', async () => {
      const { request, countries, companies, view, root } = await render();
      request().flush(errorBody('NOT_FOUND'), {
        status: 404,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-9' },
      });
      await countries();
      await companies();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('PLACES.LIST_ERROR');
      expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
      expect(state.textContent).toContain('req-9');
      expect(root.querySelector('table')).toBeNull();
      state.querySelector('button')!.click();
      await view();
      request().flush(page([ONE]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(undefined, {}, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });

    it('does not adopt the group of the URL when the list failed', async () => {
      const { request, countries, companies } = await render();
      const groups = TestBed.inject(GroupContext);
      expect(groups.groupId()).toBeNull();
      request().flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await countries();
      await companies();
      expect(groups.groupId()).toBeNull();
    });

    it('adopts the group after a successful load', async () => {
      const { load } = await render();
      await load([ONE]);
      expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
    });
  });
});
