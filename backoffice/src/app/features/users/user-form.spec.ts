import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { fakeUser } from '../../../testing/users';
import { ApiError } from '../../core/api/api-error';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { GroupContext } from '../../core/groups/group-context';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { emptyMatrix, UserRecord } from './user.types';
import {
  buildCreateBody,
  buildPatch,
  collapseIndexes,
  toUserFormModel,
  UserForm,
  UserFormModel,
} from './user-form';
import { UsersApi } from './users-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const LIST = `${API}/v1/groups/${GROUP}/users`;
const TARGET = fakeUser({ id: '665f1c2e9b1d4a0012ab3401', username: 'luca.bianchi' });
const PLACE = { id: '665f1c2e9b1d4a0012ab34b3', name: 'Negozio Centro', companyId: null };
const COMPANY = { id: '665f1c2e9b1d4a0012ab34b2', name: 'Azienda Uno' };
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

function page(data: object[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Options {
  profile?: Partial<Profile>;
  providers?: import('@angular/core').Provider[];
}

async function render(url: string, options: Options = {}) {
  rendered = true;
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
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
  signIn({ role: 'SA', permissions: WRITE, ...options.profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const fixtureView = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const view = fixtureView;
  const loadUser = async (user: UserRecord | null = TARGET) => {
    const request = backend().expectOne(`${LIST}/${TARGET.id}`);
    if (user === null) {
      request.flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    } else {
      request.flush({ data: user });
    }
    await view();
  };
  const form = () => root.querySelector('form:not(#reset-password-form)')!;
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
  const save = () =>
    root.querySelector<HTMLButtonElement>('form:not(#reset-password-form) button[type=submit]');
  const router = TestBed.inject(Router);
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  const check = async (label: string, checked: boolean) => {
    const box = control(label) as HTMLInputElement;
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const pick = async (name: string) => {
    const label = [...root.querySelectorAll('fc-reference-picker label')].find(
      (l) => l.textContent?.trim() === name,
    )!;
    const box = label.querySelector('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const moduleBox = (module: number, flag: 'r' | 'w') =>
    root.querySelectorAll<HTMLInputElement>('fieldset.module')[module].querySelectorAll('input')[
      flag === 'r' ? 0 : 1
    ];
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
    router,
    toasts,
    check,
    pick,
    moduleBox,
  };
}

let rendered = false;

afterEach(() => {
  if (rendered) {
    // Pickers read their first page as soon as they appear; tests that do not look at it ignore it.
    backend()
      .match((r) => /\/(places|companies)$/.test(r.url))
      .forEach((r) => r.flush(page([])));
    backend().verify();
    rendered = false;
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('toUserFormModel', () => {
  it('uses defaults for a new user and the stored values for an existing one', () => {
    const fresh = toUserFormModel(null, 'PA');
    expect(fresh).toMatchObject({
      username: '',
      role: 'PA',
      language: 'it',
      status: 'active',
      firstName: '',
    });
    const stored = toUserFormModel(fakeUser({ firstName: null, email: null }), 'PA');
    expect(stored).toMatchObject({
      username: 'luca.bianchi',
      role: 'CA',
      firstName: '',
      email: '',
    });
    expect(stored.companyIds).toEqual(TARGET.companyIds);
    expect(stored.permissions.modules.places).toEqual({ r: true, w: true });
  });
});

describe('buildCreateBody', () => {
  const base: UserFormModel = {
    ...toUserFormModel(null, 'PA'),
    username: ' new.user ',
    password: 'Temp-Password-9',
    placeIds: ['p1'],
    companyIds: ['c1'],
  };

  it('sends the mandatory fields and the perimeter of the role, omitting empty text', () => {
    expect(buildCreateBody(base, null)).toEqual({
      username: 'new.user',
      password: 'Temp-Password-9',
      role: 'PA',
      language: 'it',
      status: 'active',
      placeIds: ['p1'],
    });
    expect(buildCreateBody({ ...base, role: 'CA' }, null).companyIds).toEqual(['c1']);
    const sa = buildCreateBody({ ...base, role: 'SA' }, null);
    expect(sa.placeIds).toBeUndefined();
    expect(sa.companyIds).toBeUndefined();
  });

  it('adds the filled text fields trimmed and the whole matrix when given', () => {
    const matrix = emptyMatrix();
    matrix.modules.users.r = true;
    matrix.canManagePermissions = true;
    const body = buildCreateBody({ ...base, firstName: ' Anna ', phone: '123' }, matrix);
    expect(body.firstName).toBe('Anna');
    expect(body.phone).toBe('123');
    expect(body.email).toBeUndefined();
    expect(body.permissions?.canManagePermissions).toBe(true);
    expect(body.permissions?.modules?.users).toEqual({ r: true, w: false });
    expect(Object.keys(body.permissions?.modules ?? {})).toHaveLength(5);
  });
});

describe('buildPatch', () => {
  const same = toUserFormModel(TARGET, 'PA');

  it('is empty without changes or without a user', () => {
    expect(buildPatch(same, TARGET, true)).toEqual({});
    expect(buildPatch(same, null, true)).toEqual({});
  });

  it('includes only what changed, with emptied text as null', () => {
    expect(
      buildPatch(
        {
          ...same,
          username: ' other ',
          firstName: '',
          lastName: 'Neri',
          language: 'en',
          status: 'disabled',
        },
        TARGET,
        true,
      ),
    ).toEqual({
      username: 'other',
      firstName: null,
      lastName: 'Neri',
      language: 'en',
      status: 'disabled',
    });
  });

  it('sends the perimeter when it changes, in any order, or when the role changes', () => {
    const two = fakeUser({ companyIds: ['a', 'b'], placeIds: ['p', 'q'], role: 'CA' });
    const model = toUserFormModel(two, 'CA');
    expect(buildPatch({ ...model, companyIds: ['b', 'a'] }, two, true)).toEqual({});
    expect(buildPatch({ ...model, companyIds: ['a'] }, two, true)).toEqual({ companyIds: ['a'] });
    expect(buildPatch({ ...model, role: 'PA', placeIds: ['p'] }, two, true)).toEqual({
      role: 'PA',
      placeIds: ['p'],
    });
    expect(buildPatch({ ...model, role: 'CA' }, two, true)).toEqual({});
    const places = fakeUser({ role: 'PA', companyIds: [], placeIds: ['p', 'q'] });
    expect(buildPatch({ ...toUserFormModel(places, 'PA'), placeIds: ['p'] }, places, true)).toEqual(
      {
        placeIds: ['p'],
      },
    );
    expect(
      buildPatch({ ...toUserFormModel(places, 'PA'), role: 'CA', companyIds: ['c'] }, places, true),
    ).toEqual({
      role: 'CA',
      companyIds: ['c'],
    });
    expect(buildPatch({ ...model, role: 'SA' }, two, true)).toEqual({ role: 'SA' });
  });

  it('diffs the matrix only when allowed', () => {
    const changed: UserFormModel = structuredClone(same);
    changed.permissions.modules.users.w = true;
    changed.permissions.modules.users.r = false;
    changed.permissions.canManagePermissions = true;
    expect(buildPatch(changed, TARGET, true).permissions).toEqual({
      modules: { users: { r: false, w: true } },
      canManagePermissions: true,
    });
    expect(buildPatch(changed, TARGET, false)).toEqual({});
  });
});

describe('collapseIndexes', () => {
  it('attributes the issues of list items to the list', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'm',
      requestId: 'r1',
      details: [
        { field: 'placeIds.3', issue: 'incorrect' },
        { field: 'username', issue: 'taken' },
      ],
    });
    const collapsed = collapseIndexes(error);
    expect(collapsed.details).toEqual([
      { field: 'placeIds', issue: 'incorrect' },
      { field: 'username', issue: 'taken' },
    ]);
    expect(collapsed.requestId).toBe('r1');
    expect(collapsed.code).toBe('VALIDATION_ERROR');
  });
});

describe('UserForm: creation', () => {
  const NEW = `/groups/${GROUP}/users/new`;

  it('offers the roles the signed-in user can assign and the default permissions note', async () => {
    const { root, control } = await render(NEW);
    expect(root.querySelector('h1')?.textContent).toBe('USERS.FORM.NEW_TITLE');
    expect([...control('USERS.FORM.ROLE').querySelectorAll('option')].map((o) => o.value)).toEqual([
      'SA',
      'CA',
      'PA',
      'E',
    ]);
    expect((control('USERS.FORM.ROLE') as HTMLSelectElement).value).toBe('SA');
    expect(root.querySelector('fc-password-generator')).not.toBeNull();
    expect(root.querySelector('fieldset.matrix > .note')?.textContent).toContain(
      'USERS.FORM.PERMISSIONS_DEFAULT_NOTE',
    );
    expect(
      [...root.querySelectorAll<HTMLInputElement>('fieldset.module input')].every(
        (i) => i.disabled,
      ),
    ).toBe(true);
    expect(root.querySelector('fc-reference-picker')).toBeNull();
  });

  it('shows the default permissions of the role, limited to those of the creator', async () => {
    const { type, moduleBox } = await render(NEW);
    const flags = () =>
      [0, 1, 2, 3, 4].map((m) => [moduleBox(m, 'r').checked, moduleBox(m, 'w').checked]);
    // The creator holds users (all), companies/places (read only), no groups and no log.
    expect(flags()).toEqual([
      [false, false],
      [true, true],
      [true, false],
      [true, false],
      [false, false],
    ]);
    expect(moduleBox(1, 'w').disabled).toBe(true);
    await type('USERS.FORM.ROLE', 'E');
    expect(flags().flat().some(Boolean)).toBe(false);
    await type('USERS.FORM.ROLE', 'CA');
    expect(flags()[1]).toEqual([true, true]);
  });

  it('offers no role to a user who cannot assign any', async () => {
    const { control } = await render(NEW, { profile: { role: 'E' } });
    expect(control('USERS.FORM.ROLE').querySelectorAll('option')).toHaveLength(0);
  });

  it('reports blur on every field without showing errors for valid ones', async () => {
    const { control, root } = await render(NEW);
    for (const label of [
      'USERS.FORM.USERNAME',
      'USERS.FORM.PASSWORD',
      'USERS.FORM.ROLE',
      'PROFILE.FIRST_NAME',
      'PROFILE.LAST_NAME',
      'PROFILE.EMAIL',
      'PROFILE.PHONE',
      'PROFILE.LANGUAGE',
      'USERS.FORM.STATUS',
    ]) {
      control(label).dispatchEvent(new Event('blur'));
    }
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('reports blur on the perimeter pickers', async () => {
    const { type, root, view } = await render(NEW);
    for (const role of ['CA', 'PA']) {
      await type('USERS.FORM.ROLE', role);
      backend()
        .match((r) => /\/(places|companies)$/.test(r.url))
        .forEach((r) => r.flush(page([PLACE])));
      await view();
      root
        .querySelector('fc-reference-picker input[type=checkbox]')!
        .dispatchEvent(new Event('blur'));
    }
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it.each([
    ['PA', ['PA', 'E']],
    ['CA', ['CA', 'PA', 'E']],
    ['PSA', ['SA', 'CA', 'PA', 'E']],
    ['D', ['SA', 'CA', 'PA', 'E']],
  ] as const)('offers the roles of %s', async (role, expected) => {
    const { control } = await render(NEW, { profile: { role } });
    expect([...control('USERS.FORM.ROLE').querySelectorAll('option')].map((o) => o.value)).toEqual(
      expected,
    );
  });

  it('shows the required errors on submit and sends nothing', async () => {
    const { submit, error } = await render(NEW);
    await submit();
    expect(error('USERS.FORM.USERNAME')).toBe('FORM.ISSUE.REQUIRED');
    expect(error('USERS.FORM.PASSWORD')).toBe('FORM.ISSUE.REQUIRED');
  });

  it('validates the username and the password locally', async () => {
    const { type, error, submit } = await render(NEW);
    await type('USERS.FORM.USERNAME', 'a b');
    await submit();
    expect(error('USERS.FORM.USERNAME')).toBe('FORM.ISSUE.PATTERN');
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    await type('USERS.FORM.PASSWORD', 'short');
    expect(error('USERS.FORM.PASSWORD')).toBe('FORM.ISSUE.TOO_SHORT');
    await type('USERS.FORM.PASSWORD', 'x'.repeat(129));
    expect(error('USERS.FORM.PASSWORD')).toBe('FORM.ISSUE.TOO_LONG');
    await type('USERS.FORM.USERNAME', 'long.enough.name');
    await type('USERS.FORM.PASSWORD', 'long.enough.name');
    expect(error('USERS.FORM.PASSWORD')).toBe('FORM.ISSUE.SAME_AS_USERNAME');
    await type('USERS.FORM.PASSWORD', 'Another-Pass-1');
    expect(error('USERS.FORM.PASSWORD')).toBe('');
  });

  it('checks the availability of a valid username once typing pauses', async () => {
    const { type, control, view, root } = await render(NEW);
    const spy = vi.mocked(UsersApi.prototype.isUsernameAvailable);
    await type('USERS.FORM.USERNAME', 'a b');
    await sleep(350);
    expect(spy).not.toHaveBeenCalled();
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    expect(root.textContent).toContain('USERS.FORM.USERNAME_CHECKING');
    await sleep(350);
    await view();
    expect(spy).toHaveBeenCalledWith('luca.rossi');
    expect(root.textContent).toContain('USERS.FORM.USERNAME_AVAILABLE');
    expect(control('USERS.FORM.USERNAME').getAttribute('aria-invalid')).toBeNull();
  });

  it('reports a taken username on the field', async () => {
    const { type, error, view } = await render(NEW);
    vi.mocked(UsersApi.prototype.isUsernameAvailable).mockResolvedValue(false);
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    await sleep(350);
    await view();
    expect(error('USERS.FORM.USERNAME')).toBe('FORM.ISSUE.TAKEN');
  });

  it('says so when the availability cannot be checked, logging without the username', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { type, root, view } = await render(NEW);
    vi.mocked(UsersApi.prototype.isUsernameAvailable).mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'm' }),
    );
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    await sleep(350);
    await view();
    expect(root.textContent).toContain('USERS.FORM.USERNAME_ERROR');
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('luca.rossi');
  });

  it('fills the password with a generated one', async () => {
    const { root, control, view } = await render(NEW);
    root.querySelector<HTMLButtonElement>('fc-password-generator button')!.click();
    await view();
    expect((control('USERS.FORM.PASSWORD') as HTMLInputElement).value).toHaveLength(16);
  });

  it('creates the user with the default permissions and goes back to the list', async () => {
    const { type, submit, router, toasts, view } = await render(NEW);
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
    await type('PROFILE.FIRST_NAME', 'Luca');
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
      firstName: 'Luca',
    });
    request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
    await view();
    await settle();
    expect(toasts()).toEqual(['USERS.FORM.CREATED']);
    expect(router.url).toBe(`/groups/${GROUP}/users`);
  });

  describe('perimeter', () => {
    it('picks the stores of a store administrator, filtered by company', async () => {
      const { type, pick, control, root, view, submit } = await render(NEW);
      await type('USERS.FORM.ROLE', 'PA');
      backend()
        .expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/companies`)
        .flush(page([COMPANY]));
      backend()
        .expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/places`)
        .flush(page([PLACE]));
      await view();
      expect(root.querySelector('fc-reference-picker legend')?.textContent).toBe(
        'USERS.FORM.PLACES',
      );
      expect(
        [...control('USERS.FORM.COMPANY_FILTER').querySelectorAll('option')].map((o) =>
          o.textContent?.trim(),
        ),
      ).toEqual(['USERS.FORM.ALL_COMPANIES', 'Azienda Uno']);
      await type('USERS.FORM.COMPANY_FILTER', COMPANY.id);
      const filtered = backend().expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/places`);
      expect(filtered.request.params.get('companyId')).toBe(COMPANY.id);
      filtered.flush(page([PLACE]));
      await view();
      await submit();
      expect(root.querySelector('fc-reference-picker fieldset > .error')?.textContent).toContain(
        'FORM.ISSUE.REQUIRED',
      );
      await pick(PLACE.name);
      await type('USERS.FORM.USERNAME', 'luca.rossi');
      await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
      await submit();
      await settle();
      const request = backend().expectOne(LIST);
      expect(request.request.body.placeIds).toEqual([PLACE.id]);
      expect(request.request.body.role).toBe('PA');
      request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
      await view();
    });

    it('does not read companies for a store administrator who cannot (no company filter)', async () => {
      const { type, root, view } = await render(NEW, {
        profile: { role: 'PA', permissions: ['users:read', 'users:create', 'places:read'] },
      });
      await type('USERS.FORM.ROLE', 'E');
      backend().expectNone((r) => r.url === `${API}/v1/groups/${GROUP}/companies`);
      backend()
        .expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/places`)
        .flush(page([PLACE]));
      await view();
      expect(root.querySelector('fc-reference-picker')).not.toBeNull();
      expect(root.querySelector('fc-select [id]') && root.textContent).not.toContain(
        'USERS.FORM.COMPANY_FILTER',
      );
    });

    it('picks the companies of a company administrator', async () => {
      const { type, pick, submit, root, view } = await render(NEW);
      await type('USERS.FORM.ROLE', 'CA');
      backend()
        .expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/companies`)
        .flush(page([COMPANY]));
      await view();
      expect(root.querySelector('fc-reference-picker legend')?.textContent).toBe(
        'USERS.FORM.COMPANIES',
      );
      await pick(COMPANY.name);
      await type('USERS.FORM.USERNAME', 'luca.rossi');
      await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
      await submit();
      await settle();
      const request = backend().expectOne(LIST);
      expect(request.request.body.companyIds).toEqual([COMPANY.id]);
      request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
      await view();
    });
  });

  describe('permission matrix', () => {
    it('lets a user who manages permissions choose between defaults and a custom matrix', async () => {
      const { check, moduleBox, root, type, submit, view } = await render(NEW, {
        profile: { canManagePermissions: true },
      });
      expect(moduleBox(0, 'r').disabled).toBe(true);
      await check('USERS.FORM.DEFAULT_PERMISSIONS', false);
      expect(moduleBox(1, 'r').disabled).toBe(false);
      moduleBox(1, 'w').checked = false;
      moduleBox(1, 'w').dispatchEvent(new Event('change'));
      await view();
      await type('USERS.FORM.USERNAME', 'luca.rossi');
      await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
      await submit();
      await settle();
      const request = backend().expectOne(LIST);
      expect(request.request.body.permissions.modules.users).toEqual({ r: true, w: false });
      expect(request.request.body.permissions.canManagePermissions).toBe(false);
      request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
      await view();
      expect(root.querySelector('fieldset.matrix > .note')).toBeNull();
    });
  });

  describe('server errors', () => {
    async function fillAndFail(
      status: number,
      code: string,
      details?: { field: string; issue: string }[],
      url = NEW,
      profile: Partial<Profile> = {},
    ) {
      const ctx = await render(url, { profile });
      await ctx.type('USERS.FORM.USERNAME', 'luca.rossi');
      await ctx.type('USERS.FORM.PASSWORD', 'Temp-Password-9');
      await ctx.submit();
      await settle();
      backend()
        .expectOne(url.startsWith('/platform') ? `${API}/v1/users` : LIST)
        .flush(errorBody(code, details), { status, statusText: 'x' });
      await ctx.view();
      return ctx;
    }

    it('puts a 409 taken username and a 422 password issue on their fields', async () => {
      const { error } = await fillAndFail(409, 'CONFLICT', [
        { field: 'username', issue: 'taken' },
        { field: 'password', issue: 'invalidCharacters' },
      ]);
      expect(error('USERS.FORM.USERNAME')).toBe('FORM.ISSUE.TAKEN');
      expect(error('USERS.FORM.PASSWORD')).toBe('FORM.ISSUE.INVALID_CHARACTERS');
    });

    it('puts an invalid list item on the picker and the rest on the form', async () => {
      const { type, root, view, submit, pick } = await render(NEW);
      await type('USERS.FORM.ROLE', 'PA');
      backend()
        .expectOne((r) => r.url.endsWith('/companies'))
        .flush(page([]));
      backend()
        .expectOne((r) => r.url.endsWith('/places'))
        .flush(page([PLACE]));
      await view();
      await pick(PLACE.name);
      await type('USERS.FORM.USERNAME', 'luca.rossi');
      await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
      await submit();
      await settle();
      backend()
        .expectOne(LIST)
        .flush(
          errorBody('VALIDATION_ERROR', [
            { field: 'placeIds.0', issue: 'incorrect' },
            { field: 'permissions.users', issue: 'unknown' },
          ]),
          { status: 422, statusText: 'x' },
        );
      await view();
      expect(root.querySelector('fc-reference-picker fieldset > .error')?.textContent).toContain(
        'FORM.ISSUE.INCORRECT',
      );
      expect(root.querySelector('fc-form-error')?.textContent).toContain(
        'ERRORS.API.VALIDATION_ERROR',
      );
    });

    it('explains a 403 as a user who cannot be managed', async () => {
      const { root } = await fillAndFail(403, 'FORBIDDEN');
      expect(root.querySelector('fc-form-error')?.textContent).toContain(
        'USERS.FORM'.replace('USERS.FORM', 'USERS.FORBIDDEN_TARGET'),
      );
    });

    it('maps other failures centrally, with or without details', async () => {
      const limited = await fillAndFail(429, 'RATE_LIMITED');
      expect(limited.root.querySelector('fc-form-error')?.textContent).toContain(
        'ERRORS.API.RATE_LIMITED',
      );
    });

    it('shows a conflict without details as a form message', async () => {
      const { root } = await fillAndFail(409, 'CONFLICT');
      expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.CONFLICT');
    });

    it('creates platform users through /v1/users', async () => {
      const { root } = await fillAndFail(409, 'CONFLICT', undefined, '/platform/users/new', {
        role: 'PSA',
        groupId: null,
      });
      expect(root.querySelector('fc-form-error')).not.toBeNull();
    });
  });
});

describe('UserForm: working group', () => {
  const psa = { role: 'PSA' as const, groupId: null, group: null };

  it('does not adopt the group of a new user form before the backend accepted it', async () => {
    sessionStorage.clear();
    await render(`/groups/${GROUP}/users/new`, { profile: psa });
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
  });

  it('adopts the group once the creation succeeded', async () => {
    sessionStorage.clear();
    const { type, submit, view } = await render(`/groups/${GROUP}/users/new`, { profile: psa });
    await type('USERS.FORM.USERNAME', 'luca.rossi');
    await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
    await submit();
    await settle();
    backend().expectOne(LIST).flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
    sessionStorage.clear();
  });

  it('adopts it for an existing user only once the user loaded', async () => {
    sessionStorage.clear();
    const { loadUser } = await render(`/groups/${GROUP}/users/${TARGET.id}`, { profile: psa });
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    await loadUser();
    expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
    sessionStorage.clear();
  });

  it('leaves the working group alone in the platform area', async () => {
    sessionStorage.clear();
    await render('/platform/users/new', { profile: psa });
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
  });
});

describe('UserForm: platform area', () => {
  it('offers platform roles to a PSA and links back to the platform list', async () => {
    const { control, root } = await render('/platform/users/new', {
      profile: { role: 'PSA', groupId: null },
    });
    expect([...control('USERS.FORM.ROLE').querySelectorAll('option')].map((o) => o.value)).toEqual([
      'PSA',
      'D',
    ]);
    expect(root.querySelector('.actions a')?.getAttribute('href')).toBe('/platform/users');
    expect(root.querySelector('fc-reference-picker')).toBeNull();
  });

  it('creates a platform user and returns to the platform list', async () => {
    const { type, submit, view, router } = await render('/platform/users/new', {
      profile: { role: 'PSA', groupId: null },
    });
    await type('USERS.FORM.USERNAME', 'dealer.nord');
    await type('USERS.FORM.PASSWORD', 'Temp-Password-9');
    await submit();
    await settle();
    const request = backend().expectOne(`${API}/v1/users`);
    expect(request.request.body.role).toBe('PSA');
    request.flush({ data: fakeUser({ groupId: null }) }, { status: 201, statusText: 'Created' });
    await view();
    await settle();
    expect(router.url).toBe('/platform/users');
  });
});

describe('UserForm: editing', () => {
  const EDIT = `/groups/${GROUP}/users/${TARGET.id}`;

  it('shows a loading state and then the stored values', async () => {
    const { root, loadUser, control } = await render(EDIT);
    expect(root.textContent).toContain('COMMON.LOADING');
    expect(root.querySelector('form:not(#reset-password-form)')).toBeNull();
    await loadUser();
    expect(root.querySelector('h1')?.textContent).toBe('USERS.FORM.EDIT_TITLE');
    expect((control('USERS.FORM.USERNAME') as HTMLInputElement).value).toBe('luca.bianchi');
    expect((control('PROFILE.FIRST_NAME') as HTMLInputElement).value).toBe('Luca');
    expect((control('USERS.FORM.ROLE') as HTMLSelectElement).value).toBe('CA');
    expect(root.querySelector('form:not(#reset-password-form) fc-password-generator')).toBeNull();
    expect(root.querySelector('.summary fc-status-badge')?.textContent).toContain(
      'USERS.STATUS.ACTIVE',
    );
  });

  it('keeps the save button disabled until something changes, then sends only the change', async () => {
    const { loadUser, save, type, submit, toasts, view } = await render(EDIT);
    await loadUser();
    backend()
      .expectOne((r) => r.url.endsWith('/companies'))
      .flush(page([COMPANY]));
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
  });

  it('does not check the username when it is unchanged, and does when it changes', async () => {
    const { loadUser, type, view } = await render(EDIT);
    await loadUser();
    const spy = vi.mocked(UsersApi.prototype.isUsernameAvailable);
    await sleep(350);
    expect(spy).not.toHaveBeenCalled();
    await type('USERS.FORM.USERNAME', 'luca.neri');
    await sleep(350);
    await view();
    expect(spy).toHaveBeenCalledWith('luca.neri');
    await type('USERS.FORM.USERNAME', 'luca.bianchi');
    await sleep(350);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('keeps the target role in the list even when the user cannot assign it', async () => {
    const { loadUser, control } = await render(EDIT, { profile: { role: 'PA' } });
    await loadUser(fakeUser({ ...TARGET, role: 'SA', companyIds: [] }));
    expect([...control('USERS.FORM.ROLE').querySelectorAll('option')].map((o) => o.value)).toEqual([
      'SA',
      'PA',
      'E',
    ]);
  });

  it('shows a 403 on save as a user that cannot be managed', async () => {
    const { loadUser, type, submit, root, view } = await render(EDIT);
    await loadUser();
    await type('PROFILE.LAST_NAME', 'Neri');
    await submit();
    await settle();
    backend()
      .expectOne(`${LIST}/${TARGET.id}`)
      .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('USERS.FORBIDDEN_TARGET');
  });

  describe('permission matrix', () => {
    it('is read-only with a note for users who cannot manage permissions', async () => {
      const { loadUser, root, moduleBox } = await render(EDIT);
      await loadUser();
      expect(root.querySelector('fieldset.matrix > .note')?.textContent).toContain(
        'USERS.FORM.PERMISSIONS_READONLY',
      );
      expect(moduleBox(3, 'w').disabled).toBe(true);
      expect(moduleBox(3, 'w').checked).toBe(true);
      expect(moduleBox(1, 'r').checked).toBe(true);
    });

    it('is editable for users who manage permissions and sends the difference', async () => {
      const { loadUser, root, moduleBox, check, submit, view } = await render(EDIT, {
        profile: { canManagePermissions: true },
      });
      await loadUser();
      expect(root.querySelector('fieldset.matrix > .note')).toBeNull();
      expect(moduleBox(1, 'w').disabled).toBe(false);
      moduleBox(1, 'w').checked = true;
      moduleBox(1, 'w').dispatchEvent(new Event('change'));
      await view();
      await check('USERS.FORM.CAN_MANAGE', true);
      await submit();
      await settle();
      const request = backend().expectOne(`${LIST}/${TARGET.id}`);
      expect(request.request.body).toEqual({
        permissions: { modules: { users: { w: true } }, canManagePermissions: true },
      });
      request.flush({ data: TARGET });
      await view();
    });
  });

  describe('without the permission or on oneself', () => {
    it('is read-only without users:update', async () => {
      const { loadUser, root, save } = await render(EDIT, {
        profile: { permissions: ['users:read'] },
      });
      await loadUser();
      expect(root.querySelector('.note')?.textContent).toContain('USERS.FORM.READ_ONLY');
      expect(save()).toBeNull();
      expect((root.querySelector('input') as HTMLInputElement).disabled).toBe(true);
      expect(root.querySelector('.actions a')?.textContent).toBe('USERS.FORM.BACK');
      expect(root.querySelector('.actions-bar button')).toBeNull();
    });

    it('does not edit oneself and shows a note', async () => {
      const { loadUser, root, save } = await render(`/groups/${GROUP}/users/${TARGET.id}`, {
        profile: { id: TARGET.id },
      });
      await loadUser();
      expect(root.querySelector('.summary + .note')?.textContent).toContain('USERS.FORM.SELF');
      expect(root.textContent).not.toContain('USERS.FORM.READ_ONLY');
      expect(save()).toBeNull();
      expect(root.querySelector('.actions-bar')).toBeNull();
    });
  });

  describe('load errors', () => {
    it('shows the error with a link back, and retries', async () => {
      const { loadUser, root, view } = await render(EDIT);
      await loadUser(null);
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.NOT_FOUND');
      expect(root.querySelector('p a')?.getAttribute('href')).toBe(`/groups/${GROUP}/users`);
      root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
      await view();
      backend().expectOne(`${LIST}/${TARGET.id}`).flush({ data: TARGET });
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      backend().match((r) => r.url.endsWith('/companies'));
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(EDIT, {
        providers: [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }],
      });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('actions', () => {
    const bar = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLButtonElement>('.actions-bar button')].map((b) =>
        b.textContent?.trim(),
      );

    it('offers the actions of an active user', async () => {
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

    it('offers enabling to a disabled user, and restore and delete to a trashed one', async () => {
      const disabled = await render(EDIT);
      await disabled.loadUser(fakeUser({ ...TARGET, status: 'disabled' }));
      expect(bar(disabled.root)[1]).toBe('USERS.ACTION.ENABLE');
      disabled.root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[1].click();
      await disabled.view();
      expect(document.querySelector('dialog[open] h2')?.textContent).toBe(
        'USER_ACTIONS.TITLE.ENABLE',
      );
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const trashed = await render(EDIT);
      await trashed.loadUser(fakeUser({ ...TARGET, trashed: true }));
      expect(bar(trashed.root)).toEqual(['USERS.ACTION.RESTORE', 'USERS.ACTION.DELETE']);
      for (const [index, heading] of [
        'USER_ACTIONS.TITLE.RESTORE',
        'USER_ACTIONS.TITLE.DELETE',
      ].entries()) {
        trashed.root.querySelectorAll<HTMLButtonElement>('.actions-bar button')[index].click();
        await trashed.view();
        expect(document.querySelector('dialog[open] h2')?.textContent).toBe(heading);
        document.querySelector<HTMLDialogElement>('dialog[open]')!.close();
        await trashed.view();
      }
      expect(trashed.root.querySelector('.summary fc-status-badge')?.textContent).toContain(
        'USERS.STATUS.TRASHED',
      );
    });

    it('shows a disabled user with a warning badge', async () => {
      const { loadUser, root } = await render(EDIT);
      await loadUser(fakeUser({ ...TARGET, status: 'disabled' }));
      expect(root.querySelector('.summary fc-status-badge')?.textContent).toContain(
        'USERS.STATUS.DISABLED',
      );
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
        .querySelectorAll<HTMLDialogElement>('dialog')[2]
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
  });
});
