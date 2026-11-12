import { backend } from '../../../testing/api';
import { findControl } from '../../../testing/forms';
import { renderWithState, storedUser } from '../../../testing/user-form-state';
import { UserAccessSection } from './user-access-section';
import { UsersApi } from './users-api';
import { Component, inject } from '@angular/core';
import { UserFormState } from './user-form-state';

@Component({
  imports: [UserAccessSection],
  providers: [UserFormState],
  template: '<fc-user-access-section />',
})
class Host {
  readonly state = inject(UserFormState);
}

/** Hint shown under the username field, or `null`. */
function hint(root: HTMLElement): string | null {
  const input = root.querySelector('input')!;
  const id = input
    .getAttribute('aria-describedby')
    ?.split(' ')
    .find((i) => i.endsWith('-hint'));
  return id === undefined ? null : root.querySelector(`#${id}`)!.textContent!.trim();
}

async function render(options: Parameters<typeof renderWithState>[1] = {}, available = true) {
  const check = vi.spyOn(UsersApi.prototype, 'isUsernameAvailable').mockResolvedValue(available);
  const rendered = await renderWithState(Host, options);
  vi.useFakeTimers();
  /** Types in the username field and lets `ms` of fake time pass. */
  const type = async (value: string, ms = 0) => {
    const control = findControl(rendered.fixture, 'USERS.FORM.USERNAME') as HTMLInputElement;
    control.value = value;
    control.dispatchEvent(new Event('input'));
    rendered.fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(ms);
    rendered.fixture.detectChanges();
  };
  return { ...rendered, check, type };
}

afterEach(() => {
  vi.useRealTimers();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserAccessSection: creating', () => {
  it('asks for username, password, PIN, role and status, and offers the generator', async () => {
    const { fixture, root } = await render();
    expect(findControl(fixture, 'USERS.FORM.USERNAME').getAttribute('autocapitalize')).toBe('none');
    expect(findControl(fixture, 'USERS.FORM.USERNAME').getAttribute('spellcheck')).toBe('false');
    const password = findControl(fixture, 'USERS.FORM.PASSWORD');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    const pin = findControl(fixture, 'USERS.FORM.PIN');
    expect(pin.getAttribute('type')).toBe('password');
    expect(pin.getAttribute('autocomplete')).toBe('new-password');
    expect(pin.getAttribute('inputmode')).toBe('numeric');
    expect(root.querySelector('fc-password-generator')).not.toBeNull();
    expect(findControl(fixture, 'USERS.FORM.ROLE')).toBeInstanceOf(HTMLSelectElement);
    expect(
      [...(findControl(fixture, 'USERS.FORM.ROLE') as HTMLSelectElement).options].map(
        (option) => option.value,
      ),
    ).toEqual(['SA', 'CA', 'PA', 'E']);
    expect(
      [...(findControl(fixture, 'USERS.FORM.STATUS') as HTMLSelectElement).options].map(
        (option) => option.value,
      ),
    ).toEqual(['active', 'disabled']);
    expect(root.querySelector('fc-user-pin')).toBeNull();
  });

  it('fills the password field with the generated password', async () => {
    const { fixture, state, root } = await render();
    root.querySelector<HTMLButtonElement>('fc-password-generator button')!.click();
    fixture.detectChanges();
    const generated = root.querySelector('output')!.textContent!;
    expect(generated).toHaveLength(16);
    expect(state.model().password).toBe(generated);
    expect((findControl(fixture, 'USERS.FORM.PASSWORD') as HTMLInputElement).value).toBe(generated);
  });

  it('writes the password, the PIN, the role and the status to the model', async () => {
    const { fixture, state } = await render();
    const set = (label: string, value: string, event: string) => {
      const control = findControl(fixture, label);
      control.value = value;
      control.dispatchEvent(new Event(event));
    };
    set('USERS.FORM.PASSWORD', 'a-long-password-1', 'input');
    set('USERS.FORM.PIN', '1234', 'input');
    set('USERS.FORM.ROLE', 'PA', 'change');
    set('USERS.FORM.STATUS', 'disabled', 'change');
    fixture.detectChanges();
    expect(state.model()).toMatchObject({
      password: 'a-long-password-1',
      pin: '1234',
      role: 'PA',
      status: 'disabled',
    });
  });

  it('shows the errors of the touched fields', async () => {
    const { fixture, state, root } = await render();
    for (const label of [
      'USERS.FORM.USERNAME',
      'USERS.FORM.PASSWORD',
      'USERS.FORM.PIN',
      'USERS.FORM.ROLE',
      'USERS.FORM.STATUS',
    ]) {
      findControl(fixture, label).dispatchEvent(new Event('blur'));
    }
    fixture.detectChanges();
    expect(state.userForm.username().touched()).toBe(true);
    expect(state.userForm.password().touched()).toBe(true);
    expect(state.userForm.pin().touched()).toBe(true);
    expect(state.userForm.role().touched()).toBe(true);
    expect(state.userForm.status().touched()).toBe(true);
    expect(root.textContent).toContain('FORM.ISSUE.REQUIRED');
  });
});

