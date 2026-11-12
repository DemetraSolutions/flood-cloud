import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl, typeInto } from '../../../testing/forms';
import { fakeProfile, signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { OwnPin } from './own-pin';

const PIN = 'PIN.LABEL';
const PASSWORD = 'PIN.CURRENT_PASSWORD';
const SECRET_PIN = '4821'; // gitleaks:allow (fake test value)
const SECRET_PASSWORD = 'Current-Pass-99'; // gitleaks:allow (fake test value)

async function render(pinSet = false) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  signIn({ pinSet });
  const fixture = TestBed.createComponent(OwnPin);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const dialogs = () => [...root.querySelectorAll('dialog')];
  const isOpen = (index: number) => dialogs()[index].hasAttribute('open');
  const actions = () => [...root.querySelectorAll<HTMLButtonElement>('p.actions-row button')];
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const submit = async (pin: string | null, password: string) => {
    if (pin !== null) {
      await typeInto(fixture, PIN, pin);
    }
    await typeInto(fixture, PASSWORD, password);
    root
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
  };
  const toast = () => TestBed.inject(ToastService).toasts();
  return { fixture, root, dialogs, isOpen, actions, view, submit, toast, logs };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('OwnPin', () => {
  it('says the PIN is not set and offers only to set it', async () => {
    const { root, actions } = await render(false);
    expect(root.querySelector('[role=status]')?.textContent).toBe('PIN.IS_NOT_SET');
    expect(actions().map((b) => b.textContent?.trim())).toEqual(['PIN.SET']);
  });

  it('says the PIN is set and offers to change or remove it', async () => {
    const { root, actions } = await render(true);
    expect(root.querySelector('[role=status]')?.textContent).toBe('PIN.IS_SET');
    expect(actions().map((b) => b.textContent?.trim())).toEqual(['PIN.CHANGE', 'PIN.REMOVE']);
  });

  it('renders nothing but the dialogs without a profile', async () => {
    const { fixture, root } = await render();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    TestBed.inject(SessionService).expire();
    await fixture.whenStable();
    expect(root.querySelector('[role=status]')).toBeNull();
    expect(root.querySelector('p.actions-row')).toBeNull();
  });

  it('opens the set dialog and the remove dialog', async () => {
    const { actions, isOpen, view, root } = await render(true);
    actions()[0].click();
    await view();
    expect(isOpen(0)).toBe(true);
    expect(isOpen(1)).toBe(false);
    expect(root.querySelector('dialog h2')?.textContent).toBe('PIN.SET_TITLE');
    root.querySelector<HTMLButtonElement>('dialog footer button')!.click();
    await view();
    expect(isOpen(0)).toBe(false);
    actions()[1].click();
    await view();
    expect(isOpen(1)).toBe(true);
    expect(root.querySelectorAll('dialog h2')[1].textContent).toBe('PIN.REMOVE_TITLE');
    root.querySelectorAll<HTMLButtonElement>('dialog footer')[1].querySelector('button')!.click();
    await view();
    expect(isOpen(1)).toBe(false);
  });

  it('sets the PIN with the current password, updates the session and reports', async () => {
    const { actions, isOpen, view, submit, toast, logs } = await render(false);
    actions()[0].click();
    await view();
    await submit(SECRET_PIN, SECRET_PASSWORD);
    const request = backend().expectOne(`${API}/v1/me/pin`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ currentPassword: SECRET_PASSWORD, pin: SECRET_PIN });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(TestBed.inject(SessionService).me()?.pinSet).toBe(true);
    expect(isOpen(0)).toBe(false);
    expect(toast()[0]).toMatchObject({ kind: 'success', message: 'PIN.SAVED' });
    for (const log of logs) {
      expect(log).not.toHaveBeenCalled();
    }
    for (const storage of [localStorage, sessionStorage]) {
      expect(JSON.stringify({ ...storage })).not.toContain(SECRET_PIN);
      expect(JSON.stringify({ ...storage })).not.toContain(SECRET_PASSWORD);
    }
  });

  it('removes the PIN with the current password and updates the session', async () => {
    const { actions, isOpen, view, submit, toast, root } = await render(true);
    actions()[1].click();
    await view();
    expect(root.querySelectorAll('dialog form')).toHaveLength(1);
    await submit(null, SECRET_PASSWORD);
    const request = backend().expectOne(`${API}/v1/me/pin`);
    expect(request.request.body).toEqual({ currentPassword: SECRET_PASSWORD, pin: null });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(TestBed.inject(SessionService).me()?.pinSet).toBe(false);
    expect(isOpen(1)).toBe(false);
    expect(toast()[0]).toMatchObject({ kind: 'success', message: 'PIN.REMOVED' });
  });

  it('does not touch the session profile when it vanished meanwhile', async () => {
    const { actions, view, submit, toast } = await render(false);
    actions()[0].click();
    await view();
    await submit(SECRET_PIN, SECRET_PASSWORD);
    vi.spyOn(TestBed.inject(SessionService), 'me').mockReturnValue(null);
    const setProfile = vi.spyOn(TestBed.inject(SessionService), 'setProfile');
    backend().expectOne(`${API}/v1/me/pin`).flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(setProfile).not.toHaveBeenCalled();
    expect(toast()[0]).toMatchObject({ kind: 'success', message: 'PIN.SAVED' });
  });

  it('keeps the dialog open with the busy state while waiting', async () => {
    const { actions, isOpen, view, submit, root } = await render(false);
    actions()[0].click();
    await view();
    await submit(SECRET_PIN, SECRET_PASSWORD);
    expect(root.querySelector('dialog footer button[type=submit]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    backend().expectOne(`${API}/v1/me/pin`).flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(isOpen(0)).toBe(false);
  });

  describe('errors', () => {
    async function open(pinSet = false) {
      const ctx = await render(pinSet);
      ctx.actions()[0].click();
      await ctx.view();
      await ctx.submit(SECRET_PIN, SECRET_PASSWORD);
      return ctx;
    }

    it('shows a 422 on the current password in the password field', async () => {
      const { fixture, view, isOpen, toast } = await open();
      failRequest(backend(), '/v1/me/pin', 'VALIDATION_ERROR', {
        details: [{ field: 'currentPassword', issue: 'incorrect' }],
      });
      await view();
      expect(errorOf(fixture, PASSWORD)).toBe('FORM.ISSUE.INCORRECT');
      expect(errorOf(fixture, PIN)).toBe('');
      expect(isOpen(0)).toBe(true);
      expect(toast()).toHaveLength(0);
    });

    it('shows a 422 on the PIN in the PIN field', async () => {
      const { fixture, view, isOpen } = await open();
      failRequest(backend(), '/v1/me/pin', 'VALIDATION_ERROR', {
        details: [{ field: 'pin', issue: 'pattern' }],
      });
      await view();
      expect(errorOf(fixture, PIN)).toBe('FORM.ISSUE.PATTERN');
      expect(errorOf(fixture, PASSWORD)).toBe('');
      expect(isOpen(0)).toBe(true);
    });

    it('clears the previous errors when the user submits again', async () => {
      const { fixture, view, submit } = await open();
      failRequest(backend(), '/v1/me/pin', 'VALIDATION_ERROR', {
        details: [{ field: 'pin', issue: 'pattern' }],
      });
      await view();
      await submit(null, SECRET_PASSWORD);
      expect(errorOf(fixture, PIN)).toBe('');
      backend().expectOne(`${API}/v1/me/pin`).flush(null, { status: 204, statusText: 'No' });
      await view();
    });

    it('treats INVALID_CREDENTIALS as a wrong password', async () => {
      const { fixture, view, isOpen } = await open();
      failRequest(backend(), '/v1/me/pin', 'INVALID_CREDENTIALS');
      await view();
      expect(errorOf(fixture, PASSWORD)).toBe('FORM.ISSUE.INCORRECT');
      expect(isOpen(0)).toBe(true);
    });

    it('tells how long to wait when rate limited, with Retry-After', async () => {
      const { fixture, view, isOpen } = await open();
      failRequest(backend(), '/v1/me/pin', 'RATE_LIMITED', { headers: { 'Retry-After': '42' } });
      await view();
      expect(errorOf(fixture, PASSWORD)).toBe('PIN.RATE_LIMITED_WAIT {"seconds":42}');
      expect(isOpen(0)).toBe(true);
    });

    it('closes the dialog and toasts the central message when rate limited without Retry-After', async () => {
      const { view, isOpen, toast } = await open();
      failRequest(backend(), '/v1/me/pin', 'RATE_LIMITED');
      await view();
      expect(isOpen(0)).toBe(false);
      expect(toast()[0]).toMatchObject({ kind: 'error', message: 'ERRORS.API.RATE_LIMITED' });
    });

    it('closes both dialogs and toasts the central message on any other failure', async () => {
      const { view, isOpen, toast, logs } = await open(true);
      failRequest(backend(), '/v1/me/pin', 'INTERNAL_ERROR');
      await view();
      expect(isOpen(0)).toBe(false);
      expect(isOpen(1)).toBe(false);
      expect(toast()[0]).toMatchObject({ kind: 'error', message: 'ERRORS.API.INTERNAL_ERROR' });
      expect(TestBed.inject(SessionService).me()?.pinSet).toBe(true);
      for (const log of logs) {
        expect(log).not.toHaveBeenCalled();
      }
    });

    it('shows a validation error that names no PIN or password field as the central message', async () => {
      const { view, isOpen, toast } = await open();
      failRequest(backend(), '/v1/me/pin', 'VALIDATION_ERROR', {
        details: [{ field: 'other', issue: 'unknown' }],
      });
      await view();
      expect(isOpen(0)).toBe(false);
      expect(toast()[0]).toMatchObject({ kind: 'error' });
    });
  });

  it('opens a dialog with the errors of a previous attempt cleared', async () => {
    const { fixture, actions, view, submit, isOpen } = await render(false);
    actions()[0].click();
    await view();
    await submit(SECRET_PIN, SECRET_PASSWORD);
    failRequest(backend(), '/v1/me/pin', 'INVALID_CREDENTIALS');
    await view();
    fixture.nativeElement.querySelector('dialog footer button')!.click();
    await view();
    expect(isOpen(0)).toBe(false);
    actions()[0].click();
    await view();
    expect(errorOf(fixture, PASSWORD)).toBe('');
    expect(findControl(fixture, PASSWORD).value).toBe('');
  });
});
