import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { COMPANY, COUNTRIES, ETAG, GROUP, fakeCompany } from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { CompaniesList } from './companies-list';
import { CompanyListItem } from './company.types';

const LIST = `${API}/v1/groups/${GROUP}/companies`;
const ALL = [
  'companies:read',
  'companies:create',
  'companies:update',
  'companies:trash',
  'companies:delete',
  'profile:read',
];

const ONE: CompanyListItem = {
  id: COMPANY,
  name: 'Alfa Srl',
  vatNumber: '01114601006',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
  status: 'active',
  trashed: false,
};
const TWO: CompanyListItem = {
  id: '665f1c2e9b1d4a0012ab34b9',
  name: 'Beta Srl',
  vatNumber: null,
  city: null,
  province: null,
  country: null,
  status: 'disabled',
  trashed: false,
};
const TRASHED: CompanyListItem = {
  ...ONE,
  id: '665f1c2e9b1d4a0012ab34ba',
  name: 'Gamma Srl',
  trashed: true,
};

function page(data: CompanyListItem[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

async function render(
  url = `/groups/${GROUP}/companies`,
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
          { path: 'groups/:groupId/companies', component: CompaniesList },
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
  const flush = async (data: CompanyListItem[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim()).slice(0, 6);
  const field = (label: string) =>
    root.querySelector<HTMLInputElement | HTMLSelectElement>(
      `#${([...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label) as HTMLLabelElement).htmlFor}`,
    )!;
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
    countries,
    view,
    rows,
    cells,
    field,
    search,
    buttonsOf,
  };
}

afterEach(() => {
  // Tests that do not care about the countries leave their read unanswered.
  for (const request of backend().match(`${API}/v1/countries`)) {
    request.flush(COUNTRIES);
  }
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CompaniesList', () => {
  describe('content', () => {
    it('requests the first page of the companies with the defaults', async () => {
      const { request, countries } = await render();
      const req = request();
      expect(req.request.params.get('limit')).toBe('25');
      expect(req.request.params.get('sort')).toBe('name');
      expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
      req.flush(page([]));
      await countries();
    });

    it('shows one row per company with its data and a link to the detail', async () => {
      const { flush, countries, cells, root } = await render();
      await countries();
      await flush([ONE, TWO, TRASHED]);
      expect(root.querySelector('h1')?.textContent).toBe('COMPANIES.TITLE');
      expect(cells(0)).toEqual([
        'Alfa Srl',
        '01114601006',
        'Milano',
        'MI',
        'IT',
        'COMPANIES.STATUS.ACTIVE',
      ]);
      expect(cells(1)).toEqual(['Beta Srl', '', '', '', '', 'COMPANIES.STATUS.DISABLED']);
      expect(cells(2)[5]).toBe('COMPANIES.STATUS.TRASHED');
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/companies/${COMPANY}`,
      );
    });

    it('explains an empty list and offers to create a company', async () => {
      const { flush, countries, root } = await render();
      await countries();
      await flush([]);
      expect(root.querySelector('fc-empty-state')?.textContent).toContain(
        'COMPANIES.EMPTY_MESSAGE',
      );
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/companies/new`,
      );
      expect(root.querySelector('a.new')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/companies/new`,
      );
    });

    it('does not offer to create without the permission', async () => {
      const { flush, countries, root } = await render(undefined, {
        permissions: ['companies:read'],
      });
      await countries();
      await flush([ONE]);
      expect(root.querySelector('a.new')).toBeNull();
    });

    it('shows a loading table while it reads', async () => {
      const { request, root, countries } = await render();
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      request().flush(page([]));
      await countries();
    });
  });

  describe('filters in the URL', () => {
    it('sends the filters it finds in the URL, and ignores the invalid ones', async () => {
      const valid = await render(
        `/groups/${GROUP}/companies?q=%20alfa%20&status=disabled&trashed=true&country=IT&province=MI&cursor=c1&limit=50&sort=-name`,
      );
      const { params } = valid.request().request;
      expect(params.get('q')).toBe('alfa');
      expect(params.get('status')).toBe('disabled');
      expect(params.get('trashed')).toBe('true');
      expect(params.get('country')).toBe('IT');
      expect(params.get('province')).toBe('MI');
      expect(params.get('cursor')).toBe('c1');
      expect(params.get('limit')).toBe('50');
      expect(params.get('sort')).toBe('-name');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const invalid = await render(
        `/groups/${GROUP}/companies?status=nope&trashed=maybe&country=it&province=12345678901&limit=7&sort=vat`,
      );
      expect(invalid.request().request.params.keys().sort()).toEqual(['limit', 'sort']);
    });

    it('shows the filters of the URL in the controls and the province of the country', async () => {
      const { request, countries, field, view } = await render(
        `/groups/${GROUP}/companies?country=IT&province=RM&q=x&trashed=true`,
      );
      request().flush(page([]));
      await countries();
      await view();
      expect(field('COMPANIES.FILTER.COUNTRY').value).toBe('IT');
      expect(field('COMPANIES.FILTER.PROVINCE').value).toBe('RM');
      expect(field('COMPANIES.FILTER.SEARCH').value).toBe('x');
      expect((field('COMPANIES.FILTER.TRASHED') as HTMLInputElement).checked).toBe(true);
    });

    it('offers the province only for a country that has areas', async () => {
      const { flush, countries, root } = await render(`/groups/${GROUP}/companies?country=FR`);
      await countries();
      await flush([]);
      expect(root.textContent).not.toContain('COMPANIES.FILTER.PROVINCE');
    });

    it('changes the status, the country, the province and the trash in the URL', async () => {
      const { flush, countries, field, search, request, view } = await render();
      await countries();
      await flush([]);
      field('COMPANIES.FILTER.STATUS').value = 'active';
      field('COMPANIES.FILTER.STATUS').dispatchEvent(new Event('change'));
      await view();
      expect(search().get('status')).toBe('active');
      request().flush(page([]));
      await view();
      field('COMPANIES.FILTER.COUNTRY').value = 'IT';
      field('COMPANIES.FILTER.COUNTRY').dispatchEvent(new Event('change'));
      await view();
      expect(search().get('country')).toBe('IT');
      request().flush(page([]));
      await view();
      field('COMPANIES.FILTER.PROVINCE').value = 'RM';
      field('COMPANIES.FILTER.PROVINCE').dispatchEvent(new Event('change'));
      await view();
      expect(search().get('province')).toBe('RM');
      request().flush(page([]));
      await view();
      // A new country drops the province.
      field('COMPANIES.FILTER.COUNTRY').value = 'FR';
      field('COMPANIES.FILTER.COUNTRY').dispatchEvent(new Event('change'));
      await view();
      expect(search().get('country')).toBe('FR');
      expect(search().has('province')).toBe(false);
      request().flush(page([]));
      await view();
      field('COMPANIES.FILTER.COUNTRY').value = '';
      field('COMPANIES.FILTER.COUNTRY').dispatchEvent(new Event('change'));
      await view();
      expect(search().has('country')).toBe(false);
      request().flush(page([]));
      await view();
      field('COMPANIES.FILTER.STATUS').value = '';
      field('COMPANIES.FILTER.STATUS').dispatchEvent(new Event('change'));
      await view();
      expect(search().has('status')).toBe(false);
      request().flush(page([]));
      await view();
      const box = field('COMPANIES.FILTER.TRASHED') as HTMLInputElement;
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
    });

    it('searches after the user stops typing', async () => {
      const { flush, countries, field, search, request, view } = await render();
      await countries();
      await flush([]);
      const input = field('COMPANIES.FILTER.SEARCH');
      input.value = ' alfa ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('q')).toBe('alfa');
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

    it('sorts, changes the page size and pages with the cursor', async () => {
      const { flush, countries, root, search, request, view } = await render();
      await countries();
      await flush([ONE], 'c2');
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
      request().flush(page([TWO]));
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
  });

  describe('row actions', () => {
    it('offers trash on a company and restore and delete on a company in the trash', async () => {
      const { flush, countries, buttonsOf } = await render();
      await countries();
      await flush([ONE, TRASHED]);
      expect(buttonsOf(0)).toEqual(['COMPANIES.ACTION.TRASH']);
      expect(buttonsOf(1)).toEqual(['COMPANIES.ACTION.RESTORE', 'COMPANIES.ACTION.DELETE']);
    });

    it('offers only what the permissions allow', async () => {
      const trashOnly = await render(undefined, {
        permissions: ['companies:read', 'companies:trash'],
      });
      await trashOnly.countries();
      await trashOnly.flush([ONE, TRASHED]);
      expect(trashOnly.buttonsOf(0)).toEqual(['COMPANIES.ACTION.TRASH']);
      expect(trashOnly.buttonsOf(1)).toEqual(['COMPANIES.ACTION.RESTORE']);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const deleteOnly = await render(undefined, {
        permissions: ['companies:read', 'companies:delete'],
      });
      await deleteOnly.countries();
      await deleteOnly.flush([ONE, TRASHED]);
      expect(deleteOnly.buttonsOf(0)).toEqual([]);
      expect(deleteOnly.buttonsOf(1)).toEqual(['COMPANIES.ACTION.DELETE']);
    });

    it('offers no menu to a user who cannot trash or delete', async () => {
      const { flush, countries, rows } = await render(undefined, {
        permissions: ['companies:read'],
      });
      await countries();
      await flush([ONE]);
      expect(rows()[0].querySelector('fc-actions-menu')).toBeNull();
    });

    it('opens the confirmation to delete and restores at once', async () => {
      const { flush, countries, rows, root, view, request } = await render();
      await countries();
      await flush([TRASHED]);
      rows()[0].querySelector<HTMLButtonElement>('td.actions > fc-actions-menu button')!.click();
      await view();
      const [restore, remove] = [
        ...rows()[0].querySelectorAll<HTMLButtonElement>('td.actions .panel button'),
      ];
      remove.click();
      await view();
      expect(root.querySelector('dialog[open]')?.textContent).toContain(
        'COMPANIES.ACTION.CONFIRM.DELETE {"name":"Gamma Srl"}',
      );
      [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
        .find((b) => b.textContent?.trim() === 'COMMON.CANCEL')!
        .click();
      await view();
      restore.click();
      await view();
      backend()
        .expectOne(`${LIST}/${TRASHED.id}`)
        .flush({ data: fakeCompany() }, { headers: { ETag: ETAG } });
      await view();
      backend().expectOne(`${LIST}/${TRASHED.id}/restore`).flush({ data: fakeCompany() });
      await view();
      request().flush(page([]));
      await view();
    });

    it('does not submit the filters form', async () => {
      const { flush, countries, root, view } = await render();
      await countries();
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      await view();
      expect(event.defaultPrevented).toBe(true);
    });

    it('trashes a company with the version of the detail and reloads the list', async () => {
      const { flush, countries, rows, root, view, request } = await render();
      await countries();
      await flush([ONE]);
      const menu = rows()[0].querySelector<HTMLButtonElement>(
        'td.actions > fc-actions-menu button',
      )!;
      menu.click();
      await view();
      rows()[0].querySelector<HTMLButtonElement>('td.actions .panel button')!.click();
      await view();
      [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')]
        .find((b) => b.textContent?.trim() === 'COMPANIES.ACTION.LABEL.TRASH')!
        .click();
      await view();
      backend()
        .expectOne(`${LIST}/${COMPANY}`)
        .flush({ data: fakeCompany() }, { headers: { ETag: ETAG } });
      await view();
      const post = backend().expectOne(`${LIST}/${COMPANY}/trash`);
      expect(post.request.headers.get('If-Match')).toBe(ETAG);
      post.flush({ data: fakeCompany({ trashed: true }) });
      await view();
      request().flush(page([]));
      await view();
    });
  });

  describe('errors and the working group', () => {
    it('shows an error state with the request id and retries', async () => {
      const { request, countries, view, root } = await render();
      request().flush(errorBody('NOT_FOUND'), {
        status: 404,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-9' },
      });
      await countries();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('COMPANIES.LIST_ERROR');
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

    it('adopts the group of the URL once the list loaded, not before', async () => {
      sessionStorage.clear();
      const { request, countries } = await render();
      const groups = TestBed.inject(GroupContext);
      expect(groups.groupId()).toBeNull();
      request().flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await countries();
      expect(groups.groupId()).toBeNull();
      sessionStorage.clear();
    });

    it('does not make the group of the URL the working group', async () => {
      sessionStorage.clear();
      const { countries, flush } = await render();
      await countries();
      await flush([ONE]);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
      sessionStorage.clear();
    });
  });
});
