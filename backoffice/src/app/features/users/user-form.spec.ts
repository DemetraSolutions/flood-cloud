import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { fakeUser } from '../../../testing/users';
import { AppConfig } from '../../core/config/app-config';
import { FEATURE_NAMES, FeatureFlags } from '../../core/groups/feature-catalog';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { AvatarEncoder } from '../../shared/util/avatar-encoder';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { UserForm } from './user-form';
import { UsersApi } from './users-api';
import { UserRecord } from './user.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const LIST = `${API}/v1/groups/${GROUP}/users`;
const TARGET = fakeUser({ id: '665f1c2e9b1d4a0012ab3401', username: 'luca.bianchi' });
const WRITE = [
  'companies:read',
  'places:read',
  'users:read',
  'users:create',
  'users:update',
  'users:trash',
  'users:delete',
  'profile:read',
];
const IMAGE = 'data:image/png;base64,AAAA';

const flags = (on: string[]): FeatureFlags =>
  Object.fromEntries(FEATURE_NAMES.map((name) => [name, on.includes(name)])) as FeatureFlags;

function page(data: object[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

interface Options {
  profile?: Partial<Profile>;
  providers?: import('@angular/core').Provider[];
}

let rendered = false;

async function render(url: string, options: Options = {}) {
  rendered = true;
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: AvatarEncoder, useValue: { encode: async () => IMAGE } },
      ...(options.providers ?? []),
      provideRouter(
        [
          { path: 'groups/:groupId/users/new', component: UserForm },
          { path: 'groups/:groupId/users/:userId', component: UserForm },
          { path: 'platform/users/new', component: UserForm },
          { path: 'platform/users/:userId', component: UserForm },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(UsersApi.prototype, 'isUsernameAvailable').mockResolvedValue(true);
  signIn({
    role: 'SA',
    permissions: WRITE,
    groupFeatures: flags(['cash']),
    ...options.profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const loadUser = async (user: UserRecord | null = TARGET) => {
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    if (user === null) {
      request.flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    } else {
      request.flush({ data: user });
    }
    await view();
  };
  const form = () => root.querySelector('form')!;
  const submit = async () => {
    form().dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const type = async (label: string, value: string) => {
    const control = findControl(scope, label);
    control.value = value;
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const control = (label: string) => findControl(scope, label);
  const error = (label: string) => errorOf(scope, label);
  const save = () => root.querySelector<HTMLButtonElement>('.actions button[type=submit]');
  const check = async (label: string, checked: boolean) => {
    const box = control(label) as HTMLInputElement;
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const tabs = () => [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const tab = (id: string) => root.querySelector<HTMLButtonElement>(`#user-tab-${id}`)!;
  const panel = (id: string) => root.querySelector<HTMLElement>(`#user-panel-${id}`);
  const selected = () => tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.id;
  const key = async (target: HTMLElement, name: string) => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
    await view();
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  return {
    harness,
    root,
    view,
    loadUser,
    form,
    submit,
    type,
    control,
    error,
    save,
    check,
    tabs,
    tab,
    panel,
    selected,
    key,
    router: TestBed.inject(Router),
    toasts,
  };
}

afterEach(() => {
  if (rendered) {
    // Pickers read their first page as soon as they appear; tests that do not look at it ignore it.
    backend()
      .match((r) => /\/(places|companies|lookup\/price-lists|product-favorites)$/.test(r.url))
      .filter((r) => !r.cancelled)
      .forEach((r) => r.flush(page([])));
    // A PSA reads the features of the group of the page.
    backend()
      .match((r) => r.url === `${API}/v1/groups/${GROUP}`)
      .forEach((r) => r.flush({ data: { features: {} } }));
    backend().verify();
    rendered = false;
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const NEW = `/groups/${GROUP}/users/new`;
const EDIT = `/groups/${GROUP}/users/${TARGET.id}`;

describe('UserForm: states', () => {
  it('titles the page for a new and for an existing user', async () => {
    const created = await render(NEW);
    expect(created.root.querySelector('h1')?.textContent).toBe('USERS.FORM.NEW_TITLE');
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const edited = await render(EDIT);
    await edited.loadUser();
    expect(edited.root.querySelector('h1')?.textContent).toBe('USERS.FORM.EDIT_TITLE');
  });

  it('shows a loading state and then the stored values with the summary', async () => {
    const { root, loadUser, control } = await render(EDIT);
    expect(root.querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    expect(root.querySelector('form')).toBeNull();
    await loadUser();
    expect((control('USERS.FORM.USERNAME') as HTMLInputElement).value).toBe('luca.bianchi');
    expect(root.querySelector('.summary strong')?.textContent).toBe('luca.bianchi');
    expect(root.querySelector('.summary fc-status-badge')?.textContent).toContain(
      'USERS.STATUS.ACTIVE',
    );
  });

  it('shows a disabled user with the disabled badge and a trashed one with the trashed badge', async () => {
    const disabled = await render(EDIT);
    await disabled.loadUser(fakeUser({ ...TARGET, status: 'disabled' }));
    expect(disabled.root.querySelector('.summary fc-status-badge')?.textContent).toContain(
      'USERS.STATUS.DISABLED',
    );
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const trashed = await render(EDIT);
    await trashed.loadUser(fakeUser({ ...TARGET, trashed: true }));
    expect(trashed.root.querySelector('.summary fc-status-badge')?.textContent).toContain(
      'USERS.STATUS.TRASHED',
    );
  });

  it('shows the load error with a link to the list, and retries', async () => {
    const { loadUser, root, view } = await render(EDIT);
    await loadUser(null);
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(root.querySelector('p a')?.getAttribute('href')).toBe(`/groups/${GROUP}/users`);
    expect(root.querySelector('form')).toBeNull();
    root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
    await view();
    backend().expectOne(`${LIST}/${TARGET.id}`).flush({ data: TARGET });
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('reports an unexpected load failure generically', async () => {
    const { root, view } = await render(EDIT, {
      providers: [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }],
    });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('links back to the platform list in the platform area', async () => {
    const { root } = await render('/platform/users/new', {
      profile: { role: 'PSA', groupId: null, groupFeatures: null },
    });
    expect(root.querySelector('.actions a')?.getAttribute('href')).toBe('/platform/users');
  });
});

describe('UserForm: summary actions', () => {
  const bar = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLButtonElement>('.actions-bar button')].map((b) =>
      b.textContent?.trim(),
    );

  it('offers reset password, disable and trash for an active user, each with its dialog', async () => {
    const { loadUser, root, view } = await render(EDIT);
    await loadUser();
    expect(bar(root)).toEqual([
      'USERS.ACTION.RESET_PASSWORD',
      'USERS.ACTION.DISABLE',
      'USERS.ACTION.TRASH',
    ]);
    for (const [index, heading] of [
      'USER_ACTIONS.TITLE.RESETPASSWORD',
      'USER_ACTIONS.TITLE.DISABLE',
      'USER_ACTIONS.TITLE.TRASH',
    ].entries()) {
      root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[index].click();
      await view();
      expect(document.querySelector('dialog[open] h2')?.textContent).toBe(heading);
      document.querySelector<HTMLDialogElement>('dialog[open]')!.close();
      await view();
    }
  });

  it('offers enabling to a disabled user', async () => {
    const { loadUser, root, view } = await render(EDIT);
    await loadUser(fakeUser({ ...TARGET, status: 'disabled' }));
    expect(bar(root)[1]).toBe('USERS.ACTION.ENABLE');
    root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[1].click();
    await view();
    expect(document.querySelector('dialog[open] h2')?.textContent).toBe(
      'USER_ACTIONS.TITLE.ENABLE',
    );
  });

  it('offers restore and delete to a trashed user, each with its dialog', async () => {
    const { loadUser, root, view } = await render(EDIT);
    await loadUser(fakeUser({ ...TARGET, trashed: true }));
    expect(bar(root)).toEqual(['USERS.ACTION.RESTORE', 'USERS.ACTION.DELETE']);
    for (const [index, heading] of [
      'USER_ACTIONS.TITLE.RESTORE',
      'USER_ACTIONS.TITLE.DELETE',
    ].entries()) {
      root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[index].click();
      await view();
      expect(document.querySelector('dialog[open] h2')?.textContent).toBe(heading);
      document.querySelector<HTMLDialogElement>('dialog[open]')!.close();
      await view();
    }
  });

  it('hides each action the user lacks the permission for', async () => {
    const update = await render(EDIT, { profile: { permissions: ['users:read', 'users:update'] } });
    await update.loadUser();
    expect(bar(update.root)).toEqual(['USERS.ACTION.RESET_PASSWORD', 'USERS.ACTION.DISABLE']);
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const trash = await render(EDIT, { profile: { permissions: ['users:read', 'users:trash'] } });
    await trash.loadUser(fakeUser({ ...TARGET, trashed: true }));
    expect(bar(trash.root)).toEqual(['USERS.ACTION.RESTORE']);
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const del = await render(EDIT, { profile: { permissions: ['users:read', 'users:delete'] } });
    await del.loadUser(fakeUser({ ...TARGET, trashed: true }));
    expect(bar(del.root)).toEqual(['USERS.ACTION.DELETE']);
  });

  it('reloads the user after an action', async () => {
    const { loadUser, root, view } = await render(EDIT);
    await loadUser();
    root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[2].click();
    await view();
    document
      .querySelector<HTMLDialogElement>('dialog[open] footer')!
      .querySelectorAll('button')[1]
      .click();
    await settle();
    backend()
      .expectOne(`${LIST}/${TARGET.id}/trash`)
      .flush({ data: { ...TARGET, trashed: true } });
    await view();
    backend()
      .expectOne(`${LIST}/${TARGET.id}`)
      .flush({ data: { ...TARGET, trashed: true } });
    await view();
    expect(bar(root)).toEqual(['USERS.ACTION.RESTORE', 'USERS.ACTION.DELETE']);
  });

  it('goes back to the list after deleting for good', async () => {
    const { loadUser, root, view, router } = await render(EDIT);
    await loadUser(fakeUser({ ...TARGET, trashed: true }));
    root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[1].click();
    await view();
    const typed = findControl(
      { nativeElement: root } as never,
      `USER_ACTIONS.TYPE_USERNAME {"username":"luca.bianchi"}`,
    );
    typed.value = 'luca.bianchi';
    typed.dispatchEvent(new Event('input'));
    await view();
    const buttons = document
      .querySelector<HTMLDialogElement>('dialog[open]')!
      .querySelectorAll<HTMLButtonElement>('footer button');
    buttons[1].click();
    await settle();
    backend()
      .expectOne(`${LIST}/${TARGET.id}`)
      .flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await settle();
    expect(router.url).toBe(`/groups/${GROUP}/users`);
  });

  it('shows a note instead of the actions when the user is oneself, and cannot be edited', async () => {
    const { loadUser, root, save } = await render(EDIT, { profile: { id: TARGET.id } });
    await loadUser();
    expect(root.querySelector('.summary + .note')?.textContent).toContain('USERS.FORM.SELF');
    expect(root.querySelector('.actions-bar')).toBeNull();
    expect(root.textContent).not.toContain('USERS.FORM.READ_ONLY');
    expect(save()).toBeNull();
    expect(root.querySelector('.actions a')?.textContent).toBe('USERS.FORM.BACK');
  });

  it('is read-only without users:update', async () => {
    const { loadUser, root, save, control } = await render(EDIT, {
      profile: { permissions: ['users:read', 'companies:read'] },
    });
    await loadUser();
    expect(root.querySelector('.note')?.textContent).toContain('USERS.FORM.READ_ONLY');
    expect(save()).toBeNull();
    expect((control('PROFILE.FIRST_NAME') as HTMLInputElement).disabled).toBe(true);
    expect(root.querySelector('.actions-bar button')).toBeNull();
    expect(root.querySelector('.actions a')?.textContent).toBe('USERS.FORM.BACK');
  });
});

describe('UserForm: tabs', () => {
  const IDS = ['profile', 'access', 'scope', 'permissions', 'pos', 'shifts'];

  it('exposes a tablist with the sections as accessible tabs bound to their panels', async () => {
    const { root, loadUser, tabs, panel, selected } = await render(EDIT);
    await loadUser();
    const list = root.querySelector('[role=tablist]')!;
    expect(list.getAttribute('aria-label')).toBe('USERS.SECTIONS');
    expect(tabs().map((t) => t.textContent?.trim())).toEqual([
      'USERS.SECTION.PROFILE',
      'USERS.SECTION.ACCESS',
      'USERS.SECTION.SCOPE',
      'USERS.SECTION.PERMISSIONS',
      'USERS.SECTION.POS',
      'USERS.SECTION.SHIFTS',
    ]);
    for (const [index, id] of IDS.entries()) {
      const element = tabs()[index];
      expect(element.id).toBe(`user-tab-${id}`);
      expect(element.getAttribute('aria-controls')).toBe(`user-panel-${id}`);
      expect(panel(id)?.getAttribute('role')).toBe('tabpanel');
      expect(panel(id)?.getAttribute('aria-labelledby')).toBe(`user-tab-${id}`);
      expect(element.getAttribute('aria-selected')).toBe(String(id === 'profile'));
      expect(element.tabIndex).toBe(id === 'profile' ? 0 : -1);
      expect(panel(id)?.hidden).toBe(id !== 'profile');
    }
    expect(selected()).toBe('user-tab-profile');
  });

  it('shows the section of the clicked tab', async () => {
    const { loadUser, tab, panel, view, selected } = await render(EDIT);
    await loadUser();
    tab('shifts').click();
    await view();
    expect(selected()).toBe('user-tab-shifts');
    expect(panel('shifts')?.hidden).toBe(false);
    expect(panel('profile')?.hidden).toBe(true);
    expect(tab('shifts').tabIndex).toBe(0);
  });

  it('moves with the arrow keys, wrapping around, and with Home and End, moving the focus', async () => {
    const { loadUser, tab, key, selected } = await render(EDIT);
    await loadUser();
    await key(tab('profile'), 'ArrowRight');
    expect(selected()).toBe('user-tab-access');
    expect(document.activeElement).toBe(tab('access'));
    await key(tab('access'), 'ArrowLeft');
    expect(selected()).toBe('user-tab-profile');
    await key(tab('profile'), 'ArrowLeft');
    expect(selected()).toBe('user-tab-shifts');
    expect(document.activeElement).toBe(tab('shifts'));
    await key(tab('shifts'), 'ArrowRight');
    expect(selected()).toBe('user-tab-profile');
    await key(tab('profile'), 'End');
    expect(selected()).toBe('user-tab-shifts');
    await key(tab('shifts'), 'Home');
    expect(selected()).toBe('user-tab-profile');
    expect(document.activeElement).toBe(tab('profile'));
  });

  it('ignores other keys and lets them through', async () => {
    const { loadUser, tab, view, selected } = await render(EDIT);
    await loadUser();
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    tab('profile').dispatchEvent(event);
    await view();
    expect(event.defaultPrevented).toBe(false);
    expect(selected()).toBe('user-tab-profile');
  });

  it('prevents the default action of the keys it handles', async () => {
    const { loadUser, tab, view } = await render(EDIT);
    await loadUser();
    const event = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    tab('profile').dispatchEvent(event);
    await view();
    expect(event.defaultPrevented).toBe(true);
  });

  it('has the cash section only with the cash feature, for a user with group duties, in a group', async () => {
    const without = await render(EDIT, { profile: { groupFeatures: flags([]) } });
    await without.loadUser();
    expect(without.tabs().map((t) => t.id)).not.toContain('user-tab-pos');
    expect(without.panel('pos')).toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const noDuties = await render(EDIT);
    await noDuties.loadUser(fakeUser({ ...TARGET, role: 'E', companyIds: [], placeIds: [] }));
    expect(noDuties.panel('pos')).toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const platform = await render('/platform/users/new', {
      profile: { role: 'PSA', groupId: null, groupFeatures: null },
    });
    expect(platform.tabs().map((t) => t.id)).toEqual([
      'user-tab-profile',
      'user-tab-access',
      'user-tab-scope',
      'user-tab-permissions',
      'user-tab-shifts',
    ]);
  });

  it.each(['SA', 'CA', 'PA'] as const)('shows the cash section for a %s', async (role) => {
    const { loadUser, panel } = await render(EDIT);
    await loadUser(
      fakeUser({
        ...TARGET,
        role,
        companyIds: role === 'CA' ? TARGET.companyIds : [],
        placeIds: role === 'PA' ? ['665f1c2e9b1d4a0012ab34b3'] : [],
      }),
    );
    expect(panel('pos')).not.toBeNull();
  });

  it('falls back to the first section when the requested one disappears', async () => {
    const { loadUser, tab, panel, view, selected, type } = await render(EDIT);
    await loadUser();
    tab('pos').click();
    await view();
    expect(selected()).toBe('user-tab-pos');
    await type('USERS.FORM.ROLE', 'E');
    expect(panel('pos')).toBeNull();
    expect(selected()).toBe('user-tab-profile');
    expect(panel('profile')?.hidden).toBe(false);
  });
});

describe('UserForm: error badges', () => {
  it('counts the client errors of a section only after the user touched the fields', async () => {
    const { tab, type, control, view } = await render(NEW);
    expect(tab('access').querySelector('fc-status-badge')).toBeNull();
    await type('USERS.FORM.USERNAME', 'a b');
    expect(tab('access').querySelector('fc-status-badge')).toBeNull();
    control('USERS.FORM.USERNAME').dispatchEvent(new Event('blur'));
    await view();
    expect(tab('access').querySelector('fc-status-badge')?.textContent).toContain(
      'USERS.SECTION_ERRORS {"count":1}',
    );
    expect(tab('profile').querySelector('fc-status-badge')).toBeNull();
  });

  it('counts the errors of every field of the sections after a failed submit', async () => {
    const { tab, submit } = await render(NEW);
    await submit();
    expect(tab('access').querySelector('fc-status-badge')?.textContent).toContain(
      'USERS.SECTION_ERRORS {"count":2}',
    );
    expect(tab('scope').querySelector('fc-status-badge')).toBeNull();
  });

  it('counts the errors of the server, which need no touch', async () => {
    const { loadUser, type, submit, tab, view } = await render(EDIT);
    await loadUser();
    await type('PROFILE.LAST_NAME', 'Neri');
    await submit();
    await settle();
    backend()
      .expectOne(`${LIST}/${TARGET.id}`)
      .flush(errorBody('VALIDATION_ERROR', [{ field: 'email', issue: 'invalid' }]), {
        status: 422,
        statusText: 'x',
      });
    await view();
    expect(tab('profile').querySelector('fc-status-badge')?.textContent).toContain(
      'USERS.SECTION_ERRORS {"count":1}',
    );
  });
});

describe('UserForm: creation', () => {
  async function fill(ctx: Awaited<ReturnType<typeof render>>) {
    await ctx.type('USERS.FORM.USERNAME', 'luca.rossi');
    await ctx.type('USERS.FORM.PASSWORD', 'Temp-Password-9');
  }

  it('creates the user with the minimum body, opens its page and adopts the group', async () => {
    const ctx = await render(NEW, { profile: { role: 'PSA', groupId: null, group: null } });
    sessionStorage.clear();
    const { submit, router, toasts, view } = ctx;
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    await fill(ctx);
    await submit();
    await settle();
    const request = backend().expectOne(LIST);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      username: 'luca.rossi',
      password: 'Temp-Password-9',
      role: 'SA',
      language: 'it',
      status: 'active',
    });
    request.flush(
      { data: fakeUser({ id: '665f1c2e9b1d4a0012ab3499' }) },
      { status: 201, statusText: 'Created' },
    );
    await view();
    await settle();
    expect(toasts()).toEqual(['USERS.FORM.CREATED']);
    expect(router.url).toBe(`/groups/${GROUP}/users/665f1c2e9b1d4a0012ab3499`);
    expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
    backend().expectOne(`${LIST}/665f1c2e9b1d4a0012ab3499`).flush({ data: TARGET });
    sessionStorage.clear();
  });

  it('does not adopt the group before the creation succeeded', async () => {
    sessionStorage.clear();
    await render(NEW, { profile: { role: 'PSA', groupId: null, group: null } });
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    sessionStorage.clear();
  });

  it('creates a platform user and opens its page without a group', async () => {
    const ctx = await render('/platform/users/new', {
      profile: { role: 'PSA', groupId: null, groupFeatures: null },
    });
    await fill(ctx);
    await ctx.submit();
    await settle();
    const request = backend().expectOne(`${API}/v1/users`);
    expect(request.request.body.role).toBe('PSA');
    request.flush(
      { data: fakeUser({ id: '665f1c2e9b1d4a0012ab3498', groupId: null }) },
      { status: 201, statusText: 'Created' },
    );
    await ctx.view();
    await settle();
    expect(ctx.router.url).toBe('/platform/users/665f1c2e9b1d4a0012ab3498');
    backend()
      .expectOne(`${API}/v1/users/665f1c2e9b1d4a0012ab3498`)
      .flush({ data: fakeUser({ groupId: null }) });
  });

  it('sends the filled optional data and the shifts, and not the matrix or the POS data', async () => {
    const ctx = await render(NEW);
    await fill(ctx);
    await ctx.type('PROFILE.FIRST_NAME', ' Luca ');
    await ctx.type('PROFILE.EMAIL', 'luca@example.com');
    await ctx.type('USERS.FORM.PIN', '1234');
    await ctx.submit();
    await settle();
    const request = backend().expectOne(LIST);
    expect(request.request.body).toEqual({
      username: 'luca.rossi',
      password: 'Temp-Password-9',
      role: 'SA',
      language: 'it',
      status: 'active',
      firstName: 'Luca',
      email: 'luca@example.com',
      pin: '1234',
    });
    request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
    await ctx.view();
    await settle();
    backend().expectOne(`${LIST}/${fakeUser().id}`).flush({ data: TARGET });
  });

  it('never sends the matrix or the POS data on creation, and explains the defaults', async () => {
    const ctx = await render(NEW, { profile: { canManagePermissions: true } });
    await fill(ctx);
    expect(ctx.tab('permissions')).toBeTruthy();
    ctx.tab('permissions').click();
    await ctx.view();
    expect(ctx.panel('permissions')?.textContent).toContain('USERS.FORM.DEFAULTS_NOTE');
    expect(ctx.panel('permissions')?.querySelector('input[type=checkbox]')).toBeNull();
    ctx.tab('pos').click();
    await ctx.view();
    expect(ctx.panel('pos')?.textContent).toContain('USERS.FORM.DEFAULTS_NOTE');
    expect(ctx.panel('pos')?.querySelector('input[type=checkbox]')).toBeNull();
    await ctx.submit();
    await settle();
    const request = backend().expectOne(LIST);
    expect(request.request.body).not.toHaveProperty('permissions');
    expect(request.request.body).not.toHaveProperty('pos');
    request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
    await ctx.view();
    await settle();
    backend().expectOne(`${LIST}/${fakeUser().id}`).flush({ data: TARGET });
  });

  it('sends the shifts that were set', async () => {
    const ctx = await render(NEW);
    await fill(ctx);
    await ctx.check('USERS.SHIFTS.ENABLED', true);
    await ctx.submit();
    await settle();
    const request = backend().expectOne(LIST);
    expect(request.request.body.shiftTime).toEqual({ enabled: true });
    request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
    await ctx.view();
    await settle();
    backend().expectOne(`${LIST}/${fakeUser().id}`).flush({ data: TARGET });
  });

  it('shows the first section with an error and moves the focus to its first invalid field', async () => {
    const { submit, selected, control, view, tab } = await render(NEW);
    expect(selected()).toBe('user-tab-profile');
    await submit();
    await view();
    expect(selected()).toBe('user-tab-access');
    expect(document.activeElement).toBe(control('USERS.FORM.USERNAME'));
    expect(tab('access').getAttribute('aria-selected')).toBe('true');
    backend().expectNone(LIST);
  });

  it('shows the first section with an error even when another one is open', async () => {
    const { type, submit, selected, view, tab } = await render(NEW);
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
    tab('shifts').click();
    await view();
    await type('USERS.FORM.PIN', 'abc');
    await submit();
    expect(selected()).toBe('user-tab-access');
  });

  it('disables the submit button while the request is pending', async () => {
    const ctx = await render(NEW);
    await fill(ctx);
    await ctx.submit();
    await settle();
    await ctx.view();
    expect(ctx.save()!.disabled).toBe(true);
    backend().expectOne(LIST).flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'x' });
    await ctx.view();
    expect(ctx.save()!.disabled).toBe(false);
  });

  it('keeps the submit label for a creation and offers cancel', async () => {
    const { save, root } = await render(NEW);
    expect(save()!.textContent?.trim()).toBe('USERS.FORM.CREATE');
    expect(root.querySelector('.actions a')?.textContent).toBe('COMMON.CANCEL');
    expect(save()!.disabled).toBe(false);
  });
});

describe('UserForm: editing', () => {
  it('keeps the save button disabled until something changes, then sends only the change', async () => {
    const { loadUser, save, type, submit, toasts, view } = await render(EDIT);
    await loadUser();
    expect(save()!.textContent?.trim()).toBe('COMMON.SAVE');
    expect(save()!.disabled).toBe(true);
    await type('PROFILE.LAST_NAME', 'Neri');
    expect(save()!.disabled).toBe(false);
    await submit();
    await settle();
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ lastName: 'Neri' });
    request.flush({ data: { ...TARGET, lastName: 'Neri' } });
    await view();
    expect(toasts()).toEqual(['USERS.FORM.SAVED']);
    expect(save()!.disabled).toBe(true);
    expect((await Promise.resolve(TestBed.inject(Router))).url).toBe(EDIT);
  });

  it('sends a nested POS permission, with the matrix of the permissions manager', async () => {
    const { loadUser, check, submit, view } = await render(EDIT, {
      profile: { canManagePermissions: true },
    });
    await loadUser();
    await check('USERS.POS.GRANT.DISCOUNT', true);
    await submit();
    await settle();
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    expect(request.request.body).toEqual({ pos: { grants: { discount: true } } });
    request.flush({ data: TARGET });
    await view();
  });

  it('sends a changed shifts switch', async () => {
    const { loadUser, check, submit, view } = await render(EDIT);
    await loadUser();
    await check('USERS.SHIFTS.ENABLED', true);
    await submit();
    await settle();
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    expect(request.request.body).toEqual({ shiftTime: { enabled: true } });
    request.flush({ data: TARGET });
    await view();
  });

  it('sends a new avatar and applies the saved user', async () => {
    const { loadUser, root, submit, view, control } = await render(EDIT);
    await loadUser();
    const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(picker, 'files', {
      configurable: true,
      value: { item: () => new File(['x'], 'a.png', { type: 'image/png' }) },
    });
    picker.dispatchEvent(new Event('change'));
    await view();
    await submit();
    await settle();
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    expect(request.request.body).toEqual({ avatar: IMAGE });
    request.flush({ data: { ...TARGET, avatar: IMAGE, hasAvatar: true } });
    await view();
    expect(root.querySelector('fc-avatar img')?.getAttribute('src')).toBe(IMAGE);
    expect((control('PROFILE.FIRST_NAME') as HTMLInputElement).value).toBe('Luca');
  });

  it('is editable for a permissions manager and sends the matrix difference', async () => {
    const { loadUser, root, check, submit, view } = await render(EDIT, {
      profile: { canManagePermissions: true },
    });
    await loadUser();
    await check('USERS.FORM.CAN_MANAGE', true);
    await submit();
    await settle();
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    expect(request.request.body).toEqual({ permissions: { canManagePermissions: true } });
    request.flush({ data: TARGET });
    await view();
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('does not submit the page form when the PIN dialog is submitted', async () => {
    const { loadUser, root, view } = await render(EDIT);
    await loadUser();
    const open = [...root.querySelectorAll<HTMLButtonElement>('fc-user-pin button')].find(
      (b) => b.textContent?.trim() === 'PIN.SET',
    )!;
    open.click();
    await view();
    const dialogForm = root.querySelector('form#pin-form')!;
    expect(root.querySelector('form')).not.toBe(dialogForm);
    const pageSubmit = vi.fn();
    root.querySelector('form')!.addEventListener('submit', pageSubmit);
    dialogForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await view();
    expect(pageSubmit).not.toHaveBeenCalled();
    backend().expectNone(`${LIST}/${TARGET.id}`);
  });
});

describe('UserForm: server errors', () => {
  const SHIFTED = fakeUser({
    ...TARGET,
    shiftTime: {
      enabled: true,
      weeks: [
        {
          from: null,
          to: null,
          days: Object.fromEntries(
            ['0', '1', '2', '3', '4', '5', '6'].map((k) => [
              k,
              { active: k === '1', slots: k === '1' ? [{ start: '09:00', end: '12:00' }] : [] },
            ]),
          ) as never,
        },
      ],
      specialDays: [],
    },
  });

  async function fail(
    status: number,
    code: string,
    details?: { field: string; issue: string }[],
    options: Options = {},
    user: UserRecord = TARGET,
  ) {
    const ctx = await render(EDIT, options);
    await ctx.loadUser(user);
    await ctx.type('PROFILE.LAST_NAME', 'Neri');
    await ctx.submit();
    await settle();
    backend()
      .expectOne(`${LIST}/${TARGET.id}`)
      .flush(errorBody(code, details), { status, statusText: 'x' });
    await ctx.view();
    return ctx;
  }

  it('puts a 409 taken username on its field', async () => {
    const { error } = await fail(409, 'CONFLICT', [{ field: 'username', issue: 'taken' }]);
    expect(error('USERS.FORM.USERNAME')).toBe('FORM.ISSUE.TAKEN');
  });

  it('puts a 422 on a POS permission, a shift slot and a price list', async () => {
    const { error, root } = await fail(
      422,
      'VALIDATION_ERROR',
      [
        { field: 'pos.grants.discountReason', issue: 'incorrect' },
        { field: 'shiftTime.weeks.0.days.1.slots.0.end', issue: 'incorrect' },
      ],
      { profile: { canManagePermissions: true } },
      SHIFTED,
    );
    expect(error('USERS.POS.GRANT.DISCOUNT_REASON')).toBe('FORM.ISSUE.INCORRECT');
    expect(
      error(`USERS.SHIFTS.SLOT_END ${JSON.stringify({ day: 'USERS.SHIFTS.DAY.1', n: 1 })}`),
    ).toBe('FORM.ISSUE.INCORRECT');
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('puts an issue of a list item on the list picker', async () => {
    const { root } = await fail(422, 'VALIDATION_ERROR', [
      { field: 'companyIds.2', issue: 'incorrect' },
    ]);
    expect(root.querySelector('fc-reference-picker fieldset > .error')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('puts any issue of a price list on the price lists control', async () => {
    const ctx = await render(EDIT);
    const { view, loadUser, type, submit, root } = ctx;
    await loadUser();
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/lookup/price-lists`)
      .flush({ data: [{ id: 'l1', name: 'Listino 1' }] });
    await view();
    await type('PROFILE.LAST_NAME', 'Neri');
    await submit();
    await settle();
    backend()
      .expectOne(`${LIST}/${TARGET.id}`)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'pos.options.priceLists.0.isDefault', issue: 'incorrect' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(root.querySelector('fc-pos-price-lists .error')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
  });

  it('puts a 403 detail on the POS permission field', async () => {
    const { error, root } = await fail(
      403,
      'FORBIDDEN',
      [{ field: 'pos.grants.discount', issue: 'notAllowed' }],
      { profile: { canManagePermissions: true } },
    );
    expect(error('USERS.POS.GRANT.DISCOUNT')).toBe('FORM.ISSUE.NOT_ALLOWED');
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('explains a 403 without details as a user that cannot be managed', async () => {
    const { root } = await fail(403, 'FORBIDDEN');
    expect(root.querySelector('fc-form-error')?.textContent).toContain('USERS.FORBIDDEN_TARGET');
  });

  it('explains a 403 whose details match no field the same way', async () => {
    const { root } = await fail(403, 'FORBIDDEN', [{ field: 'nothing.here', issue: 'notAllowed' }]);
    expect(root.querySelector('fc-form-error')?.textContent).toContain('USERS.FORBIDDEN_TARGET');
  });

  it('shows an unknown field as a generic form message and still marks the known ones', async () => {
    const { root, error } = await fail(422, 'VALIDATION_ERROR', [
      { field: 'unknown.field', issue: 'incorrect' },
      { field: 'username', issue: 'taken' },
    ]);
    expect(root.querySelector('fc-form-error')?.textContent).toContain(
      'ERRORS.API.VALIDATION_ERROR',
    );
    expect(error('USERS.FORM.USERNAME')).toBe('FORM.ISSUE.TAKEN');
  });

  it('uses the central message for an error that carries no field', async () => {
    const { root } = await fail(429, 'RATE_LIMITED');
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.RATE_LIMITED');
  });

  it('uses the central message for a conflict or validation error without details', async () => {
    const { root } = await fail(409, 'CONFLICT');
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.CONFLICT');
  });

  it('reports a failure that is not an API error generically', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = await render(EDIT);
    await ctx.loadUser();
    vi.spyOn(UsersApi.prototype, 'update').mockRejectedValue(new Error('boom'));
    await ctx.type('PROFILE.LAST_NAME', 'Neri');
    await ctx.submit();
    await settle();
    await ctx.view();
    expect(ctx.root.querySelector('fc-form-error')?.textContent).toContain(
      'ERRORS.GENERIC.MESSAGE',
    );
    expect(log).toHaveBeenCalled();
  });

  it('clears the form message on the next attempt', async () => {
    const ctx = await fail(429, 'RATE_LIMITED');
    expect(ctx.root.querySelector('fc-form-error')).not.toBeNull();
    await ctx.submit();
    await settle();
    backend().expectOne(`${LIST}/${TARGET.id}`).flush({ data: TARGET });
    await ctx.view();
    expect(ctx.root.querySelector('fc-form-error')).toBeNull();
  });
});
