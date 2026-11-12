import { backend } from '../../../testing/api';
import { findControl, typeInto } from '../../../testing/forms';
import { renderWithState, storedUser } from '../../../testing/user-form-state';
import { UserProfileSection } from './user-profile-section';
import { Component, inject } from '@angular/core';
import { UserFormState } from './user-form-state';

@Component({
  imports: [UserProfileSection],
  providers: [UserFormState],
  template: '<fc-user-profile-section />',
})
class Host {
  readonly state = inject(UserFormState);
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserProfileSection', () => {
  it('shows the personal data of the stored user', async () => {
    const { fixture, root } = await renderWithState(Host, {
      user: storedUser({
        firstName: 'Luca',
        lastName: 'Bianchi',
        email: 'luca@example.com',
        phone: '+39 02 1',
        description: 'Note',
        hiddenInStats: true,
      }),
    });
    expect(findControl(fixture, 'PROFILE.FIRST_NAME').value).toBe('Luca');
    expect(findControl(fixture, 'PROFILE.LAST_NAME').value).toBe('Bianchi');
    expect(findControl(fixture, 'PROFILE.EMAIL').value).toBe('luca@example.com');
    expect(findControl(fixture, 'PROFILE.EMAIL').getAttribute('type')).toBe('email');
    expect(findControl(fixture, 'PROFILE.PHONE').getAttribute('type')).toBe('tel');
    expect((findControl(fixture, 'PROFILE.LANGUAGE') as HTMLSelectElement).value).toBe('it');
    expect(root.querySelector('textarea')?.value).toBe('Note');
    expect(findControl(fixture, 'USERS.FORM.HIDDEN_IN_STATS')).toMatchObject({ checked: true });
    expect(root.querySelector('legend')?.textContent).toContain('AVATAR.LABEL');
  });

  it('writes what the user types into the form model', async () => {
    const { fixture, state, view, root } = await renderWithState(Host, {
      user: storedUser(),
    });
    await typeInto(fixture, 'PROFILE.FIRST_NAME', 'Anna');
    await typeInto(fixture, 'PROFILE.LAST_NAME', 'Verdi');
    await typeInto(fixture, 'PROFILE.PHONE', '123');
    const description = root.querySelector('textarea')!;
    description.value = 'Nuova nota';
    description.dispatchEvent(new Event('input'));
    const hidden = findControl(fixture, 'USERS.FORM.HIDDEN_IN_STATS') as HTMLInputElement;
    hidden.checked = true;
    hidden.dispatchEvent(new Event('change'));
    await view();
    expect(state.model()).toMatchObject({
      firstName: 'Anna',
      lastName: 'Verdi',
      phone: '123',
      description: 'Nuova nota',
      hiddenInStats: true,
    });
  });

  it('shows the errors of the fields once they are touched', async () => {
    const { fixture, state, view, root } = await renderWithState(Host, {
      user: storedUser(),
    });
    const email = await typeInto(fixture, 'PROFILE.EMAIL', 'not-an-email');
    email.dispatchEvent(new Event('blur'));
    for (const label of ['PROFILE.FIRST_NAME', 'PROFILE.LAST_NAME', 'PROFILE.PHONE']) {
      findControl(fixture, label).dispatchEvent(new Event('blur'));
    }
    findControl(fixture, 'PROFILE.LANGUAGE').dispatchEvent(new Event('blur'));
    root.querySelector('textarea')!.dispatchEvent(new Event('blur'));
    await view();
    expect(state.userForm.email().touched()).toBe(true);
    expect(state.userForm.firstName().touched()).toBe(true);
    expect(state.userForm.lastName().touched()).toBe(true);
    expect(state.userForm.phone().touched()).toBe(true);
    expect(state.userForm.language().touched()).toBe(true);
    expect(state.userForm.description().touched()).toBe(true);
    expect(root.textContent).toContain('FORM.ISSUE.FORMAT');
  });

  it('says when the user has an image that cannot be shown', async () => {
    const { root } = await renderWithState(Host, {
      user: storedUser({ hasAvatar: true, avatar: null }),
    });
    expect(root.textContent).toContain('AVATAR.HIDDEN');
  });

  it('shows no such note when the user has no image or the image is shown', async () => {
    const none = await renderWithState(Host, { user: storedUser() });
    expect(none.root.textContent).not.toContain('AVATAR.HIDDEN');
  });

  it('shows no such note while creating', async () => {
    const { root, state } = await renderWithState(Host);
    expect(state.user()).toBeNull();
    expect(root.textContent).not.toContain('AVATAR.HIDDEN');
  });

  it('shows the avatar of the user', async () => {
    const { root } = await renderWithState(Host, {
      user: storedUser({ hasAvatar: true, avatar: 'data:image/png;base64,AAAA' }),
    });
    expect(root.textContent).not.toContain('AVATAR.HIDDEN');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('is read only when the actor cannot write', async () => {
    const { fixture, root } = await renderWithState(Host, {
      user: storedUser(),
      profile: { role: 'SA', permissions: ['users:read'] },
    });
    expect(findControl(fixture, 'PROFILE.FIRST_NAME').disabled).toBe(true);
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });
});
