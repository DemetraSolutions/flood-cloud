import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { fakeUser } from '../../../testing/users';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { GroupContext } from '../../core/groups/group-context';
import { Profile } from '../../core/session/session.types';
import { UserRecord } from './user.types';
import { UsersList } from './users-list';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const LIST = `${API}/v1/groups/${GROUP}/users`;
const PLATFORM_LIST = `${API}/v1/users`;
const ALL = [
  'users:read',
  'users:create',
  'users:update',
  'users:trash',
  'users:delete',
  'profile:read',
];

const ONE = fakeUser({
  id: '665f1c2e9b1d4a0012ab3401',
  username: 'one',
  firstName: 'Anna',
  lastName: 'Verdi',
});
const TWO = fakeUser({
  id: '665f1c2e9b1d4a0012ab3402',
  username: 'two',
  status: 'disabled',
  firstName: null,
  lastName: null,
  createdAt: null,
});
const TRASHED = fakeUser({ id: '665f1c2e9b1d4a0012ab3403', username: 'three', trashed: true });
const SELF = fakeUser({ id: '665f1c2e9b1d4a0012ab34ce', username: 'me' });

function page(data: UserRecord[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

async function render(
  url = `/groups/${GROUP}/users`,
  profile: Partial<Profile> = {},
  extraProviders: Provider[] = [],
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extraProviders,
      provideRouter(
        [
          { path: 'groups/:groupId/users', component: UsersList },
          { path: 'users', component: UsersList, data: { scope: 'all' } },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const router = TestBed.inject(Router);
  const listUrl = /^\/users/.test(url) ? PLATFORM_LIST : LIST;
  const request = () => backend().expectOne((r) => r.url === listUrl);
  // Not `whenStable()`: a request still pending keeps the application unstable.
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const flush = async (data: UserRecord[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const control = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!;
  const field = (label: string) =>
    root.querySelector<HTMLInputElement | HTMLSelectElement>(
      `#${(control(label) as HTMLLabelElement).htmlFor}`,
    )!;
  const search = (location = router.url) => new URL(location, 'http://x').searchParams;
  const buttonsOf = (index: number) =>
    [...rows()[index].querySelectorAll<HTMLButtonElement>('td.actions .panel button')].map((b) =>
      b.textContent?.trim(),
    );
  return { harness, root, router, request, flush, view, rows, cells, field, search, buttonsOf };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UsersList', () => {
  describe('content', () => {
    it('requests the first page of the group users with the defaults', async () => {
      const { request, root } = await render();
      const req = request();
      expect(req.request.params.get('limit')).toBe('25');
      expect(req.request.params.get('sort')).toBe('username');
      expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      expect(root.querySelector('h1')?.textContent).toBe('USERS.TITLE');
      req.flush(page([]));
    });

    it('shows one row per user with name, role, status badge and dates', async () => {
      const { flush, cells, root } = await render();
      await flush([ONE, TWO, TRASHED]);
      expect(cells(0).slice(1, 5)).toEqual([
        'AVone',
        'Anna Verdi',
        'ROLE_SHORT.CA',
        'USERS.STATUS.ACTIVE',
      ]);
      expect(cells(1).slice(1, 5)).toEqual(['TWtwo', '', 'ROLE_SHORT.CA', 'USERS.STATUS.DISABLED']);
      expect(cells(1)[5]).toBe('');
      expect(cells(0)[5]).toMatch(/2026/);
      expect(cells(2)[4]).toBe('USERS.STATUS.TRASHED');
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/users/${ONE.id}`,
      );
    });

    it('shows the initials of each user and marks, without loading it, an existing image', async () => {
      const { flush, root } = await render();
      const withImage = fakeUser({
        id: '665f1c2e9b1d4a0012ab3404',
        username: 'four',
        firstName: 'Carla',
        lastName: null,
        hasAvatar: true,
      });
      await flush([ONE, TWO, withImage]);
      const avatars = [...root.querySelectorAll<HTMLElement>('tbody fc-avatar')];
      expect(avatars.map((a) => a.textContent?.trim())).toEqual(['AV', 'TW', 'C']);
      expect(avatars.map((a) => a.classList.contains('marked'))).toEqual([false, false, true]);
      expect(avatars.map((a) => a.getAttribute('aria-label'))).toEqual([
        null,
        null,
        'USERS.HAS_AVATAR',
      ]);
      expect(avatars[2].getAttribute('role')).toBe('img');
      expect(root.querySelector('tbody img')).toBeNull();
    });

    it('links the users of the platform to their own pages in the cross-group list', async () => {
      const { flush, root } = await render('/users', { role: 'PSA', groupId: null, group: null });
      const platformUser = fakeUser({ id: '665f1c2e9b1d4a0012ab3499', groupId: null, role: 'D' });
      await flush([platformUser, { ...ONE, groupName: 'Gruppo Uno' }]);
      expect(root.querySelector('h1')?.textContent).toBe('USERS.TITLE');
      expect([...root.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'))).toEqual([
        `/platform/users/${platformUser.id}`,
        `/groups/${GROUP}/settings`,
        `/groups/${GROUP}/users/${ONE.id}`,
      ]);
      expect(root.querySelector('a.new')?.getAttribute('href')).toBe('/platform/users/new');
    });

    it('offers all roles in the platform filter and only group roles in a group', async () => {
      const group = await render();
      await group.flush([]);
      expect([...group.field('USERS.FILTER.ROLE').querySelectorAll('option')]).toHaveLength(5);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const platform = await render('/users', { role: 'PSA', groupId: null, group: null });
      await platform.flush([]);
      expect([...platform.field('USERS.FILTER.ROLE').querySelectorAll('option')]).toHaveLength(7);
    });

    it('has the link to create a user only with the permission', async () => {
      const allowed = await render();
      await allowed.flush([]);
      expect(allowed.root.querySelector('a.new')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/users/new`,
      );
      expect(allowed.root.querySelectorAll('tbody a')).toHaveLength(1);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const denied = await render(undefined, { permissions: ['users:read'] });
      await denied.flush([]);
      expect(denied.root.querySelector('a.new')).toBeNull();
      expect(denied.root.querySelector('tbody a')).toBeNull();
    });

    it('explains an empty list', async () => {
      const { flush, root } = await render();
      await flush([]);
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('USERS.EMPTY_MESSAGE');
    });
  });

  describe('cross-group view', () => {
    const PSA = { role: 'PSA' as const, groupId: null, group: null };
    const OTHER = '665f1c2e9b1d4a0012ab34a9';

    it('lists the users of every group with a group column linking to each group', async () => {
      sessionStorage.clear();
      const { flush, root, cells } = await render('/users', PSA);
      const grouped = fakeUser({
        id: '665f1c2e9b1d4a0012ab3411',
        username: 'g1',
        groupName: 'Gruppo Uno',
      });
      const platformUser = fakeUser({
        id: '665f1c2e9b1d4a0012ab3412',
        username: 'p1',
        groupId: null,
        groupName: null,
        role: 'D',
      });
      await flush([grouped, platformUser]);
      expect(root.querySelector('h1')?.textContent).toBe('USERS.TITLE');
      expect(cells(0)[1]).toBe('Gruppo Uno');
      expect(root.querySelector('tbody td a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/settings`,
      );
      expect(cells(1)[1]).toBe('CROSS_GROUP.NO_NAME');
      expect(root.querySelectorAll('tbody td a')).toHaveLength(1);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });

    it('sends only the paging defaults to /v1/users and shows the one title', async () => {
      const { request, root } = await render('/users', PSA);
      const req = request();
      expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
      expect(root.querySelector('h1')?.textContent).toBe('USERS.TITLE');
      expect(root.querySelector('.hint')).toBeNull();
      req.flush(page([]));
    });

    it('lets a PSA create platform users, also from the empty state', async () => {
      const { flush, root } = await render('/users', PSA);
      await flush([]);
      expect(root.querySelector('a.new')?.getAttribute('href')).toBe('/platform/users/new');
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
        '/platform/users/new',
      );
      expect(root.querySelector('.hint')).toBeNull();
    });

    it('asks a dealer to choose a group first instead of offering to create', async () => {
      const { flush, root } = await render('/users', { ...PSA, role: 'D' });
      await flush([]);
      expect(root.querySelector('a.new')).toBeNull();
      expect(root.querySelector('fc-empty-state a')).toBeNull();
      expect(root.querySelector('.hint')?.textContent).toContain('USERS.CHOOSE_GROUP_TO_CREATE');
    });

    it('does not even hint at creation to a dealer without the permission', async () => {
      const { flush, root } = await render('/users', {
        ...PSA,
        role: 'D',
        permissions: ['users:read'],
      });
      await flush([]);
      expect(root.querySelector('a.new')).toBeNull();
      expect(root.querySelector('.hint')).toBeNull();
    });

    it('hides the creation link from a PSA without the permission', async () => {
      const { flush, root } = await render('/users', { ...PSA, permissions: ['users:read'] });
      await flush([]);
      expect(root.querySelector('a.new')).toBeNull();
    });

    it('sends the group and dealer filters of the URL, for a PSA only and only if valid', async () => {
      const psa = await render(`/users?groupId=${OTHER}&dealerId=${OTHER}`, PSA);
      const { params } = psa.request().request;
      expect(params.get('groupId')).toBe(OTHER);
      expect(params.get('dealerId')).toBe(OTHER);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const dealer = await render(`/users?groupId=${OTHER}&dealerId=${OTHER}`, {
        ...PSA,
        role: 'D',
      });
      const sent = dealer.request().request.params;
      expect(sent.get('groupId')).toBe(OTHER);
      expect(sent.has('dealerId')).toBe(false);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const invalid = await render('/users?groupId=nope&dealerId=nope', PSA);
      expect(invalid.request().request.params.keys().sort()).toEqual(['limit', 'sort']);
    });

    it('offers every role to a PSA and the group roles to a dealer', async () => {
      const psa = await render('/users', PSA);
      await psa.flush([]);
      expect(psa.field('USERS.FILTER.ROLE').querySelectorAll('option')).toHaveLength(7);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const dealer = await render('/users', { ...PSA, role: 'D' });
      await dealer.flush([]);
      expect(dealer.field('USERS.FILTER.ROLE').querySelectorAll('option')).toHaveLength(5);
    });
  });

  describe('one list for every role', () => {
    it.each(['SA', 'CA', 'PA'] as const)(
      'lists a %s the users of the group through the group endpoint only',
      async (role) => {
        const { flush, root, cells, field } = await render(undefined, { role, groupId: GROUP });
        await flush([ONE]);
        expect(root.querySelector('h1')?.textContent).toBe('USERS.TITLE');
        expect(root.querySelector('.hint')).toBeNull();
        expect(cells(0)[1]).toBe('AVone');
        expect(root.querySelectorAll('thead th')).toHaveLength(7);
        expect(field('USERS.FILTER.ROLE').querySelectorAll('option')).toHaveLength(5);
      },
    );

    it.each(['PSA', 'D'] as const)(
      'lists a %s with a group chosen the users of that group, not the cross list',
      async (role) => {
        const ctx = await render(`/groups/${GROUP}/users?role=SA&status=active`, {
          role,
          groupId: null,
          group: null,
        });
        const req = ctx.request();
        expect(req.request.params.get('role')).toBe('SA');
        expect(req.request.params.get('status')).toBe('active');
        expect(req.request.params.has('groupId')).toBe(false);
        req.flush(page([]));
        await ctx.view();
        expect(ctx.root.querySelector('.hint')).toBeNull();
        expect(ctx.root.querySelector('a.new')?.getAttribute('href')).toBe(
          `/groups/${GROUP}/users/new`,
        );
      },
    );

    it('sends every filter of the cross list to /v1/users for a PSA', async () => {
      const { request } = await render(
        '/users?q=%20ann%20&role=PSA&status=disabled&trashed=true&sort=-createdAt&limit=50&cursor=c1',
        { role: 'PSA', groupId: null, group: null },
      );
      const { params } = request().request;
      expect(Object.fromEntries(params.keys().map((k) => [k, params.get(k)]))).toEqual({
        q: 'ann',
        role: 'PSA',
        status: 'disabled',
        trashed: 'true',
        sort: '-createdAt',
        limit: '50',
        cursor: 'c1',
      });
    });

    it('ignores a platform role filter in a group list', async () => {
      const { request } = await render(`/groups/${GROUP}/users?role=PSA`);
      expect(request().request.params.has('role')).toBe(false);
    });
  });

  describe('working group', () => {
    it('is not adopted when the list fails to load', async () => {
      sessionStorage.clear();
      const { request, flush } = await render(undefined, {
        role: 'PSA',
        groupId: null,
        group: null,
      });
      const groups = TestBed.inject(GroupContext);
      expect(groups.groupId()).toBeNull();
      request().flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await settle();
      expect(groups.groupId()).toBeNull();
      sessionStorage.clear();
    });

    it('is never made the working group by opening a list, of a group or of all groups', async () => {
      sessionStorage.clear();
      const group = await render(undefined, { role: 'PSA', groupId: null, group: null });
      await group.flush([ONE]);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
      sessionStorage.clear();
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const platform = await render('/users', { role: 'PSA', groupId: null, group: null });
      await platform.flush([ONE]);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
      sessionStorage.clear();
    });
  });

  describe('errors', () => {
    it('shows an error state with the request id and retries', async () => {
      const { request, view, root } = await render();
      request().flush(errorBody('NOT_FOUND'), {
        status: 404,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-9' },
      });
      await view();
      const state = root.querySelector('fc-error-state')!;
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
  });

  describe('filters and URL', () => {
    it('reads the filters, sort, size and cursor from the URL', async () => {
      const { request } = await render(
        '/groups/' +
          GROUP +
          '/users?q=%20ann%20&role=PA&status=disabled&trashed=true&sort=-lastName&limit=50&cursor=abc',
      );
      const { params } = request().request;
      expect(Object.fromEntries(params.keys().map((k) => [k, params.get(k)]))).toEqual({
        limit: '50',
        sort: '-lastName',
        q: 'ann',
        role: 'PA',
        status: 'disabled',
        trashed: 'true',
        cursor: 'abc',
      });
    });

    it('ignores values that are not in the allowlists', async () => {
      const { request } = await render(
        `/groups/${GROUP}/users?role=PSA&status=x&trashed=false&sort=password&limit=7`,
      );
      const { params } = request().request;
      expect(params.keys().sort()).toEqual(['limit', 'sort']);
      expect(params.get('limit')).toBe('25');
      expect(params.get('sort')).toBe('username');
    });

    it('puts the search text in the URL once the typing pauses, and clears it', async () => {
      const { flush, field, search, router, view } = await render();
      await flush([]);
      const input = field('USERS.FILTER.SEARCH') as HTMLInputElement;
      input.value = 'ro';
      input.dispatchEvent(new Event('input'));
      input.value = 'rossi ';
      input.dispatchEvent(new Event('input'));
      expect(search()).toEqual(new URLSearchParams());
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('q')).toBe('rossi');
      await flush([]);
      input.value = '  ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(router.url).toBe(`/groups/${GROUP}/users`);
      await flush([]);
    });

    it('does not reload the page when the search form is submitted', async () => {
      const { flush, root } = await render();
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form.filters')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('keeps the text typed while the URL catches up', async () => {
      const { flush, field } = await render(`/groups/${GROUP}/users?q=abc`);
      await flush([]);
      expect((field('USERS.FILTER.SEARCH') as HTMLInputElement).value).toBe('abc');
    });

    it.each([
      ['USERS.FILTER.ROLE', 'role', 'SA'],
      ['USERS.FILTER.STATUS', 'status', 'active'],
    ])('filters by %s through the URL and can clear it', async (label, name, value) => {
      const { flush, field, search, view } = await render();
      await flush([]);
      const select = field(label) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get(name)).toBe(value);
      await flush([]);
      select.value = '';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().has(name)).toBe(false);
      await flush([]);
    });

    it('shows the trash with the checkbox', async () => {
      const { flush, field, search, view, root } = await render();
      await flush([]);
      const box = field('USERS.FILTER.TRASHED') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('trashed')).toBe('true');
      await flush([TRASHED]);
      expect(box.checked).toBe(true);
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('trashed')).toBe(false);
      await flush([]);
      expect(root.querySelector('table')).not.toBeNull();
    });

    it('sorts by a column and reverses on the second click', async () => {
      const { flush, root, search, view } = await render();
      await flush([ONE]);
      const header = (name: string) =>
        [...root.querySelectorAll<HTMLButtonElement>('th button.sort')].find((b) =>
          b.textContent?.includes(name),
        )!;
      header('USERS.COLUMN.NAME').click();
      await view();
      expect(search().get('sort')).toBe('lastName');
      await flush([ONE]);
      header('USERS.COLUMN.NAME').click();
      await view();
      expect(search().get('sort')).toBe('-lastName');
      expect(root.querySelector('th[aria-sort=descending]')).not.toBeNull();
      await flush([ONE]);
    });

    it('changes the page size and goes back to the first page', async () => {
      const { flush, root, search, view } = await render(`/groups/${GROUP}/users?cursor=zzz`);
      await flush([ONE]);
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '50';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      expect(search().has('cursor')).toBe(false);
      await flush([ONE]);
    });
  });

  describe('pagination', () => {
    it('walks forward and back with the stack of cursors', async () => {
      const { flush, root, search, view } = await render();
      await flush([ONE], 'c1');
      const [previous, next] = [
        ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator nav .buttons button'),
      ];
      expect(previous.disabled).toBe(true);
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      let req = await flush([TWO], 'c2');
      expect(req.request.params.get('cursor')).toBe('c1');
      expect(previous.disabled).toBe(false);
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([TRASHED]);
      expect(next.disabled).toBe(true);
      previous.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      req = await flush([TWO], 'c2');
      previous.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([ONE], 'c1');
      expect(previous.disabled).toBe(true);
    });

    it('forgets the cursors when a filter changes', async () => {
      const { flush, root, field, view } = await render();
      await flush([ONE], 'c1');
      root
        .querySelectorAll<HTMLButtonElement>('fc-cursor-paginator nav .buttons button')[1]
        .click();
      await view();
      await flush([TWO]);
      const select = field('USERS.FILTER.ROLE') as HTMLSelectElement;
      select.value = 'PA';
      select.dispatchEvent(new Event('change'));
      await view();
      await flush([ONE]);
      expect(
        root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator nav .buttons button')[0]
          .disabled,
      ).toBe(true);
    });
  });

  describe('row actions', () => {
    it('offers the actions of an active and of a disabled user', async () => {
      const { flush, buttonsOf } = await render();
      await flush([ONE, TWO]);
      expect(buttonsOf(0)).toEqual([
        'USERS.ACTION.RESET_PASSWORD',
        'USERS.ACTION.DISABLE',
        'USERS.ACTION.TRASH',
      ]);
      expect(buttonsOf(1)).toEqual([
        'USERS.ACTION.RESET_PASSWORD',
        'USERS.ACTION.ENABLE',
        'USERS.ACTION.TRASH',
      ]);
    });

    it('offers restore and delete for good on a trashed user', async () => {
      const { flush, buttonsOf } = await render();
      await flush([TRASHED]);
      expect(buttonsOf(0)).toEqual(['USERS.ACTION.RESTORE', 'USERS.ACTION.DELETE']);
    });

    it('hides the actions the permissions do not allow', async () => {
      const { flush, buttonsOf } = await render(undefined, {
        permissions: ['users:read', 'users:trash'],
      });
      await flush([ONE, TRASHED]);
      expect(buttonsOf(0)).toEqual(['USERS.ACTION.TRASH']);
      expect(buttonsOf(1)).toEqual(['USERS.ACTION.RESTORE']);
    });

    it('has no selection or actions on the row of the signed-in user', async () => {
      const { flush, rows, buttonsOf } = await render();
      await flush([SELF, ONE]);
      expect(rows()[0].querySelector('input[type=checkbox]')).toBeNull();
      expect(buttonsOf(0)).toEqual([]);
      expect(rows()[1].querySelector('input[type=checkbox]')).not.toBeNull();
    });

    it('runs a row action through its dialog and reloads the list', async () => {
      const { flush, rows, request, view } = await render();
      await flush([ONE]);
      rows()[0].querySelectorAll<HTMLButtonElement>('td.actions .panel button')[2].click();
      await view();
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
      dialog.querySelectorAll<HTMLButtonElement>('footer button')[1].click();
      await settle();
      backend().expectOne(`${LIST}/${ONE.id}/trash`).flush({ data: ONE });
      await view();
      request().flush(page([]));
      await view();
    });

    it.each([
      [1, 'USER_ACTIONS.TITLE.DISABLE'],
      [0, 'USER_ACTIONS.TITLE.RESETPASSWORD'],
    ])('opens the dialog of the action %s', async (index, heading) => {
      const { flush, rows, view } = await render();
      await flush([ONE]);
      rows()[0].querySelectorAll<HTMLButtonElement>('td.actions .panel button')[index].click();
      await view();
      expect(document.querySelector('dialog[open] h2')?.textContent).toBe(heading);
    });

    it('opens the dialog to enable a user, and those for a trashed one', async () => {
      const { flush, rows, view } = await render();
      await flush([TWO, TRASHED]);
      const click = async (row: number, button: number, heading: string) => {
        rows()[row].querySelectorAll<HTMLButtonElement>('td.actions .panel button')[button].click();
        await view();
        expect(document.querySelector('dialog[open] h2')?.textContent).toBe(heading);
        document.querySelector<HTMLDialogElement>('dialog[open]')!.close();
        await view();
      };
      await click(0, 1, 'USER_ACTIONS.TITLE.ENABLE');
      await click(1, 0, 'USER_ACTIONS.TITLE.RESTORE');
      await click(1, 1, 'USER_ACTIONS.TITLE.DELETE');
    });
  });

  describe('selection', () => {
    const tick = async (view: () => Promise<void>, box: HTMLInputElement, checked: boolean) => {
      box.checked = checked;
      box.dispatchEvent(new Event('change'));
      await view();
    };

    it('selects rows and all rows of the page, and reports the count', async () => {
      const { flush, rows, root, view } = await render();
      await flush([SELF, ONE, TWO]);
      const boxes = () => [
        ...root.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]'),
      ];
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
      await tick(view, boxes()[0], true);
      expect(root.querySelector('.bulk [role=status]')?.textContent).toBe(
        'USERS.SELECTED {"count":1}',
      );
      await tick(view, boxes()[0], false);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
      const all = root.querySelector<HTMLInputElement>('.bulk input[type=checkbox]')!;
      await tick(view, all, true);
      expect(boxes().map((b) => b.checked)).toEqual([true, true]);
      expect(all.checked).toBe(true);
      await tick(view, all, false);
      expect(boxes().map((b) => b.checked)).toEqual([false, false]);
      expect(rows()).toHaveLength(3);
    });

    it('has no selection bar when only the signed-in user is listed', async () => {
      const { flush, root } = await render();
      await flush([SELF]);
      expect(root.querySelector('.bulk')).toBeNull();
    });

    it('forgets the selection when the list is reloaded', async () => {
      const { flush, root, view } = await render();
      await flush([ONE]);
      await tick(view, root.querySelector<HTMLInputElement>('tbody input[type=checkbox]')!, true);
      root.querySelector<HTMLButtonElement>('.bulk button')!.click();
      await view();
      document.querySelector<HTMLDialogElement>('dialog[open]')!.close();
      await view();
    });

    it('trashes the selected users after a confirmation, then reloads', async () => {
      const { flush, request, root, view } = await render();
      await flush([ONE, TWO]);
      await tick(view, root.querySelector<HTMLInputElement>('.bulk input[type=checkbox]')!, true);
      const trash = root.querySelector<HTMLButtonElement>('.bulk button')!;
      expect(trash.textContent?.trim()).toBe('USERS.BULK_TRASH');
      trash.click();
      await view();
      document
        .querySelector<HTMLDialogElement>('dialog[open] footer')!
        .querySelectorAll('button')[1]
        .click();
      await settle();
      for (const user of [ONE, TWO]) {
        backend().expectOne(`${LIST}/${user.id}/trash`).flush({ data: user });
        await settle();
      }
      await view();
      request().flush(page([]));
      await view();
      expect(root.querySelector('.bulk')).toBeNull();
    });

    it('restores the selected users from the trash view', async () => {
      const { flush, root, view } = await render(`/groups/${GROUP}/users?trashed=true`);
      await flush([TRASHED]);
      await tick(view, root.querySelector<HTMLInputElement>('tbody input[type=checkbox]')!, true);
      const restore = root.querySelector<HTMLButtonElement>('.bulk button')!;
      expect(restore.textContent?.trim()).toBe('USERS.BULK_RESTORE');
      restore.click();
      await view();
      expect(document.querySelector('dialog[open] .body p')?.textContent).toBe(
        'USER_ACTIONS.CONFIRM.RESTORE {"username":"three"}',
      );
    });

    it('hides the bulk buttons without the trash permission', async () => {
      const { flush, root, view } = await render(undefined, { permissions: ['users:read'] });
      await flush([ONE]);
      await tick(view, root.querySelector<HTMLInputElement>('tbody input[type=checkbox]')!, true);
      expect(root.querySelector('.bulk button')).toBeNull();
    });
  });
});
