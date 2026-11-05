import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { BulkAction, UserAction, UserActions } from './user-actions';
import { fakeUser } from '../../../testing/users';

@Component({
  imports: [UserActions],
  template: `<fc-user-actions (done)="done.update((list) => [...list, $event])" />`,
})
class Host {
  readonly actions = viewChild.required(UserActions);
  readonly done = signal<UserAction[]>([]);
}

const USER = fakeUser();
const GROUP_URL = `${API}/v1/groups/665f1c2e9b1d4a0012ab34a1/users/${USER.id}`;

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const host = fixture.componentInstance;
  const root = fixture.nativeElement as HTMLElement;
  const toast = TestBed.inject(ToastService);
  const dialogs = () => [...root.querySelectorAll<HTMLDialogElement>('dialog')];
  const isOpen = (index: number) => dialogs()[index].hasAttribute('open');
  const buttons = (index: number) =>
    dialogs()[index].querySelectorAll<HTMLButtonElement>('footer button');
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const run = async (action: UserAction, user = USER) => {
    host.actions().run(action, user);
    await view();
  };
  const runBulk = async (action: BulkAction, users: (typeof USER)[]) => {
    host.actions().runBulk(action, users);
    await view();
  };
  const confirm = async () => {
    buttons(0)[1].click();
    await settle();
  };
  return { fixture, host, root, toast, dialogs, isOpen, buttons, view, run, runBulk, confirm };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserActions', () => {
  it.each([
    ['disable', 'PATCH', { status: 'disabled' }, 'USER_ACTIONS.DONE.DISABLE'],
    ['enable', 'PATCH', { status: 'active' }, 'USER_ACTIONS.DONE.ENABLE'],
  ] as const)(
    '%s asks to confirm, updates the status and reports',
    async (action, method, body, message) => {
      const { host, toast, isOpen, run, confirm, view, root } = await render();
      await run(action);
      expect(isOpen(0)).toBe(true);
      expect(root.querySelector('dialog .body p')?.textContent).toContain(USER.username);
      await confirm();
      const request = backend().expectOne(GROUP_URL);
      expect(request.request.method).toBe(method);
      expect(request.request.body).toEqual(body);
      request.flush({ data: USER });
      await view();
      expect(isOpen(0)).toBe(false);
      expect(toast.toasts().map((t) => t.message)).toEqual([message]);
      expect(host.done()).toEqual([action]);
    },
  );

  it.each(['trash', 'restore'] as const)('%s calls the matching route', async (action) => {
    const { host, run, confirm, view } = await render();
    await run(action);
    await confirm();
    backend().expectOne(`${GROUP_URL}/${action}`).flush({ data: USER });
    await view();
    expect(host.done()).toEqual([action]);
  });

  it('acts on a platform user through /v1/users', async () => {
    const { run, confirm, view } = await render();
    await run('trash', fakeUser({ groupId: null, role: 'D' }));
    await confirm();
    backend().expectOne(`${API}/v1/users/${USER.id}/trash`).flush({ data: USER });
    await view();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const { host, isOpen, run, buttons, view } = await render();
    await run('trash');
    buttons(0)[0].click();
    await view();
    expect(isOpen(0)).toBe(false);
    expect(host.done()).toEqual([]);
  });

  it('shows a failure of a single action in a toast and does not reload', async () => {
    const { host, toast, run, confirm, view } = await render();
    await run('trash');
    await confirm();
    backend()
      .expectOne(`${GROUP_URL}/trash`)
      .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(toast.toasts().map((t) => [t.kind, t.message])).toEqual([
      ['error', 'USERS.FORBIDDEN_TARGET'],
    ]);
    expect(host.done()).toEqual([]);
  });

  it.each([
    ['trash', 0],
    ['resetPassword', 1],
    ['delete', 2],
  ] as const)('%s closes when the dialog is dismissed', async (action, index) => {
    const { isOpen, dialogs, run, view } = await render();
    await run(action);
    expect(isOpen(index)).toBe(true);
    dialogs()[index].close();
    await view();
    expect(isOpen(index)).toBe(false);
  });

  describe('delete for good', () => {
    it('needs the username to be typed', async () => {
      const { host, fixture, isOpen, buttons, run, view, toast } = await render();
      await run('delete');
      expect(isOpen(2)).toBe(true);
      expect(buttons(2)[1].disabled).toBe(true);
      await typeInto(fixture, `USER_ACTIONS.TYPE_USERNAME {"username":"${USER.username}"}`, 'luca');
      expect(buttons(2)[1].disabled).toBe(true);
      await typeInto(
        fixture,
        `USER_ACTIONS.TYPE_USERNAME {"username":"${USER.username}"}`,
        USER.username,
      );
      expect(buttons(2)[1].disabled).toBe(false);
      buttons(2)[1].click();
      await settle();
      const request = backend().expectOne(GROUP_URL);
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(isOpen(2)).toBe(false);
      expect(toast.toasts().map((t) => t.message)).toEqual(['USER_ACTIONS.DONE.DELETE']);
      expect(host.done()).toEqual(['delete']);
    });

    it('can be cancelled', async () => {
      const { isOpen, buttons, run, view } = await render();
      await run('delete');
      buttons(2)[0].click();
      await view();
      expect(isOpen(2)).toBe(false);
    });
  });

  describe('reset password', () => {
    const NEW_PASSWORD = 'USER_ACTIONS.NEW_PASSWORD';
    const form = (root: HTMLElement) =>
      root.querySelector<HTMLFormElement>('#reset-password-form')!;
    const submit = async (root: HTMLElement) => {
      form(root).dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    };

    it.each([
      ['short', 'abc', 'FORM.ISSUE.TOO_SHORT'],
      ['long', 'a'.repeat(129), 'FORM.ISSUE.TOO_LONG'],
      [
        'the username',
        USER.username.padEnd(12, 'x') === USER.username ? '' : USER.username,
        'FORM.ISSUE.TOO_SHORT',
      ],
    ])('refuses a password that is too %s', async (_name, password, issue) => {
      const { fixture, root, run, view } = await render();
      await run('resetPassword');
      await typeInto(fixture, NEW_PASSWORD, password);
      await submit(root);
      await view();
      expect(root.querySelector('dialog[open] .error')?.textContent).toContain(issue);
    });

    it('refuses a password equal to the username', async () => {
      const { fixture, root, run, view } = await render();
      await run('resetPassword', fakeUser({ username: 'a-very-long-username' }));
      await typeInto(fixture, NEW_PASSWORD, 'a-very-long-username');
      await submit(root);
      await view();
      expect(root.querySelector('dialog[open] .error')?.textContent).toContain(
        'FORM.ISSUE.SAME_AS_USERNAME',
      );
    });

    it('sets the password, reports and asks the page to reload', async () => {
      const { host, fixture, root, toast, isOpen, run, view } = await render();
      await run('resetPassword');
      expect(root.querySelector('dialog[open] p:nth-of-type(2)')?.textContent).toBe(
        'USER_ACTIONS.RESET_WARNING',
      );
      await typeInto(fixture, NEW_PASSWORD, 'Temp-Password-9');
      await submit(root);
      const request = backend().expectOne(`${GROUP_URL}/password`);
      expect(request.request.body).toEqual({ password: 'Temp-Password-9' });
      request.flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(isOpen(1)).toBe(false);
      expect(toast.toasts().map((t) => t.message)).toEqual(['USER_ACTIONS.DONE.RESETPASSWORD']);
      expect(host.done()).toEqual(['resetPassword']);
      expect(root.querySelector('#reset-password-form')).toBeNull();
    });

    it('fills the field with a generated password', async () => {
      const { fixture, root, run, view } = await render();
      await run('resetPassword');
      root.querySelector<HTMLButtonElement>('fc-password-generator button')!.click();
      await view();
      const value = (findControl(fixture, NEW_PASSWORD) as HTMLInputElement).value;
      expect(value).toHaveLength(16);
      expect(root.querySelector('fc-password-generator output')?.textContent).toBe(value);
    });

    it.each([
      ['tooShort', 'FORM.ISSUE.TOO_SHORT'],
      ['invalidCharacters', 'FORM.ISSUE.INVALID_CHARACTERS'],
      ['whatever', 'FORM.ISSUE.INVALID'],
      [undefined, 'FORM.ISSUE.INVALID'],
    ])('shows a server issue (%s) on the field and keeps the dialog', async (issue, message) => {
      const { fixture, root, isOpen, run, view } = await render();
      await run('resetPassword');
      await typeInto(fixture, NEW_PASSWORD, 'Temp-Password-9');
      await submit(root);
      const details =
        issue === undefined ? [{ field: 'other', issue: 'x' }] : [{ field: 'password', issue }];
      backend()
        .expectOne(`${GROUP_URL}/password`)
        .flush(errorBody('VALIDATION_ERROR', details), { status: 422, statusText: 'x' });
      await view();
      expect(isOpen(1)).toBe(true);
      expect(root.querySelector('dialog[open] .error')?.textContent).toContain(message);
      await typeInto(fixture, NEW_PASSWORD, 'Another-Pass-10');
      expect(root.querySelector('dialog[open] .error')?.textContent?.trim()).toBe('');
    });

    it('closes and reports any other failure', async () => {
      const { host, fixture, root, toast, isOpen, run, view } = await render();
      await run('resetPassword');
      await typeInto(fixture, NEW_PASSWORD, 'Temp-Password-9');
      await submit(root);
      backend()
        .expectOne(`${GROUP_URL}/password`)
        .flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'x' });
      await view();
      expect(isOpen(1)).toBe(false);
      expect(toast.toasts().map((t) => t.message)).toEqual(['ERRORS.API.RATE_LIMITED']);
      expect(host.done()).toEqual([]);
    });

    it('shows no generated password again when the dialog is reopened for another user', async () => {
      const { fixture, root, run, buttons, view } = await render();
      await run('resetPassword');
      root.querySelector<HTMLButtonElement>('fc-password-generator button')!.click();
      await view();
      expect(root.querySelector('fc-password-generator output')).not.toBeNull();
      buttons(1)[0].click();
      await view();
      await run('resetPassword', fakeUser({ id: '665f1c2e9b1d4a0012ab3402', username: 'other' }));
      expect(root.querySelector('fc-password-generator output')).toBeNull();
      expect((findControl(fixture, 'USER_ACTIONS.NEW_PASSWORD') as HTMLInputElement).value).toBe(
        '',
      );
    });

    it('forgets the password when the dialog fails or is dismissed', async () => {
      const { fixture, root, run, view, host } = await render();
      await run('resetPassword');
      await typeInto(fixture, 'USER_ACTIONS.NEW_PASSWORD', 'Temp-Password-9');
      form(root).dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      backend()
        .expectOne(`${GROUP_URL}/password`)
        .flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'x' });
      await view();
      await run('resetPassword');
      expect((findControl(fixture, 'USER_ACTIONS.NEW_PASSWORD') as HTMLInputElement).value).toBe(
        '',
      );
      expect(host.done()).toEqual([]);
    });

    it('can be cancelled', async () => {
      const { isOpen, buttons, run, view } = await render();
      await run('resetPassword');
      buttons(1)[0].click();
      await view();
      expect(isOpen(1)).toBe(false);
    });
  });

  describe('bulk', () => {
    const U1 = fakeUser({ id: '665f1c2e9b1d4a0012ab3401', username: 'one' });
    const U2 = fakeUser({ id: '665f1c2e9b1d4a0012ab3402', username: 'two' });
    const U3 = fakeUser({ id: '665f1c2e9b1d4a0012ab3403', username: 'three' });
    const url = (user: typeof U1, action: string) =>
      `${API}/v1/groups/665f1c2e9b1d4a0012ab34a1/users/${user.id}/${action}`;

    async function drain(users: (typeof U1)[], action: string, outcomes: ('ok' | 'forbidden')[]) {
      for (const [index, user] of users.entries()) {
        const request = backend().expectOne(url(user, action));
        if (outcomes[index] === 'ok') {
          request.flush({ data: user });
        } else {
          request.flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
        }
        await settle();
      }
    }

    it('asks once, runs the users one at a time and reports the count', async () => {
      const { host, toast, root, confirm, runBulk, view } = await render();
      await runBulk('trash', [U1, U2]);
      expect(root.querySelector('dialog .body p')?.textContent).toBe(
        'USER_ACTIONS.BULK.TRASH {"count":2}',
      );
      await confirm();
      await drain([U1, U2], 'trash', ['ok', 'ok']);
      await view();
      expect(toast.toasts().map((t) => t.message)).toEqual(['USER_ACTIONS.BULK_DONE {"count":2}']);
      expect(host.done()).toEqual(['trash']);
    });

    it('lists the users that failed and still reloads for the ones that worked', async () => {
      const { host, root, isOpen, buttons, dialogs, confirm, runBulk, view } = await render();
      await runBulk('restore', [U1, U2, U3]);
      await confirm();
      await drain([U1, U2, U3], 'restore', ['ok', 'forbidden', 'forbidden']);
      await view();
      expect(isOpen(3)).toBe(true);
      expect(
        [...root.querySelectorAll('dialog[open] li')].map((li) => li.textContent?.trim()),
      ).toEqual(['two USERS.FORBIDDEN_TARGET', 'three USERS.FORBIDDEN_TARGET']);
      expect(host.done()).toEqual(['restore']);
      dialogs()[3].close();
      await view();
      expect(isOpen(3)).toBe(false);
    });

    it('does not reload when every user failed', async () => {
      const { host, isOpen, buttons, confirm, runBulk, view } = await render();
      await runBulk('trash', [U1, U2]);
      await confirm();
      await drain([U1, U2], 'trash', ['forbidden', 'forbidden']);
      await view();
      expect(isOpen(3)).toBe(true);
      buttons(3)[0].click();
      await view();
      expect(isOpen(3)).toBe(false);
      expect(host.done()).toEqual([]);
    });
  });
});
