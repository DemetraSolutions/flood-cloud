import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ContactGroupList } from './contact-group-list';
import { ContactGroup } from './contact-group.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const PL1 = '665f1c2e9b1d4a0012ab3501';
const PL2 = '665f1c2e9b1d4a0012ab3502';
const ALL = ['contacts:read', 'contacts:write', 'profile:read'];
const LIST = `${API}/v1/groups/${GROUP}/contact-groups`;
const LOOKUP = `${API}/v1/groups/${GROUP}/lookup/price-lists`;

const regulars: ContactGroup = {
  id: '665f1c2e9b1d4a0012ab34c1',
  name: 'Regulars',
  priceListId: PL1,
  discountPercent: 7.5,
  createdAt: null,
  updatedAt: null,
};
const staff: ContactGroup = {
  ...regulars,
  id: '665f1c2e9b1d4a0012ab34c2',
  name: 'Staff',
  priceListId: PL2,
  discountPercent: 30,
};
const plain: ContactGroup = {
  ...regulars,
  id: '665f1c2e9b1d4a0012ab34c3',
  name: 'Plain',
  priceListId: null,
  discountPercent: null,
};

const page = (data: ContactGroup[], next: string | null = null) => ({
  data,
  page: { limit: 25, next },
});

async function render(query = '', profile: Partial<Profile> = {}, extra: Provider[] = []) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/contact-groups', component: ContactGroupList },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/contact-groups${query}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST);
  /** Answers the price lists, if they were asked for and are still pending. */
  const lookup = (
    names: { id: string; name: string }[] | 'fail' = [
      { id: PL1, name: 'Wholesale' },
      { id: PL2, name: 'Staff prices' },
    ],
  ) => {
    for (const req of backend().match((r) => r.url === LOOKUP)) {
      if (names === 'fail') {
        req.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      } else {
        req.flush({ data: names });
      }
    }
  };
  const flush = async (data: ContactGroup[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    lookup();
    await view();
    return req;
  };
  const params = (req: ReturnType<typeof request>) =>
    Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  const cells = (row: number) =>
    [...root.querySelectorAll('tbody tr')[row]!.querySelectorAll('th, td')].map((c) =>
      c.textContent?.trim(),
    );
  const headers = () => [...root.querySelectorAll('thead th')].map((c) => c.textContent?.trim());
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  return { root, view, request, flush, lookup, params, cells, headers, search };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactGroupList', () => {
  afterEach(() => {
    // The names of the price lists are read next to the list: leave no read pending.
    backend()
      .match((r) => r.url === LOOKUP)
      .forEach((req) => req.flush({ data: [] }));
    backend().verify();
  });

  it('requests the first page sorted by name and shows name, price list (by name) and discount', async () => {
    const { request, params, view, root, cells, headers, lookup } = await render();
    const req = request();
    expect(params(req)).toEqual({ limit: '25', sort: 'name' });
    req.flush(page([regulars, staff, plain]));
    lookup([{ id: PL1, name: 'Wholesale' }]);
    await view();
    expect(root.querySelector('h1')?.textContent).toBe('CONTACT_GROUPS.TITLE');
    expect(root.querySelector('.hint')?.textContent).toBe('CONTACT_GROUPS.HINT');
    expect(headers()).toEqual([
      'CONTACT_GROUPS.COLUMN.NAME',
      'CONTACT_GROUPS.COLUMN.PRICE_LIST',
      'CONTACT_GROUPS.COLUMN.DISCOUNT',
    ]);
    expect(cells(0)).toEqual(['Regulars', 'Wholesale', '7,5']);
    expect(cells(1)).toEqual(['Staff', PL2, '30']);
    expect(cells(2)).toEqual(['Plain', '', '']);
    expect([...root.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'))).toEqual([
      `/groups/${GROUP}/contact-groups/${regulars.id}`,
      `/groups/${GROUP}/contact-groups/${staff.id}`,
      `/groups/${GROUP}/contact-groups/${plain.id}`,
    ]);
  });

  it('shows the ids of the price lists when their names cannot be read', async () => {
    const { request, view, cells, lookup } = await render();
    request().flush(page([regulars]));
    lookup('fail');
    await view();
    expect(cells(0)).toEqual(['Regulars', PL1, '7,5']);
  });

  it('reads the filters from the URL', async () => {
    const { request, params, view } = await render(
      '?q=%20reg%20&sort=-updatedAt&limit=50&cursor=abc',
    );
    const req = request();
    expect(params(req)).toEqual({ limit: '50', sort: '-updatedAt', q: 'reg', cursor: 'abc' });
    req.flush(page([]));
    await view();
  });

  it('ignores an invalid sort or page size and a blank search', async () => {
    const { request, params, lookup } = await render('?sort=price&limit=7&q=%20');
    const req = request();
    expect(params(req)).toEqual({ limit: '25', sort: 'name' });
    req.flush(page([]));
    lookup();
  });

  it('accepts the sort by name descending and by date', async () => {
    const byName = await render('?sort=-name');
    expect(byName.params(byName.request())['sort']).toBe('-name');
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const byDate = await render('?sort=updatedAt');
    expect(byDate.params(byDate.request())['sort']).toBe('updatedAt');
  });

  it('sorts by name, both ways', async () => {
    const { flush, root, view, search } = await render();
    await flush([regulars]);
    root.querySelector<HTMLButtonElement>('th button.sort')!.click();
    await view();
    expect(search().get('sort')).toBe('-name');
    await flush([regulars]);
    root.querySelector<HTMLButtonElement>('th button.sort')!.click();
    await view();
    expect(search().get('sort')).toBe('name');
    await flush([regulars]);
  });

  it('offers "new" with contacts:write, in the header and in the empty state', async () => {
    const { flush, root } = await render();
    await flush([]);
    expect(root.querySelector('header a')?.getAttribute('href')).toBe(
      `/groups/${GROUP}/contact-groups/new`,
    );
    expect(root.querySelector('header a')?.textContent).toBe('CONTACT_GROUPS.NEW');
    const empty = root.querySelector('fc-empty-state')!;
    expect(empty.textContent).toContain('CONTACT_GROUPS.EMPTY');
    expect(empty.textContent).toContain('CONTACT_GROUPS.EMPTY_MESSAGE');
    expect(empty.querySelector('a')?.getAttribute('href')).toBe(
      `/groups/${GROUP}/contact-groups/new`,
    );
  });

  it('does not offer "new" without contacts:write', async () => {
    const { flush, root } = await render('', { permissions: ['contacts:read', 'profile:read'] });
    await flush([regulars]);
    expect(root.querySelector('header a')).toBeNull();
    expect(root.querySelector('tbody a')).not.toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const empty = await render('', { permissions: ['contacts:read', 'profile:read'] });
    await empty.flush([]);
    expect(empty.root.querySelector('fc-empty-state a')).toBeNull();
  });

  it('shows the loading state while the page is read', async () => {
    const { root, flush } = await render();
    expect(
      root.querySelector(
        'fc-data-table [aria-busy=true], fc-data-table .skeleton, fc-data-table [role=status]',
      ),
    ).not.toBeNull();
    await flush([]);
    expect(root.querySelector('table')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('puts the search in the URL once typing pauses, and clears it', async () => {
    const { flush, root, view, search } = await render();
    await flush([]);
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'reg ';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    expect(search().get('q')).toBe('reg');
    await flush([]);
    input.value = ' ';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    expect(search().has('q')).toBe(false);
    await flush([]);
    const event = new Event('submit', { cancelable: true });
    root.querySelector('form')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('changes the page size and walks the pages back and forth', async () => {
    const { flush, root, view, search } = await render();
    await flush([regulars], 'c1');
    const [previous, next] = [
      ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button'),
    ];
    expect(previous!.disabled).toBe(true);
    next!.click();
    await view();
    expect(search().get('cursor')).toBe('c1');
    await flush([regulars], 'c2');
    next!.click();
    await view();
    expect(search().get('cursor')).toBe('c2');
    await flush([regulars]);
    previous!.click();
    await view();
    expect(search().get('cursor')).toBe('c1');
    await flush([regulars], 'c2');
    previous!.click();
    await view();
    expect(search().has('cursor')).toBe(false);
    await flush([regulars], 'c1');
    const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
    select.value = '50';
    select.dispatchEvent(new Event('change'));
    await view();
    expect(search().get('limit')).toBe('50');
    await flush([regulars]);
  });

  it('shows the error state with the request id and retries', async () => {
    const { request, view, root, lookup } = await render();
    request().flush(errorBody('INTERNAL_ERROR'), {
      status: 500,
      statusText: 'x',
      headers: { 'X-Request-Id': 'req-3' },
    });
    lookup();
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('CONTACT_GROUPS.LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(state.textContent).toContain('req-3');
    state.querySelector('button')!.click();
    await view();
    request().flush(page([regulars]));
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('reports an unexpected failure generically', async () => {
    const { root, view } = await render('', {}, [
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});
