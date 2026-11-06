import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { DealerRecord } from './dealer.types';
import { DealersList } from './dealers-list';

const LIST = `${API}/v1/dealers`;
const ONE = fakeDealer();
const TWO = fakeDealer({
  id: '665f1c2e9b1d4a0012ab34d2',
  businessName: 'Zeta Spa',
  vatNumber: null,
  address: { street: 's', postcode: 'p', city: 'Roma', province: null, countryCode: 'IT' },
  user: { id: '665f1c2e9b1d4a0012ab34d2', username: 'zeta', status: 'disabled' },
});
const THREE = fakeDealer({
  id: '665f1c2e9b1d4a0012ab34d3',
  businessName: 'Orfano',
  address: null,
  user: null,
});
const ALL = ['dealers:read', 'dealers:create', 'users:create', 'profile:read'];

const page = (data: DealerRecord[], next: string | null = null) => ({
  data,
  page: { limit: 25, next },
});

async function render(url = '/dealers', profile: Partial<Profile> = {}, extra: Provider[] = []) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter([{ path: 'dealers', component: DealersList }], withComponentInputBinding()),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', permissions: ALL, ...profile });
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
  const request = () => backend().expectOne((r) => r.url === LIST);
  const flush = async (data: DealerRecord[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const cells = (row: number) =>
    [...root.querySelectorAll('tbody tr')[row].querySelectorAll('th, td')].map((c) =>
      c.textContent?.trim(),
    );
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  return { root, view, request, flush, cells, search };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('DealersList', () => {
  it('requests the first page sorted by company name', async () => {
    const { request, root } = await render();
    const req = request();
    expect(req.request.params.get('limit')).toBe('25');
    expect(req.request.params.get('sort')).toBe('businessName');
    expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    req.flush(page([]));
  });

  it('shows company, VAT number, city, linked user and status', async () => {
    const { flush, cells, root } = await render();
    await flush([ONE, TWO, THREE]);
    expect(cells(0)).toEqual([
      'Dealer Nord Srl',
      '01234567890',
      'Milano (MI)',
      'dealer.nord',
      'USERS.STATUS.ACTIVE',
    ]);
    expect(cells(1)).toEqual(['Zeta Spa', '', 'Roma', 'zeta', 'USERS.STATUS.DISABLED']);
    expect(cells(2)).toEqual(['Orfano', '01234567890', '', 'DEALERS.NO_USER', '']);
    const links = [...root.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'));
    expect(links.slice(0, 2)).toEqual([`/dealers/${ONE.id}`, `/platform/users/${ONE.user!.id}`]);
    expect(links).toHaveLength(5);
  });

  it('offers "new dealer" only with both creation permissions', async () => {
    const allowed = await render();
    await allowed.flush([]);
    expect(allowed.root.querySelector('a.new')?.getAttribute('href')).toBe('/dealers/new');
    expect(allowed.root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
      '/dealers/new',
    );
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const denied = await render('/dealers', { permissions: ['dealers:read', 'dealers:create'] });
    await denied.flush([]);
    expect(denied.root.querySelector('a.new')).toBeNull();
    expect(denied.root.querySelector('fc-empty-state a')).toBeNull();
  });

  it('reads the search, sort, size and cursor from the URL and ignores invalid values', async () => {
    const { request } = await render(
      '/dealers?q=%20acme%20&sort=-businessName&limit=50&cursor=abc',
    );
    const { params } = request().request;
    expect(Object.fromEntries(params.keys().map((k) => [k, params.get(k)]))).toEqual({
      limit: '50',
      sort: '-businessName',
      q: 'acme',
      cursor: 'abc',
    });
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const bad = await render('/dealers?sort=x&limit=7');
    const sent = bad.request().request.params;
    expect(sent.get('sort')).toBe('businessName');
    expect(sent.get('limit')).toBe('25');
  });

  it('puts the search in the URL once typing pauses, and clears it', async () => {
    const { flush, root, view, search } = await render();
    await flush([]);
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'ac';
    input.dispatchEvent(new Event('input'));
    input.value = 'acme ';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    expect(search().get('q')).toBe('acme');
    await flush([]);
    input.value = ' ';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    expect(search().has('q')).toBe(false);
    await flush([]);
  });

  it('does not reload the page on submit', async () => {
    const { flush, root } = await render();
    await flush([]);
    const event = new Event('submit', { cancelable: true });
    root.querySelector('form')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sorts both ways, changes the page size and walks the pages', async () => {
    const { flush, root, view, search } = await render();
    await flush([ONE], 'c1');
    root.querySelector<HTMLButtonElement>('th button.sort')!.click();
    await view();
    expect(search().get('sort')).toBe('-businessName');
    await flush([ONE], 'c1');
    root.querySelector<HTMLButtonElement>('th button.sort')!.click();
    await view();
    expect(search().get('sort')).toBe('businessName');
    await flush([ONE], 'c1');
    const [previous, next] = [
      ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button'),
    ];
    expect(previous.disabled).toBe(true);
    next.click();
    await view();
    expect(search().get('cursor')).toBe('c1');
    await flush([TWO]);
    previous.click();
    await view();
    expect(search().has('cursor')).toBe(false);
    await flush([ONE], 'c1');
    const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
    select.value = '50';
    select.dispatchEvent(new Event('change'));
    await view();
    expect(search().get('limit')).toBe('50');
    await flush([ONE]);
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
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(state.textContent).toContain('req-3');
    state.querySelector('button')!.click();
    await view();
    request().flush(page([ONE]));
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('reports an unexpected failure generically', async () => {
    const { root, view } = await render('/dealers', {}, [
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});
