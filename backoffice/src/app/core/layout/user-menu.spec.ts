import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { I18nService } from '../i18n/i18n.service';
import { SessionService } from '../session/session.service';
import { UserMenu } from './user-menu';

async function render(profile: Parameters<typeof signIn>[0] = {}) {
  emulateNativeDialog();
  sessionStorage.clear();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? `[${key}]` : `[${key} ${JSON.stringify(params)}]`,
  );
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  signIn(profile);
  const fixture = TestBed.createComponent(UserMenu);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const q = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const trigger = () => q<HTMLButtonElement>('.trigger')!;
  const open = async () => {
    trigger().click();
    await fixture.whenStable();
  };
  const entries = () =>
    [...root.querySelectorAll<HTMLElement>('.entries a, .entries button')].map((e) =>
      e.textContent?.trim(),
    );
  return { fixture, root, q, trigger, open, entries };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserMenu', () => {
  it('shows the username on an accessible disclosure button, closed at first', async () => {
    const { q, trigger } = await render();
    expect(trigger().textContent).toContain('mario.rossi');
    expect(trigger().getAttribute('aria-label')).toBe(
      '[USER_MENU.LABEL {"username":"mario.rossi"}]',
    );
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe('user-menu-panel');
    expect(q('.entries')).toBeNull();
  });

  it('renders nothing but the dialog when nobody is signed in', async () => {
    const { fixture } = await render();
    TestBed.inject(SessionService).expire();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.trigger')).toBeNull();
    expect(fixture.nativeElement.querySelector('dialog')).not.toBeNull();
  });

  it('lists profile, change password and the two sign-out actions', async () => {
    const { open, entries, trigger, q } = await render();
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(q('#user-menu-panel')).not.toBeNull();
    expect(entries()).toEqual([
      '[USER_MENU.PROFILE]',
      '[USER_MENU.CHANGE_PASSWORD]',
      '[USER_MENU.LOGOUT]',
      '[USER_MENU.LOGOUT_ALL]',
    ]);
    expect(q<HTMLAnchorElement>('.entries a')!.getAttribute('href')).toBe('/profile');
  });

  it('offers only the sign-out actions while a temporary password is pending', async () => {
    const { open, entries } = await render({ passwordChangeRequired: true });
    await open();
    expect(entries()).toEqual(['[USER_MENU.LOGOUT]', '[USER_MENU.LOGOUT_ALL]']);
  });

  it('closes with the toggle, with Escape (returning the focus) and when a link is chosen', async () => {
    const { fixture, q, trigger, open } = await render();
    await open();
    trigger().click();
    await fixture.whenStable();
    expect(q('.entries')).toBeNull();

    await open();
    q('.entries a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(q('.entries')).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await open();
    q<HTMLAnchorElement>('.entries a')!.addEventListener('click', (e) => e.preventDefault());
    q<HTMLAnchorElement>('.entries a')!.click();
    await fixture.whenStable();
    expect(q('.entries')).toBeNull();
  });

  it('closes when the change-password link is chosen', async () => {
    const { fixture, q, open } = await render();
    await open();
    const link = q<HTMLAnchorElement>('.entries li:nth-child(2) a')!;
    expect(link.getAttribute('href')).toBe('/change-password');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    await fixture.whenStable();
    expect(q('.entries')).toBeNull();
  });

  it('ignores Escape when closed', async () => {
    const { fixture, root, trigger } = await render();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(document.activeElement).not.toBe(trigger());
  });

  it('closes on a click outside, not on a click inside', async () => {
    const { fixture, q, open } = await render();
    await open();
    q('.entries')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    expect(q('.entries')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    expect(q('.entries')).toBeNull();
  });

  it('signs out of the current session', async () => {
    const { fixture, q, open } = await render();
    await open();
    q<HTMLButtonElement>('.entries li:nth-child(3) button')!.click();
    await fixture.whenStable();
    expect(q('.entries')).toBeNull();
    backend()
      .expectOne(`${API}/v1/auth/logout`)
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(TestBed.inject(SessionService).status()).toBe('anonymous');
  });

  describe('sign out of every device', () => {
    async function ask() {
      const ctx = await render();
      await ctx.open();
      ctx.q<HTMLButtonElement>('.entries li:nth-child(4) button')!.click();
      await ctx.fixture.whenStable();
      const dialog = ctx.q<HTMLDialogElement>('dialog')!;
      const buttons = () => dialog.querySelectorAll<HTMLButtonElement>('footer button');
      return { ...ctx, dialog, buttons };
    }

    it('asks for a confirmation first, without calling the server', async () => {
      const { dialog, q } = await ask();
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.textContent).toContain('[USER_MENU.LOGOUT_ALL_CONFIRM]');
      expect(q('.entries')).toBeNull();
      backend().expectNone(`${API}/v1/auth/logout-all`);
    });

    it('can be cancelled', async () => {
      const { fixture, dialog, buttons } = await ask();
      buttons()[0].click();
      await fixture.whenStable();
      expect(dialog.hasAttribute('open')).toBe(false);
      backend().expectNone(`${API}/v1/auth/logout-all`);
    });

    it('revokes every session once confirmed, showing the wait', async () => {
      const { fixture, dialog, buttons } = await ask();
      buttons()[1].click();
      await fixture.whenStable();
      expect(buttons()[1].getAttribute('aria-busy')).toBe('true');
      backend()
        .expectOne(`${API}/v1/auth/logout-all`)
        .flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      await fixture.whenStable();
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(TestBed.inject(SessionService).status()).toBe('anonymous');
    });

    it('reports a failure and keeps the session', async () => {
      const { fixture, dialog, buttons } = await ask();
      buttons()[1].click();
      await fixture.whenStable();
      failRequest(backend(), '/v1/auth/logout-all', 'INTERNAL_ERROR');
      await settle();
      await fixture.whenStable();
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(TestBed.inject(SessionService).status()).toBe('authenticated');
      expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
        kind: 'error',
        message: '[ERRORS.API.INTERNAL_ERROR]',
      });
    });
  });
});
