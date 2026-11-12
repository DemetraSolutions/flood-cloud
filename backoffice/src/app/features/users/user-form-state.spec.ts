import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { API, backend, errorBody, settle } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import {
  adminProfile,
  configureForState,
  createWithState,
  GROUP,
  StateOptions,
  storedUser,
  USER_ADMIN_PERMISSIONS,
  USER_ID,
} from '../../../testing/user-form-state';
import { fakePos } from '../../../testing/users';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { Profile } from '../../core/session/session.types';
import { UserRecord } from './user.types';
import { UserFormState } from './user-form-state';
import { UserFormModel } from './user-model';

@Component({ template: '', providers: [UserFormState] })
class Host {
  readonly state = inject(UserFormState);
}

const USER_URL = `${API}/v1/groups/${GROUP}/users/${USER_ID}`;
const PAGE = { limit: 100, next: null };

interface Setup extends StateOptions {
  /** Stored user returned by the server; `undefined` creates (no request). */
  user?: UserRecord;
  profile?: Partial<Profile>;
}

function setup(options: Setup = {}) {
  configureForState(options);
  const created = createWithState(Host, {
    ...options,
    userId: options.user === undefined ? options.userId : options.user.id,
  });
  const { state } = created;
  const load = async (user = options.user) => {
    TestBed.tick();
    if (user !== undefined) {
      backend().expectOne(USER_URL).flush({ data: user });
    }
    await settle();
    TestBed.tick();
  };
  return { ...created, load };
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

/** Sets the model of the form, as the sections do by typing. */
function update(state: UserFormState, change: (model: Mutable<UserFormModel>) => void): void {
  state.model.update((model) => {
    const copy = structuredClone(model) as Mutable<UserFormModel>;
    change(copy);
    return copy as UserFormModel;
  });
}

beforeEach(() => sessionStorage.clear());

afterEach(() => {
  backend().match(() => true);
  vi.restoreAllMocks();
});

describe('UserFormState: loading', () => {
  it('describes the platform area and a user being created', async () => {
    const { state, load } = setup({ groupId: null, profile: { role: 'PSA', groupId: null } });
    await load();
    expect(state.area()).toEqual({ kind: 'platform' });
    expect(state.isNew()).toBe(true);
    expect(state.user()).toBeNull();
    expect(state.loading()).toBe(false);
    expect(state.failed()).toBe(false);
    expect(state.loadError()).toBeNull();
    expect(state.loadErrorMessage()).toBe('ERRORS.GENERIC.MESSAGE');
    expect(state.roles()).toEqual(['PSA', 'D']);
    expect(state.model().role).toBe('PSA');
    expect(state.roleOptions()).toEqual([
      { value: 'PSA', label: 'ROLE.PSA' },
      { value: 'D', label: 'ROLE.D' },
    ]);
    expect(state.statusOptions().map((option) => option.value)).toEqual(['active', 'disabled']);
    expect(state.statusOptions()[0].label).toBe('USERS.STATUS.ACTIVE');
    expect(state.languages.length).toBeGreaterThan(0);
    expect(state.hasChanges()).toBe(true);
    backend().verify();
  });

  it('reads the stored user of the group and exposes it', async () => {
    const user = storedUser({ pinSet: true });
    const { state, load } = setup({ user });
    TestBed.tick();
    expect(state.isNew()).toBe(false);
    expect(state.loading()).toBe(true);
    await load();
    expect(state.area()).toEqual({ kind: 'group', groupId: GROUP });
    expect(state.groupId()).toBe(GROUP);
    expect(state.userId()).toBe(USER_ID);
    expect(state.user()?.username).toBe(user.username);
    expect(state.loading()).toBe(false);
    expect(state.pinSet()).toBe(true);
    expect(state.model().username).toBe(user.username);
    expect(state.baseline().username).toBe(user.username);
    expect(state.hasChanges()).toBe(false);
    expect(state.patch()).toEqual({});
  });

  it('reports a failed read with the backend error', async () => {
    const { state } = setup({ userId: USER_ID });
    TestBed.tick();
    backend().expectOne(USER_URL).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await settle();
    TestBed.tick();
    expect(state.failed()).toBe(true);
    expect(state.user()).toBeNull();
    expect(state.loadError()).toBeInstanceOf(ApiError);
    expect(state.loadErrorMessage()).toBe('ERRORS.API.NOT_FOUND');
    expect(state.loading()).toBe(false);
  });

  it('falls back to the generic message for an error that is not an ApiError', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    signIn(adminProfile());
    const { state } = createWithState(Host, { userId: USER_ID });
    TestBed.tick();
    backend()
      .expectOne(`/v1/groups/${GROUP}/users/${USER_ID}`)
      .flush('boom', { status: 500, statusText: 'x' });
    await settle();
    TestBed.tick();
    expect(state.failed()).toBe(true);
    expect(state.loadError()).toBeNull();
    expect(state.loadErrorMessage()).toBe('ERRORS.GENERIC.MESSAGE');
  });

  it('reads the user again on reload', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    state.reload();
    TestBed.tick();
    backend()
      .expectOne(USER_URL)
      .flush({ data: storedUser({ firstName: 'Nuovo' }) });
    await settle();
    expect(state.user()?.firstName).toBe('Nuovo');
  });

  it('takes a user returned by the server as the stored one', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    state.apply(storedUser({ firstName: 'Saved', pinSet: true }));
    expect(state.user()?.firstName).toBe('Saved');
    expect(state.model().firstName).toBe('Saved');
    expect(state.pinSet()).toBe(true);
    state.pinSet.set(false);
    expect(state.pinSet()).toBe(false);
  });

  it('shows no PIN for a user being created', () => {
    const { state } = setup();
    expect(state.pinSet()).toBe(false);
  });
});

