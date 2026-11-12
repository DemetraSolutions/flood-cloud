import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { typeInto } from '../../../testing/forms';
import { fakeUser } from '../../../testing/users';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { UserArea, UserRecord } from './user.types';
import { UserFormState } from './user-form-state';
import { UserPin } from './user-pin';
import { UsersApi } from './users-api';

const USER = fakeUser({ id: '665f1c2e9b1d4a0012ab34ff' });
const GROUP_URL = `/v1/groups/665f1c2e9b1d4a0012ab34a1/users/${USER.id}`;

async function render(
  options: {
    pinSet?: boolean;
    canWrite?: boolean;
    area?: UserArea;
  } = {},
) {
  emulateNativeDialog();
  const i18n = { t: (key: string) => key };
  const state = {
    user: signal<UserRecord | null>(USER),
    area: signal<UserArea>(options.area ?? { kind: 'group', groupId: USER.groupId as string }),
    pinSet: signal(options.pinSet ?? false),
    canWrite: signal(options.canWrite ?? true),
    i18n,
  };
  TestBed.configureTestingModule({
    providers: [provideApiTesting(), { provide: UserFormState, useValue: state }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(UserPin);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const toast = TestBed.inject(ToastService);
  const dialogs = () => [...root.querySelectorAll<HTMLDialogElement>('dialog')];
  const isOpen = (index: number) => dialogs()[index].hasAttribute('open');
  const footer = (index: number) => [
    ...dialogs()[index].querySelectorAll<HTMLButtonElement>('footer button'),
  ];
  const rowButtons = () => [...root.querySelectorAll<HTMLButtonElement>('.actions-row button')];
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const submitPin = async (pin: string) => {
    await typeInto(fixture, 'PIN.LABEL', pin);
    root
      .querySelector('form#pin-form')!
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await view();
  };
  const messages = () => toast.toasts().map((item) => [item.kind, item.message]);
  return { fixture, state, root, dialogs, isOpen, footer, rowButtons, view, submitPin, messages };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserPin', () => {
  it('says the PIN is not set and offers only to set it', async () => {
    const { root, rowButtons } = await render();
    expect(root.querySelector('[role=status]')?.textContent).toBe('PIN.IS_NOT_SET');
    expect(rowButtons().map((b) => b.textContent?.trim())).toEqual(['PIN.SET']);
  });

  it('says the PIN is set and offers to change or remove it', async () => {
    const { root, rowButtons } = await render({ pinSet: true });
    expect(root.querySelector('[role=status]')?.textContent).toBe('PIN.IS_SET');
    expect(rowButtons().map((b) => b.textContent?.trim())).toEqual(['PIN.CHANGE', 'PIN.REMOVE']);
  });

  it('shows no buttons to who cannot write', async () => {
    const { root, rowButtons } = await render({ pinSet: true, canWrite: false });
    expect(root.querySelector('[role=status]')?.textContent).toBe('PIN.IS_SET');
    expect(rowButtons()).toEqual([]);
  });

  it('sets the PIN with its own request, then reports and closes', async () => {
    const { state, rowButtons, isOpen, submitPin, view, messages, footer } = await render();
    rowButtons()[0].click();
    await view();
    expect(isOpen(0)).toBe(true);
    await submitPin('1234');
    const request = backend().expectOne(`${API}${GROUP_URL}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ pin: '1234' });
    expect(footer(0)[1].getAttribute('aria-busy')).toBe('true');
    request.flush({ data: { ...USER, pinSet: true } });
    await view();
    expect(state.pinSet()).toBe(true);
    expect(isOpen(0)).toBe(false);
    expect(messages()).toEqual([['success', 'PIN.SAVED']]);
    expect(footer(0)[1].getAttribute('aria-busy')).toBeNull();
  });

  it('writes in the platform area for platform users', async () => {
    const { rowButtons, view, submitPin } = await render({ area: { kind: 'platform' } });
    rowButtons()[0].click();
    await view();
    const pending = submitPin('0000');
    await settle();
    const request = backend().expectOne(`${API}/v1/users/${USER.id}`);
    expect(request.request.body).toEqual({ pin: '0000' });
    request.flush({ data: USER });
    await pending;
  });

  it('does not send a PIN that fails the local check', async () => {
    const { rowButtons, isOpen, view, submitPin, messages } = await render();
    rowButtons()[0].click();
    await view();
    await submitPin('12');
    expect(isOpen(0)).toBe(true);
    expect(messages()).toEqual([]);
  });

  it('keeps the dialog open and shows the error when the server rejects the PIN', async () => {
    const { state, root, rowButtons, isOpen, view, submitPin, messages } = await render();
    rowButtons()[0].click();
    await view();
    const pending = submitPin('1234');
    await settle();
    failRequest(backend(), GROUP_URL, 'VALIDATION_ERROR', {
      details: [{ field: 'pin', issue: 'pattern' }],
    });
    await pending;
    await view();
    expect(isOpen(0)).toBe(true);
    expect(state.pinSet()).toBe(false);
    expect(messages()).toEqual([]);
    expect(root.querySelector('dialog .error span')?.textContent).toBe('FORM.ISSUE.PATTERN');
  });

  it('clears the previous server error when the dialog is opened again', async () => {
    const { root, rowButtons, footer, view, submitPin } = await render();
    rowButtons()[0].click();
    await view();
    const pending = submitPin('1234');
    await settle();
    failRequest(backend(), GROUP_URL, 'VALIDATION_ERROR', {
      details: [{ field: 'pin', issue: 'pattern' }],
    });
    await pending;
    await view();
    footer(0)[0].click();
    await view();
    rowButtons()[0].click();
    await view();
    expect(root.querySelector('dialog .error span')).toBeNull();
  });

  it.each([
    ['FORBIDDEN', undefined, 'USERS.FORBIDDEN_TARGET'],
    ['INTERNAL_ERROR', undefined, 'ERRORS.API.INTERNAL_ERROR'],
    ['VALIDATION_ERROR', [{ field: 'username', issue: 'taken' }], 'ERRORS.API.VALIDATION_ERROR'],
  ] as const)(
    'closes the dialog and reports with a toast on %s %j',
    async (code, details, message) => {
      const { state, rowButtons, isOpen, view, submitPin, messages } = await render();
      rowButtons()[0].click();
      await view();
      const pending = submitPin('1234');
      await settle();
      failRequest(
        backend(),
        GROUP_URL,
        code,
        details === undefined ? {} : { details: [...details] },
      );
      await pending;
      await view();
      expect(isOpen(0)).toBe(false);
      expect(state.pinSet()).toBe(false);
      expect(messages()).toEqual([['error', message]]);
    },
  );

  it('reports an error that is not from the backend with the generic message', async () => {
    const { rowButtons, isOpen, view, submitPin, messages } = await render();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(UsersApi.prototype, 'update').mockRejectedValue(new Error('offline'));
    rowButtons()[0].click();
    await view();
    await submitPin('1234');
    expect(isOpen(0)).toBe(false);
    expect(messages()).toEqual([['error', 'ERRORS.GENERIC.MESSAGE']]);
    expect(log).toHaveBeenCalled();
  });

  it('closes the PIN dialog from its cancel button', async () => {
    const { rowButtons, footer, isOpen, view } = await render();
    rowButtons()[0].click();
    await view();
    footer(0)[0].click();
    await view();
    expect(isOpen(0)).toBe(false);
  });

  it('asks for confirmation before removing the PIN', async () => {
    const { rowButtons, isOpen, footer, view } = await render({ pinSet: true });
    rowButtons()[1].click();
    await view();
    expect(isOpen(1)).toBe(true);
    expect(isOpen(0)).toBe(false);
    footer(1)[0].click();
    await view();
    expect(isOpen(1)).toBe(false);
  });

  it('removes the PIN once confirmed, then reports', async () => {
    const { state, rowButtons, isOpen, footer, view, messages } = await render({ pinSet: true });
    rowButtons()[1].click();
    await view();
    footer(1)[1].click();
    await settle();
    const request = backend().expectOne(`${API}${GROUP_URL}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ pin: null });
    expect(footer(1)[1].getAttribute('aria-busy')).toBe('true');
    request.flush({ data: { ...USER, pinSet: false } });
    await view();
    expect(state.pinSet()).toBe(false);
    expect(isOpen(1)).toBe(false);
    expect(messages()).toEqual([['success', 'PIN.REMOVED']]);
  });

  it('keeps the PIN and reports when the removal fails', async () => {
    const { state, rowButtons, isOpen, footer, view, messages } = await render({ pinSet: true });
    rowButtons()[1].click();
    await view();
    footer(1)[1].click();
    await settle();
    failRequest(backend(), GROUP_URL, 'FORBIDDEN');
    await view();
    expect(state.pinSet()).toBe(true);
    expect(isOpen(1)).toBe(false);
    expect(messages()).toEqual([['error', 'USERS.FORBIDDEN_TARGET']]);
  });

  it('labels the set dialog and the confirmation', async () => {
    const { root, rowButtons, view } = await render({ pinSet: true });
    rowButtons()[0].click();
    await view();
    const headings = [...root.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual(['PIN.SET_TITLE', 'PIN.REMOVE_TITLE']);
    expect(root.textContent).toContain('PIN.REMOVE_CONFIRM');
  });
});
