import { backend } from '../../../testing/api';
import {
  adminProfile,
  renderWithState,
  StateOptions,
  storedUser,
} from '../../../testing/user-form-state';
import { UserPermissionsSection } from './user-permissions-section';
import { PERMISSION_MODULES } from './user.types';
import { Component, inject } from '@angular/core';
import { UserFormState } from './user-form-state';

@Component({
  imports: [UserPermissionsSection],
  providers: [UserFormState],
  template: '<fc-user-permissions-section />',
})
class Host {
  readonly state = inject(UserFormState);
}

async function render(options: StateOptions & { user?: ReturnType<typeof storedUser> } = {}) {
  const rendered = await renderWithState(Host, options);
  const notes = () =>
    [...rendered.root.querySelectorAll('p.note')].map((note) => note.textContent?.trim());
  const modules = () => [...rendered.root.querySelectorAll('fieldset.module')];
  const boxesOf = (module: Element) => [
    ...module.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ];
  const box = (label: string) =>
    [...rendered.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(
      (input) => input.labels?.[0]?.textContent?.trim() === label,
    )!;
  return { ...rendered, notes, modules, boxesOf, box };
}

beforeEach(() => sessionStorage.clear());

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserPermissionsSection: editing', () => {
  it('shows the 13 modules, with logs read only, when the actor can change the matrix', async () => {
    const { modules, boxesOf, notes, box, view, state } = await render({
      user: storedUser({
        permissions: {
          modules: { users: { r: true, w: false }, places: { r: true, w: true } },
          canManagePermissions: false,
        },
      }),
    });
    expect(notes()).toEqual(['USERS.FORM.RELOGIN_WARNING']);
    expect(modules()).toHaveLength(PERMISSION_MODULES.length);
    expect(modules()).toHaveLength(13);
    const legends = modules().map((module) => module.querySelector('legend')?.textContent);
    expect(legends).toEqual(
      PERMISSION_MODULES.map((module) => `USERS.MODULE.${module.toUpperCase()}`),
    );
    const logs = modules()[PERMISSION_MODULES.indexOf('logs')];
    expect(boxesOf(logs)).toHaveLength(1);
    expect(boxesOf(logs)[0].labels?.[0].textContent?.trim()).toBe('USERS.FORM.READ');
    const users = modules()[PERMISSION_MODULES.indexOf('users')];
    expect(boxesOf(users).map((input) => input.checked)).toEqual([true, false]);
    const places = modules()[PERMISSION_MODULES.indexOf('places')];
    expect(boxesOf(places).map((input) => input.checked)).toEqual([true, true]);
    expect(box('USERS.FORM.CAN_MANAGE').checked).toBe(false);

    const write = boxesOf(users)[1];
    write.checked = true;
    write.dispatchEvent(new Event('change'));
    box('USERS.FORM.CAN_MANAGE').click();
    await view();
    expect(state.model().permissions.modules.users).toEqual({ r: true, w: true });
    expect(state.model().permissions.canManagePermissions).toBe(true);
  });

  it('hints at the flags that the actor cannot give, and disables them', async () => {
    const { modules, boxesOf, root } = await render({
      user: storedUser(),
      profile: adminProfile({ role: 'CA', permissions: ['users:update', 'users:read'] }),
    });
    const users = modules()[PERMISSION_MODULES.indexOf('users')];
    const [read, write] = boxesOf(users);
    expect(read.disabled).toBe(false);
    expect(write.disabled).toBe(true);
    const hints = [...users.querySelectorAll('.hint')].map((hint) => hint.textContent?.trim());
    expect(hints).toEqual(['USERS.FORM.NOT_GRANTABLE']);
    expect(root.textContent).toContain('USERS.FORM.NOT_GRANTABLE');
  });

  it('shows the matrix in read only mode, without hints, when the actor cannot manage permissions', async () => {
    const { notes, modules, boxesOf, root } = await render({
      user: storedUser(),
      profile: adminProfile({
        role: 'CA',
        permissions: ['users:update'],
        canManagePermissions: false,
      }),
    });
    expect(notes()).toEqual(['USERS.FORM.PERMISSIONS_READONLY']);
    expect(modules()).toHaveLength(13);
    expect(boxesOf(modules()[0]).every((input) => input.disabled)).toBe(true);
    expect(root.querySelector('.hint')).toBeNull();
  });

  it('shows the matrix of a PSA or D as it is, with a note and nothing to edit', async () => {
    const { notes, modules, boxesOf, box } = await render({
      user: storedUser({ role: 'D' }),
    });
    expect(notes()).toEqual(['USERS.FORM.PERMISSIONS_FIXED']);
    expect(modules()).toHaveLength(13);
    expect(boxesOf(modules()[0]).every((input) => input.disabled)).toBe(true);
    expect(box('USERS.FORM.CAN_MANAGE').disabled).toBe(true);
  });

  it('shows the error of a flag', async () => {
    const { state, view, root } = await render({ user: storedUser() });
    state.userForm.permissions.modules.users.r().markAsTouched();
    state.userForm.permissions.canManagePermissions().markAsTouched();
    await view();
    expect(root.querySelector('.error')).not.toBeNull();
  });
});

describe('UserPermissionsSection: creating', () => {
  it('only says that the role defaults apply, with no checkbox, for whoever manages permissions', async () => {
    const { notes, modules, root, state } = await render();
    expect(notes()).toEqual(['USERS.FORM.DEFAULTS_NOTE']);
    expect(modules()).toHaveLength(0);
    expect(root.querySelector('input[type=checkbox]')).toBeNull();
    expect(state.matrixEditable()).toBe(false);
  });

  it('shows the same note to an actor who cannot manage permissions', async () => {
    const { notes, root } = await render({
      profile: adminProfile({ canManagePermissions: false }),
    });
    expect(notes()).toEqual(['USERS.FORM.DEFAULTS_NOTE']);
    expect(root.querySelector('input[type=checkbox]')).toBeNull();
  });

  it('only notes that a new PSA or D has every permission', async () => {
    const { state, notes, modules, root, view } = await render({
      groupId: null,
      profile: {
        role: 'PSA',
        groupId: null,
        permissions: ['users:create'],
        canManagePermissions: true,
      },
    });
    expect(state.role()).toBe('PSA');
    expect(notes()).toEqual(['USERS.FORM.PERMISSIONS_FIXED']);
    expect(modules()).toHaveLength(0);
    expect(root.querySelector('input[type=checkbox]')).toBeNull();
    state.model.update((model) => ({ ...model, role: 'D' }));
    await view();
    expect(notes()).toEqual(['USERS.FORM.PERMISSIONS_FIXED']);
  });
});