describe('UserFormState: actor', () => {
  it('lets an actor with the permission write another user, never themselves', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    expect(state.canWrite()).toBe(true);
    expect(state.isSelf()).toBe(false);
    expect(state.actorRole()).toBe('SA');
    expect(state.canManagePermissions()).toBe(true);
    expect(state.canReadCompanies()).toBe(true);
  });

  it('treats the signed-in user as read only', async () => {
    const me = '665f1c2e9b1d4a0012ab34ce';
    const { state, load } = setup({
      user: storedUser({ id: me }),
      profile: adminProfile({ id: me }),
    });
    // The URL id is the stored one: serve the same user for it.
    TestBed.tick();
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/users/${me}`)
      .flush({ data: storedUser({ id: me }) });
    await settle();
    TestBed.tick();
    expect(state.isSelf()).toBe(true);
    expect(state.canWrite()).toBe(false);
    expect(state.userForm().disabled()).toBe(true);
  });

  it('needs users:create to create and users:update to edit', async () => {
    const lacking = setup({ profile: adminProfile({ permissions: ['users:update'] }) });
    expect(lacking.state.canWrite()).toBe(false);
    expect(lacking.state.canReadCompanies()).toBe(false);
    expect(lacking.state.userForm().disabled()).toBe(true);
  });

  it('lets users:create alone create', () => {
    const creating = setup({ profile: adminProfile({ permissions: ['users:create'] }) });
    expect(creating.state.canWrite()).toBe(true);
  });

  it('adds the current role of the user when the actor cannot assign it', async () => {
    const { state, load } = setup({
      user: storedUser({ role: 'SA' }),
      profile: adminProfile({ role: 'CA' }),
    });
    await load();
    expect(state.roles()).toEqual(['SA', 'CA', 'PA', 'E']);
    expect(state.roleOptions()[0]).toEqual({ value: 'SA', label: 'ROLE.SA' });
  });

  it('does not repeat a role the actor can assign', async () => {
    const { state, load } = setup({ user: storedUser({ role: 'PA' }) });
    await load();
    expect(state.roles()).toEqual(['SA', 'CA', 'PA', 'E']);
    expect(state.role()).toBe('PA');
    expect(state.scopeKind()).toBe('places');
  });

  it('has no role to propose when the actor cannot assign any', () => {
    const { state } = setup({
      profile: adminProfile({ role: 'E', permissions: ['users:create'] }),
    });
    expect(state.roles()).toEqual([]);
    expect(state.model().role).toBe('');
  });

  it('proposes the first assignable role to a new user', () => {
    const { state } = setup();
    expect(state.model().role).toBe('SA');
    expect(state.scopeKind()).toBe('none');
  });
});

describe('UserFormState: permission matrix', () => {
  it('fixes the matrix of PSA and D, which is never editable', async () => {
    const { state } = setup({
      user: storedUser({ role: 'D', groupId: null }),
      profile: {
        role: 'PSA',
        groupId: null,
        permissions: USER_ADMIN_PERMISSIONS,
        canManagePermissions: true,
      },
      groupId: null,
    });
    TestBed.tick();
    backend()
      .expectOne(`${API}/v1/users/${USER_ID}`)
      .flush({ data: storedUser({ role: 'D', groupId: null }) });
    await settle();
    TestBed.tick();
    expect(state.fixedPermissions()).toBe(true);
    expect(state.matrixEditable()).toBe(false);
    expect(state.userForm.permissions().disabled()).toBe(true);
  });

  it('edits the matrix of an existing user when the actor manages permissions', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    expect(state.fixedPermissions()).toBe(false);
    expect(state.matrixEditable()).toBe(true);
    expect(state.userForm.permissions().disabled()).toBe(false);
    expect(state.writeScope()).toEqual({
      matrix: true,
      pos: true,
      posPermissions: true,
      services: true,
    });
  });

  it('does not edit the matrix without the right to manage permissions', async () => {
    const { state, load } = setup({
      user: storedUser(),
      profile: adminProfile({ canManagePermissions: false }),
    });
    await load();
    expect(state.matrixEditable()).toBe(false);
    expect(state.writeScope().matrix).toBe(false);
    expect(state.writeScope().posPermissions).toBe(false);
  });

  it('never edits the matrix when creating, whatever the actor can do', () => {
    const { state } = setup();
    expect(state.canManagePermissions()).toBe(true);
    expect(state.matrixEditable()).toBe(false);
    expect(state.writeScope().matrix).toBe(false);
  });

  it('disables the flags the actor cannot give', async () => {
    const { state, load } = setup({
      user: storedUser(),
      profile: adminProfile({ role: 'CA', permissions: ['users:update', 'users:read'] }),
    });
    await load();
    // The actor holds users:read but not users:write: the read flag is open, the write one is not.
    expect(state.canGiveModule('users', 'r')).toBe(true);
    expect(state.canGiveModule('users', 'w')).toBe(false);
    expect(state.userForm.permissions.modules.users.r().disabled()).toBe(false);
    expect(state.userForm.permissions.modules.users.w().disabled()).toBe(true);
    // Modules the client cannot check are left to the server.
    expect(state.canGiveModule('stats', 'w')).toBe(true);
  });

  it('always allows a flag the user already has', async () => {
    const { state, load } = setup({
      user: storedUser({
        permissions: { modules: { groups: { r: true, w: true } }, canManagePermissions: false },
      }),
      profile: adminProfile({ role: 'CA', permissions: ['users:update'] }),
    });
    await load();
    expect(state.canGiveModule('groups', 'w')).toBe(true);
  });
});

describe('UserFormState: sections that depend on the group', () => {
  it('applies services and POS to SA, CA and PA of a group with the features', async () => {
    const { state, load } = setup({ user: storedUser({ role: 'CA' }) });
    await load();
    expect(state.servicesApply()).toBe(true);
    expect(state.posApplies()).toBe(true);
    expect(state.sections()).toEqual([
      'profile',
      'access',
      'scope',
      'permissions',
      'pos',
      'shifts',
    ]);
  });

  it('hides them for the other roles', async () => {
    const { state, load } = setup({ user: storedUser({ role: 'E' }) });
    await load();
    expect(state.servicesApply()).toBe(false);
    expect(state.posApplies()).toBe(false);
    expect(state.sections()).toEqual(['profile', 'access', 'scope', 'permissions', 'shifts']);
  });

  it('hides them when the group lacks the features', async () => {
    const { state, load } = setup({
      user: storedUser(),
      profile: adminProfile({ groupFeatures: fakeFeatureFlags(false) }),
    });
    await load();
    expect(state.servicesApply()).toBe(false);
    expect(state.posApplies()).toBe(false);
  });

  it('hides them in the platform area', () => {
    const { state } = setup({
      groupId: null,
      profile: { role: 'PSA', groupId: null, permissions: ['users:create'] },
    });
    expect(state.servicesApply()).toBe(false);
    expect(state.posApplies()).toBe(false);
  });

  it('never edits the POS of a new user, whatever the actor can do', () => {
    const { state } = setup();
    expect(state.posApplies()).toBe(true);
    expect(state.posGrantsEditable()).toBe(false);
    expect(state.posOptionsEditable()).toBe(false);
    expect(state.writeScope().posPermissions).toBe(false);
  });

  it('edits the POS permissions only with the right to manage permissions', async () => {
    const { state, load } = setup({
      user: storedUser(),
      profile: adminProfile({ canManagePermissions: false }),
    });
    await load();
    expect(state.posOptionsEditable()).toBe(true);
    expect(state.posGrantsEditable()).toBe(false);
    expect(state.userForm.pos.options.side().disabled()).toBe(false);
    expect(state.userForm.pos.grants.discount().disabled()).toBe(true);
    expect(state.userForm.pos.enabled().disabled()).toBe(true);
  });

  it('disables the POS options when the POS does not apply', async () => {
    const { state, load } = setup({
      user: storedUser({ role: 'E' }),
    });
    await load();
    expect(state.userForm.pos.options.side().disabled()).toBe(true);
  });
});

describe('UserFormState: POS help rules', () => {
  it('lets SA give any flag, device flag and the POS switch', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    expect(state.discountCap()).toBeNull();
    expect(state.canGiveFlag('discount')).toBe(true);
    expect(state.canGiveAutomatic('glory', 'deposit')).toBe(true);
    expect(state.canEnablePos()).toBe(true);
    expect(state.userForm.pos.enabled().disabled()).toBe(false);
    expect(state.userForm.pos.grants.discount().disabled()).toBe(false);
    expect(state.userForm.pos.grants.automaticCash.glory.deposit().disabled()).toBe(false);
  });

  it('lets PSA and D give anything too', () => {
    const { state } = setup({
      groupId: null,
      profile: { role: 'D', groupId: null, permissions: ['users:create'] },
    });
    expect(state.canGiveFlag('rider')).toBe(true);
    expect(state.canEnablePos()).toBe(true);
    expect(state.canGiveAutomatic('vne', 'tools')).toBe(true);
    expect(state.canGiveModule('groups', 'w')).toBe(true);
  });

  describe('a CA with a limited POS', () => {
    const actorPos = fakePos({
      enabled: false,
      grants: {
        ...fakePos().grants,
        discount: true,
        discountMaxPercentage: 20,
        automaticCash: {
          ...fakePos().grants.automaticCash,
          glory: { ...fakePos().grants.automaticCash.glory, deposit: true },
        },
      },
    });

    it('gives only what it holds', async () => {
      const { state, load } = setup({
        user: storedUser({ pos: fakePos({ enabled: false }) }),
        profile: adminProfile({ role: 'CA', pos: actorPos }),
      });
      await load();
      expect(state.discountCap()).toBe(20);
      expect(state.canGiveFlag('discount')).toBe(true);
      expect(state.canGiveFlag('rider')).toBe(false);
      expect(state.canGiveAutomatic('glory', 'deposit')).toBe(true);
      expect(state.canGiveAutomatic('glory', 'archive')).toBe(false);
      expect(state.canEnablePos()).toBe(false);
      expect(state.userForm.pos.grants.rider().disabled()).toBe(true);
      expect(state.userForm.pos.grants.discount().disabled()).toBe(false);
      expect(state.userForm.pos.grants.automaticCash.glory.archive().disabled()).toBe(true);
      expect(state.userForm.pos.enabled().disabled()).toBe(true);
    });

    it('can keep a value that the target already has', async () => {
      const target = fakePos({
        enabled: true,
        grants: {
          ...fakePos().grants,
          rider: true,
          automaticCash: {
            ...fakePos().grants.automaticCash,
            glory: { ...fakePos().grants.automaticCash.glory, archive: true },
          },
        },
      });
      const { state, load } = setup({
        user: storedUser({ pos: target }),
        profile: adminProfile({ role: 'CA', pos: actorPos }),
      });
      await load();
      expect(state.canGiveFlag('rider')).toBe(true);
      expect(state.canGiveAutomatic('glory', 'archive')).toBe(true);
      expect(state.canEnablePos()).toBe(true);
    });

    it('treats a PA without POS as holding nothing', async () => {
      const { state, load } = setup({
        user: storedUser({ pos: fakePos({ enabled: false }) }),
        profile: adminProfile({ role: 'PA', pos: undefined as never }),
      });
      await load();
      expect(state.canGiveFlag('discount')).toBe(false);
      expect(state.canGiveAutomatic('glory', 'deposit')).toBe(false);
      expect(state.canEnablePos()).toBe(false);
      expect(state.discountCap()).toBeNull();
    });

    it('has no cap when the actor has no discount limit', async () => {
      const { state, load } = setup({
        user: storedUser(),
        profile: adminProfile({ role: 'CA', pos: fakePos() }),
      });
      await load();
      expect(state.discountCap()).toBeNull();
    });

    describe('discount ceiling', () => {
      const limited = async (stored: string | null = null) => {
        const target = fakePos({
          grants: { ...fakePos().grants, discountMaxPercentage: stored as never },
        });
        const made = setup({
          user: storedUser({ pos: target }),
          profile: adminProfile({ role: 'CA', pos: actorPos }),
        });
        await made.load();
        return made;
      };
      const errors = (state: UserFormState) =>
        state.userForm.pos.grants
          .discountMaxPercentage()
          .errors()
          .map((error) => error.kind);

      it('rejects a value above the ceiling', async () => {
        const { state } = await limited();
        update(state, (model) => (model.pos.grants.discountMaxPercentage = '30'));
        expect(errors(state)).toEqual(['notAllowed']);
        update(state, (model) => (model.pos.grants.discountMaxPercentage = '20'));
        expect(errors(state)).toEqual([]);
      });

      it('rejects clearing a value, which would lift the ceiling', async () => {
        const { state } = await limited('10');
        update(state, (model) => (model.pos.grants.discountMaxPercentage = ''));
        expect(errors(state)).toEqual(['notAllowed']);
      });

      it('accepts a value left unchanged even above the ceiling', async () => {
        const { state } = await limited('50');
        expect(errors(state)).toEqual([]);
      });

      it('does not limit a free actor and judges the number itself', async () => {
        const { state, load } = setup({ user: storedUser() });
        await load();
        update(state, (model) => (model.pos.grants.discountMaxPercentage = '90'));
        expect(state.userForm.pos.grants.discountMaxPercentage().errors()).toEqual([]);
        update(state, (model) => (model.pos.grants.discountMaxPercentage = 'abc'));
        expect(state.userForm.pos.grants.discountMaxPercentage().errors()[0].kind).toBe('type');
        update(state, (model) => (model.pos.grants.discountMaxPercentage = '-1'));
        expect(state.userForm.pos.grants.discountMaxPercentage().errors()[0].kind).toBe('minimum');
        update(state, (model) => (model.pos.grants.discountMaxPercentage = '101'));
        expect(state.userForm.pos.grants.discountMaxPercentage().errors()[0].kind).toBe('maximum');
      });
    });
  });

  it('checks the other percentages', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    update(state, (model) => {
      model.pos.grants.servicePercentage = '120';
      model.pos.options.quickDiscount = 'x';
    });
    expect(state.userForm.pos.grants.servicePercentage().errors()[0].kind).toBe('maximum');
    expect(state.userForm.pos.options.quickDiscount().errors()[0].kind).toBe('type');
  });
});

describe('UserFormState: validation', () => {
  const kinds = (field: { (): { errors(): { kind: string }[] } }) =>
    field()
      .errors()
      .map((error) => error.kind);

  it('requires and checks the username', () => {
    const { state } = setup();
    expect(kinds(state.userForm.username)).toEqual(['required']);
    update(state, (model) => (model.username = 'a b'));
    expect(kinds(state.userForm.username)).toEqual(['pattern']);
    update(state, (model) => (model.username = 'mario.rossi'));
    expect(kinds(state.userForm.username)).toEqual([]);
  });

  it('checks the password of a new user', () => {
    const { state } = setup();
    update(state, (model) => (model.username = 'mario.rossi'));
    expect(kinds(state.userForm.password)).toEqual(['required']);
    update(state, (model) => (model.password = 'short'));
    expect(kinds(state.userForm.password)).toEqual(['tooShort']);
    update(state, (model) => (model.password = 'x'.repeat(129)));
    expect(kinds(state.userForm.password)).toEqual(['tooLong']);
    update(state, (model) => (model.password = ' mario.rossi '.trim().padEnd(12, '!')));
    expect(kinds(state.userForm.password)).toEqual([]);
    update(state, (model) => (model.username = 'abcdefghijkl'));
    update(state, (model) => (model.password = 'abcdefghijkl'));
    expect(kinds(state.userForm.password)).toEqual(['sameAsUsername']);
  });

  it('has no password rules when editing', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    expect(state.userForm.password().hidden()).toBe(true);
    expect(state.userForm.pin().hidden()).toBe(true);
    expect(kinds(state.userForm.password)).toEqual([]);
  });

  it('accepts an empty PIN or 3 to 6 digits when creating', () => {
    const { state } = setup();
    expect(state.userForm.pin().hidden()).toBe(false);
    expect(kinds(state.userForm.pin)).toEqual([]);
    update(state, (model) => (model.pin = '12'));
    expect(kinds(state.userForm.pin)).toEqual(['pattern']);
    update(state, (model) => (model.pin = '1234'));
    expect(kinds(state.userForm.pin)).toEqual([]);
  });

  it('requires the role', () => {
    const { state } = setup();
    update(state, (model) => (model.role = ''));
    expect(kinds(state.userForm.role)).toEqual(['required']);
  });

  it('limits the lengths, the email, the phone and the description', () => {
    const { state } = setup();
    update(state, (model) => {
      model.firstName = 'x'.repeat(101);
      model.lastName = 'x'.repeat(101);
      model.email = 'not-an-email';
      model.phone = 'abc';
      model.description = 'x'.repeat(1001);
    });
    expect(kinds(state.userForm.firstName)).toEqual(['maxLength']);
    expect(kinds(state.userForm.lastName)).toEqual(['maxLength']);
    expect(kinds(state.userForm.email)).toEqual(['email']);
    expect(kinds(state.userForm.phone)).toEqual(['pattern']);
    expect(kinds(state.userForm.description)).toEqual(['maxLength']);
    update(state, (model) => {
      model.email = `${'x'.repeat(250)}@a.it`;
      model.phone = 'x'.repeat(33);
    });
    expect(kinds(state.userForm.email)).toContain('maxLength');
    expect(kinds(state.userForm.phone)).toContain('maxLength');
    update(state, (model) => {
      model.email = 'a@b.it';
      model.phone = '+39 (02) 123-4567';
    });
    expect(kinds(state.userForm.email)).toEqual([]);
    expect(kinds(state.userForm.phone)).toEqual([]);
  });

  it('requires a perimeter for CA, PA and E only', () => {
    const { state } = setup();
    update(state, (model) => (model.role = 'CA'));
    expect(state.userForm.companyIds().hidden()).toBe(false);
    expect(kinds(state.userForm.companyIds)).toEqual(['required']);
    expect(state.userForm.placeIds().hidden()).toBe(true);
    update(state, (model) => (model.companyIds = ['c1']));
    expect(kinds(state.userForm.companyIds)).toEqual([]);
    for (const role of ['PA', 'E']) {
      update(state, (model) => (model.role = role));
      expect(state.userForm.companyIds().hidden()).toBe(true);
      expect(state.userForm.placeIds().hidden()).toBe(false);
      expect(kinds(state.userForm.placeIds)).toEqual(['required']);
    }
    update(state, (model) => (model.placeIds = ['p1']));
    expect(kinds(state.userForm.placeIds)).toEqual([]);
    update(state, (model) => (model.role = 'SA'));
    expect(state.userForm.placeIds().hidden()).toBe(true);
  });

  it('allows at most 200 services', () => {
    const { state } = setup();
    update(state, (model) => (model.serviceIds = Array.from({ length: 201 }, (_, i) => `s${i}`)));
    expect(kinds(state.userForm.serviceIds)).toEqual(['tooMany']);
    update(state, (model) => (model.serviceIds = ['s1']));
    expect(kinds(state.userForm.serviceIds)).toEqual([]);
  });

  it('applies the rules of the shifts', () => {
    const { state } = setup();
    update(state, (model) => {
      model.shiftTime.weeks = [
        {
          from: '',
          to: '',
          days: {
            ...Object.fromEntries(
              ['0', '1', '2', '3', '4', '5', '6'].map((k) => [k, { active: false, slots: [] }]),
            ),
            '1': { active: true, slots: [{ start: '10:00', end: '09:00' }] },
          } as never,
        },
      ];
    });
    const slot = state.userForm.shiftTime.weeks[0].days['1'].slots[0];
    expect(kinds(slot.end)).toEqual(['incorrect']);
  });
});

describe('UserFormState: changes', () => {
  it('builds the patch of the changed fields', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    expect(state.hasChanges()).toBe(false);
    update(state, (model) => (model.firstName = 'Changed'));
    expect(state.patch()).toEqual({ firstName: 'Changed' });
    expect(state.hasChanges()).toBe(true);
  });
});

describe('UserFormState: catalogs of the group', () => {
  it('reads the price lists and the favorites for a stored user with a POS', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    expect(state.canReadFavorites()).toBe(true);
    expect(state.priceLists()).toEqual([]);
    expect(state.favorites()).toBeNull();
    expect(state.priceListsLoading()).toBe(true);
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/lookup/price-lists`)
      .flush({ data: [{ id: 'l1', name: 'Listino' }], page: PAGE });
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/product-favorites`)
      .flush({ data: [{ id: 'f1', name: 'Preferiti' }], page: PAGE });
    await settle();
    TestBed.tick();
    expect(state.priceLists()).toEqual([{ id: 'l1', name: 'Listino' }]);
    expect(state.priceListsLoading()).toBe(false);
    expect(state.priceListsFailed()).toBe(false);
    expect(state.favorites()).toEqual([{ id: 'f1', name: 'Preferiti' }]);
  });

  it('reports a failed price list read and reads it again', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/product-favorites`)
      .flush({ data: [], page: PAGE });
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/lookup/price-lists`)
      .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await settle();
    TestBed.tick();
    expect(state.priceListsFailed()).toBe(true);
    expect(state.priceLists()).toEqual([]);
    state.reloadPriceLists();
    TestBed.tick();
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/lookup/price-lists`)
      .flush({ data: [], page: PAGE });
    await settle();
    TestBed.tick();
    expect(state.priceListsFailed()).toBe(false);
  });

  it('reads no catalog at all while creating, not even with every permission', async () => {
    const { state, load } = setup();
    await load();
    backend().expectNone(`${API}/v1/groups/${GROUP}/lookup/price-lists`);
    backend().expectNone(`${API}/v1/groups/${GROUP}/product-favorites`);
    await settle();
    TestBed.tick();
    expect(state.priceLists()).toEqual([]);
    expect(state.favorites()).toBeNull();
    expect(state.priceListsLoading()).toBe(false);
  });

  it('waits for the stored user before reading the catalogs', () => {
    const { state } = setup({ user: storedUser() });
    expect(state.user()).toBeNull();
    backend().expectNone(`${API}/v1/groups/${GROUP}/lookup/price-lists`);
    backend().expectNone(`${API}/v1/groups/${GROUP}/product-favorites`);
    backend().match(() => true);
  });

  it('reads the price lists from the lookup with users:read only, not the favorites', async () => {
    const noRights = setup({
      user: storedUser(),
      profile: adminProfile({ role: 'CA', permissions: ['users:read', 'users:update'] }),
    });
    await noRights.load();
    expect(noRights.state.canReadFavorites()).toBe(false);
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/lookup/price-lists`)
      .flush({ data: [{ id: 'l1', name: 'Listino' }] });
    backend().expectNone(`${API}/v1/groups/${GROUP}/product-favorites`);
    await settle();
    TestBed.tick();
    expect(noRights.state.priceLists()).toEqual([{ id: 'l1', name: 'Listino' }]);
  });

  it('reads nothing for a role without POS', async () => {
    const { state, load } = setup({ user: storedUser({ role: 'E' }) });
    await load();
    await settle();
    TestBed.tick();
    expect(state.posApplies()).toBe(false);
    expect(state.priceListsLoading()).toBe(false);
    expect(state.priceLists()).toEqual([]);
    expect(state.favorites()).toBeNull();
  });
});

describe('UserFormState: services', () => {
  const SERVICES = `${API}/v1/groups/${GROUP}/services`;

  it('reads the names of the selected services', async () => {
    const { state, load } = setup({ user: storedUser({ serviceIds: ['s1', 's2'] }) });
    await load();
    backend().match(() => false);
    const request = backend().expectOne((r) => r.url === SERVICES);
    expect(request.request.params.get('limit')).toBe('100');
    request.flush({
      data: [
        { id: 's1', name: 'Taglio' },
        { id: 's2', name: 'Piega' },
      ],
      page: PAGE,
    });
    await settle();
    expect(state.serviceLabels()).toEqual({ s1: 'Taglio', s2: 'Piega' });
  });

  it('warns and keeps the selection when the names cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { state, load } = setup({ user: storedUser({ serviceIds: ['s1'] }) });
    await load();
    backend()
      .expectOne((r) => r.url === SERVICES)
      .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await settle();
    expect(warn).toHaveBeenCalledWith('Cannot read the names of the services', expect.anything());
    expect(state.serviceLabels()).toEqual({});
    expect(state.model().serviceIds).toEqual(['s1']);
  });

  it('does not read names when nothing is selected or services do not apply', async () => {
    const e = setup({ user: storedUser({ role: 'E', serviceIds: ['s1'] }) });
    await e.load();
    backend().expectNone((r) => r.url === SERVICES);
  });

  it('pages the services of the group for the picker', async () => {
    const { state, load } = setup({ user: storedUser() });
    await load();
    const spy = vi
      .spyOn(ReferenceApi.prototype, 'services')
      .mockResolvedValue({ data: [], page: { limit: 25, next: null } });
    await state.serviceLoader()({ q: 'ta', cursor: null });
    expect(spy).toHaveBeenCalledWith(GROUP, { q: 'ta', cursor: null });
  });
});

describe('UserFormState: messages', () => {
  it('shows the message of a field once it is touched', () => {
    const { state } = setup();
    expect(state.error(state.userForm.username)).toBeNull();
    state.userForm.username().markAsTouched();
    expect(state.error(state.userForm.username)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('builds the initials of the form for the avatar', () => {
    const { state } = setup();
    update(state, (model) => {
      model.firstName = 'Mario';
      model.lastName = 'Rossi';
    });
    expect(state.initials()).toBe('MR');
  });
});
