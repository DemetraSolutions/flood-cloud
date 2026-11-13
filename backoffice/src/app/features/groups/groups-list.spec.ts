import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { emulateNativeDialog } from '../../../testing/dialog';
import { fakeGroupListItem } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupsList } from './groups-list';
import { GroupListItem } from './group.types';

const LIST = `${API}/v1/groups`;
const DEALERS = `${API}/v1/dealers`;
const DEALER = fakeDealer({ id: '665f1c2e9b1d4a0012ab34d1', businessName: 'Dealer Nord Srl' });
const ONE = fakeGroupListItem({
  dealerId: DEALER.id,
  demo: true,
  counts: {
    companies: { active: 2, trashed: 1 },
    places: { active: 5, trashed: 0 },
    users: { active: 12, trashed: 3 },
  },
});
const TWO = fakeGroupListItem({
  id: '665f1c2e9b1d4a0012ab34a2',
  name: 'Zeta',
  status: 'suspended',
  trashed: true,
  dealerId: '665f1c2e9b1d4a0012ab34ff',
});
const THREE = fakeGroupListItem({ id: '665f1c2e9b1d4a0012ab34a3', name: 'Orfano' });
const PSA_PERMISSIONS = ['groups:read', 'groups:suspend', 'groups:trash', 'dealers:read'];

const page = <T>(data: T[], next: string | null = null) => ({ data, page: { limit: 25, next } });