describe('UserAccessSection: username availability', () => {
  it('checks a valid username once typing stops', async () => {
    const { check, type, root } = await render();
    expect(hint(root)).toBeNull();
    await type('nuovo.utente');
    expect(hint(root)).toBe('USERS.FORM.USERNAME_CHECKING');
    expect(check).not.toHaveBeenCalled();
    await type('nuovo.utente2', 299);
    expect(check).not.toHaveBeenCalled();
    await type('nuovo.utente3', 300);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('nuovo.utente3');
    expect(hint(root)).toBe('USERS.FORM.USERNAME_AVAILABLE');
    expect(root.querySelector('.error')?.textContent?.trim()).toBe('');
  });

  it('flags a username that is taken', async () => {
    const { type, root } = await render({}, false);
    await type('esistente', 300);
    expect(hint(root)).toBe('USERS.FORM.USERNAME_TAKEN');
    expect(root.textContent).toContain('FORM.ISSUE.TAKEN');
  });

  it('keeps the form usable when the check fails, without logging the username', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { check, type, root } = await render();
    check.mockRejectedValue(new Error('network'));
    await type('qualcuno', 300);
    expect(hint(root)).toBe('USERS.FORM.USERNAME_ERROR');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('qualcuno');
  });

  it('does not check an invalid username, and drops a check that is waiting', async () => {
    const { check, type, root } = await render();
    await type('ab', 300);
    expect(check).not.toHaveBeenCalled();
    expect(hint(root)).toBeNull();
    await type('valid.name', 100);
    await type('no', 500);
    expect(check).not.toHaveBeenCalled();
    expect(hint(root)).toBeNull();
  });

  it('checks again after the username changes back and forth', async () => {
    const { check, type, root } = await render();
    await type('primo.nome', 300);
    await type('secondo.nome', 300);
    expect(check).toHaveBeenLastCalledWith('secondo.nome');
    expect(hint(root)).toBe('USERS.FORM.USERNAME_AVAILABLE');
  });
});

describe('UserAccessSection: editing', () => {
  const user = storedUser({ username: 'luca.bianchi' });

  it('shows the PIN actions instead of the password and the PIN fields', async () => {
    const { fixture, root } = await render({ user });
    expect(() => findControl(fixture, 'USERS.FORM.PASSWORD')).toThrow();
    expect(root.querySelector('fc-password-generator')).toBeNull();
    expect(root.querySelector('fieldset legend')?.textContent).toContain('USERS.FORM.PIN');
    expect(root.querySelector('fc-user-pin')).not.toBeNull();
    expect((findControl(fixture, 'USERS.FORM.USERNAME') as HTMLInputElement).value).toBe(
      'luca.bianchi',
    );
  });

  it('does not check the stored username, but does check a new one', async () => {
    const { check, type, root } = await render({ user });
    await type('luca.bianchi', 300);
    expect(check).not.toHaveBeenCalled();
    expect(hint(root)).toBeNull();
    await type('luca.nuovo', 300);
    expect(check).toHaveBeenCalledWith('luca.nuovo');
    expect(hint(root)).toBe('USERS.FORM.USERNAME_AVAILABLE');
  });

  it('does not check anything when the actor cannot write', async () => {
    const { check, type, root } = await render({
      user,
      profile: { role: 'SA', permissions: ['users:read'] },
    });
    await type('luca.nuovo', 300);
    expect(check).not.toHaveBeenCalled();
    expect(hint(root)).toBeNull();
  });
});