async function render(
  url = '/groups/list',
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
          { path: 'groups/list', component: GroupsList },
          { path: 'groups/:groupId/settings', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const me = signIn({ role: 'PSA', groupId: null, permissions: PSA_PERMISSIONS, ...profile });
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
  const flush = async (data: GroupListItem[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const flushDealers = async (dealers = [DEALER]) => {
    backend()
      .expectOne((r) => r.url === DEALERS)
      .flush(page(dealers));
    await view();
  };
  const cells = (row: number) =>
    [...root.querySelectorAll('tbody tr')[row].querySelectorAll('th, td:not(.actions)')].map((c) =>
      c.textContent?.trim(),
    );
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const rowButtons = (row: number) => [
    ...root.querySelectorAll<HTMLButtonElement>(
      `tbody tr:nth-child(${row + 1}) td.actions .panel button`,
    ),
  ];
  const select = async (label: string, value: string) => {
    const element = [...root.querySelectorAll('fc-select label')].find(
      (l) => l.textContent?.trim() === label,
    )!;
    const control = root.querySelector<HTMLSelectElement>(
      `#${(element as HTMLLabelElement).htmlFor}`,
    )!;
    control.value = value;
    control.dispatchEvent(new Event('change'));
    await view();
  };
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog')!;
  return {
    me,
    root,
    view,
    request,
    flush,
    flushDealers,
    cells,
    search,
    rowButtons,
    select,
    dialog,
    router: TestBed.inject(Router),
  };
}

function params(req: { request: { params: { keys(): string[]; get(k: string): string | null } } }) {
  const { params: p } = req.request;
  return Object.fromEntries(p.keys().map((k) => [k, p.get(k)]));
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupsList', () => {
  describe('for the platform administrator', () => {
    it('requests the first page by name and the dealers to name them', async () => {
      const { request, root } = await render();
      const dealers = backend().expectOne((r) => r.url === DEALERS);
      expect(params(dealers)).toEqual({ limit: '200', sort: 'businessName' });
      dealers.flush(page([DEALER]));
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'name' });
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      req.flush(page([]));
    });

    it('shows name, dealer, status, demo and trash state', async () => {
      const { flush, flushDealers, cells, root } = await render();
      await flushDealers();
      await flush([ONE, TWO, THREE]);
      expect(cells(0)).toEqual([
        'Gruppo Esempio',
        'Dealer Nord Srl',
        '2GROUPS.COUNT.TRASHED {"count":1}',
        '5',
        '12GROUPS.COUNT.TRASHED {"count":3}',
        'GROUPS.STATUS.ACTIVE',
        'GROUPS.DEMO',
        '',
      ]);
      expect(cells(1)[0]).toBe('Zeta');
      expect(cells(1).slice(5)).toEqual(['GROUPS.STATUS.SUSPENDED', '', 'GROUPS.TRASHED']);
      expect(cells(1)[1]).not.toBe('');
      expect(cells(1)[1]).not.toBe('Dealer Nord Srl');
      expect(cells(2)).toEqual(['Orfano', '', '0', '0', '0', 'GROUPS.STATUS.ACTIVE', '', '']);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${ONE.id}/settings`,
      );
    });

    it('labels each count with its active and trashed numbers', async () => {
      const { flush, flushDealers, root } = await render();
      await flushDealers();
      await flush([ONE, THREE]);
      const labels = (row: number) =>
        [...root.querySelectorAll('tbody tr')[row].querySelectorAll('fc-group-count')].map((c) =>
          c.getAttribute('aria-label'),
        );
      expect(labels(0)).toEqual([
        'GROUPS.COUNT.LABEL_TRASHED {"active":2,"trashed":1}',
        'GROUPS.COUNT.LABEL {"active":5,"trashed":0}',
        'GROUPS.COUNT.LABEL_TRASHED {"active":12,"trashed":3}',
      ]);
      expect(root.querySelector('thead')?.textContent).toContain('GROUPS.COLUMN.COMPANIES');
      expect(root.querySelector('thead')?.textContent).toContain('GROUPS.COLUMN.PLACES');
      expect(root.querySelector('thead')?.textContent).toContain('GROUPS.COLUMN.USERS');
    });

    it('reads the filters, sort, size and cursor from the URL', async () => {
      const { request, flushDealers } = await render(
        `/groups/list?q=%20acme%20&demo=true&status=suspended&trashed=true&dealerId=${DEALER.id}&sort=-name&limit=50&cursor=abc`,
      );
      await flushDealers();
      expect(params(request())).toEqual({
        limit: '50',
        sort: '-name',
        q: 'acme',
        demo: 'true',
        status: 'suspended',
        trashed: 'true',
        dealerId: DEALER.id,
        cursor: 'abc',
      });
    });

    it('accepts demo=false and ignores invalid values', async () => {
      const first = await render('/groups/list?demo=false');
      await first.flushDealers();
      expect(params(first.request())['demo']).toBe('false');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const bad = await render(
        '/groups/list?demo=maybe&status=x&trashed=false&dealerId=nope&sort=x&limit=7',
      );
      await bad.flushDealers();
      expect(params(bad.request())).toEqual({ limit: '25', sort: 'name' });
    });

    it('puts the filters in the URL and shows the first page again', async () => {
      const { flush, flushDealers, root, select, search, view } =
        await render('/groups/list?cursor=c0');
      await flushDealers();
      await flush([ONE]);
      await select('GROUPS.FILTER.DEMO', 'true');
      expect(search().get('demo')).toBe('true');
      expect(search().has('cursor')).toBe(false);
      await flush([ONE]);
      await select('GROUPS.FILTER.STATUS', 'suspended');
      expect(search().get('status')).toBe('suspended');
      await flush([ONE]);
      await select('GROUPS.FILTER.DEALER', DEALER.id);
      expect(search().get('dealerId')).toBe(DEALER.id);
      await flush([ONE]);
      const trashed = root.querySelector<HTMLInputElement>('fc-checkbox input')!;
      trashed.checked = true;
      trashed.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('trashed')).toBe('true');
      await flush([ONE]);
      trashed.checked = false;
      trashed.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('trashed')).toBe(false);
      await flush([ONE]);
      await select('GROUPS.FILTER.DEMO', '');
      expect(search().has('demo')).toBe(false);
      await flush([ONE]);
    });

    it('lists the dealers as filter options', async () => {
      const { flush, flushDealers, root } = await render();
      await flushDealers([
        DEALER,
        fakeDealer({ id: '665f1c2e9b1d4a0012ab34d2', businessName: 'Zeta' }),
      ]);
      await flush([]);
      const labels = [...root.querySelectorAll('fc-select')]
        .find((s) => s.textContent?.includes('GROUPS.FILTER.DEALER'))!
        .querySelectorAll('option');
      expect([...labels].map((o) => o.textContent?.trim())).toEqual([
        'GROUPS.FILTER.ALL',
        'Dealer Nord Srl',
        'Zeta',
      ]);
    });

    it('keeps listing when the dealers cannot be read and shows an abbreviated id', async () => {
      const { flush, cells, view } = await render();
      backend()
        .expectOne((r) => r.url === DEALERS)
        .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
      await view();
      await flush([ONE]);
      expect(cells(0)[1]).not.toBe('');
      expect(cells(0)[1]).not.toBe('Dealer Nord Srl');
    });
  });

  describe('for a dealer', () => {
    const dealer = { role: 'D', permissions: ['groups:read'] } as const;

    it('does not read the dealers and offers neither the dealer column nor the platform filters', async () => {
      const { request, view, root, cells } = await render(
        `/groups/list?status=suspended&trashed=true&dealerId=${DEALER.id}&demo=true`,
        dealer,
      );
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'name', demo: 'true' });
      req.flush(page([ONE]));
      await view();
      expect(cells(0)).toEqual([
        'Gruppo Esempio',
        '2GROUPS.COUNT.TRASHED {"count":1}',
        '5',
        '12GROUPS.COUNT.TRASHED {"count":3}',
        'GROUPS.STATUS.ACTIVE',
        'GROUPS.DEMO',
      ]);
      expect(root.querySelector('fc-checkbox')).toBeNull();
      expect(root.querySelectorAll('form fc-select')).toHaveLength(1);
      expect(root.querySelectorAll('thead th')).toHaveLength(7);
    });

    it('offers only the action to open the record', async () => {
      const { flush, rowButtons } = await render('/groups/list', dealer);
      await flush([ONE, TWO]);
      expect(rowButtons(0)).toHaveLength(1);
      expect(rowButtons(1)).toHaveLength(1);
    });
  });

  it('puts the search in the URL once typing pauses, and clears it', async () => {
    const { flush, flushDealers, root, view, search } = await render();
    await flushDealers();
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
    const { flush, flushDealers, root } = await render();
    await flushDealers();
    await flush([]);
    const event = new Event('submit', { cancelable: true });
    root.querySelector('form')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sorts both ways, changes the page size and walks the pages', async () => {
    const { flush, flushDealers, root, view, search } = await render();
    await flushDealers();
    await flush([ONE], 'c1');
    root.querySelector<HTMLButtonElement>('th button.sort')!.click();
    await view();
    expect(search().get('sort')).toBe('-name');
    await flush([ONE], 'c1');
    root.querySelector<HTMLButtonElement>('th button.sort')!.click();
    await view();
    expect(search().get('sort')).toBe('name');
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
    const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
    size.value = '50';
    size.dispatchEvent(new Event('change'));
    await view();
    expect(search().get('limit')).toBe('50');
    await flush([ONE]);
  });

  it('shows the error state with the request id and retries', async () => {
    const { request, view, root, flushDealers } = await render();
    await flushDealers();
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
    const { root, view } = await render('/groups/list', {}, [
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  describe('row actions', () => {
    it('offers the actions that fit the state of each group', async () => {
      const { flush, flushDealers, rowButtons } = await render();
      await flushDealers();
      await flush([ONE, TWO]);
      const labels = (row: number) => rowButtons(row).map((b) => b.textContent?.trim());
      expect(labels(0)).toEqual([
        'GROUPS.ACTION.OPEN',
        'GROUPS.ACTION.SUSPEND',
        'GROUPS.ACTION.TRASH',
      ]);
      expect(labels(1)).toEqual([
        'GROUPS.ACTION.OPEN',
        'GROUPS.ACTION.REACTIVATE',
        'GROUPS.ACTION.RESTORE',
      ]);
    });

    it('hides the state actions without the permissions', async () => {
      const { flush, flushDealers, rowButtons } = await render('/groups/list', {
        permissions: ['groups:read'],
      });
      await flushDealers();
      await flush([ONE, TWO]);
      expect(rowButtons(0)).toHaveLength(1);
      expect(rowButtons(1)).toHaveLength(1);
    });

    it('lets suspend without trash and the other way round', async () => {
      const onlySuspend = await render('/groups/list', { permissions: ['groups:suspend'] });
      await onlySuspend.flushDealers();
      await onlySuspend.flush([ONE]);
      expect(onlySuspend.rowButtons(0)).toHaveLength(2);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const onlyTrash = await render('/groups/list', { permissions: ['groups:trash'] });
      await onlyTrash.flushDealers();
      await onlyTrash.flush([ONE]);
      expect(onlyTrash.rowButtons(0)).toHaveLength(2);
    });

    it('opens the record: the group becomes the working group and the page opens', async () => {
      const { flush, flushDealers, rowButtons, view, router } = await render();
      await flushDealers();
      await flush([ONE]);
      rowButtons(0)[0].click();
      await view();
      expect(router.url).toBe(`/groups/${ONE.id}/settings`);
      expect(TestBed.inject(GroupContext).groupId()).toBe(ONE.id);
      expect(TestBed.inject(GroupContext).groupName()).toBe(ONE.name);
    });

    it('makes the group the working group when its link is followed', async () => {
      const { flush, flushDealers, root, view, router } = await render();
      await flushDealers();
      await flush([ONE]);
      root.querySelector<HTMLAnchorElement>('tbody a')!.click();
      await view();
      expect(router.url).toBe(`/groups/${ONE.id}/settings`);
      expect(TestBed.inject(GroupContext).groupId()).toBe(ONE.id);
    });

    it.each([
      [0, 1, 'suspend', 'POST', '/suspension'],
      [0, 2, 'trash', 'POST', '/trash'],
      [1, 1, 'reactivate', 'DELETE', '/suspension'],
      [1, 2, 'restore', 'POST', '/restore'],
    ] as const)(
      'row %s button %s: %s confirms, calls the API and reloads the list',
      async (row, button, action, method, path) => {
        const { flush, flushDealers, rowButtons, view, dialog, request } = await render();
        await flushDealers();
        await flush([ONE, TWO]);
        const group = [ONE, TWO][row];
        rowButtons(row)[button].click();
        await view();
        expect(dialog().hasAttribute('open')).toBe(true);
        expect(dialog().textContent).toContain(`GROUP_ACTIONS.CONFIRM.${action.toUpperCase()}`);
        dialog().querySelectorAll<HTMLButtonElement>('footer button')[1].click();
        await settle();
        const call = backend().expectOne(`${LIST}/${group.id}${path}`);
        expect(call.request.method).toBe(method);
        call.flush(null, { status: 204, statusText: 'No Content' });
        await view();
        expect(
          TestBed.inject(ToastService)
            .toasts()
            .map((t) => t.kind),
        ).toEqual(['success']);
        request().flush(page([ONE, TWO]));
        await view();
      },
    );
  });
});
