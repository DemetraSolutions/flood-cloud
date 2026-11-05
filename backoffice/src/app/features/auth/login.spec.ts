import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  API,
  backend,
  errorBody,
  failRequest,
  provideApiTesting,
  settle,
  tokenBody,
} from '../../../testing/api';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { fakeProfile } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { Login } from './login';

async function render(returnUrl?: string) {
  sessionStorage.clear();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(Login);
  if (returnUrl !== undefined) {
    fixture.componentRef.setInput('returnUrl', returnUrl);
  }
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const submitButton = () => root.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const alert = () => root.querySelector<HTMLElement>('fc-form-error');
  const fill = async (username = 'mario.rossi', password = 'Secret-1234') => {
    await typeInto(fixture, 'AUTH.LOGIN.USERNAME', username);
    await typeInto(fixture, 'AUTH.LOGIN.PASSWORD', password);
  };
  const signIn = async (profile = fakeProfile()) => {
    await submitForm(fixture);
    backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
    await settle();
    backend().expectOne(`${API}/v1/me`).flush({ data: profile });
    await settle();
    await fixture.whenStable();
  };
  return { fixture, root, navigateByUrl, submitButton, alert, fill, signIn };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Login', () => {
  it('has a heading, labelled fields with the right autocomplete and a submit button', async () => {
    const { fixture, root, submitButton } = await render();
    expect(root.querySelector('h1')?.textContent).toBe('AUTH.LOGIN.TITLE');
    expect(findControl(fixture, 'AUTH.LOGIN.USERNAME').getAttribute('autocomplete')).toBe(
      'username',
    );
    const password = findControl(fixture, 'AUTH.LOGIN.PASSWORD') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    const username = findControl(fixture, 'AUTH.LOGIN.USERNAME');
    expect(username.getAttribute('autocapitalize')).toBe('none');
    expect(username.getAttribute('spellcheck')).toBe('false');
    expect(submitButton().textContent?.trim()).toBe('AUTH.LOGIN.SUBMIT');
    expect(root.querySelector('form')?.hasAttribute('novalidate')).toBe(true);
    expect(root.querySelector('main')).not.toBeNull();
  });

  it('shows and hides the password with an accessible checkbox', async () => {
    const { fixture } = await render();
    const password = findControl(fixture, 'AUTH.LOGIN.PASSWORD') as HTMLInputElement;
    const toggle = findControl(fixture, 'AUTH.LOGIN.SHOW_PASSWORD') as HTMLInputElement;
    expect(toggle.type).toBe('checkbox');
    toggle.click();
    await fixture.whenStable();
    expect(password.type).toBe('text');
    toggle.click();
    await fixture.whenStable();
    expect(password.type).toBe('password');
  });

  it('does not show errors on a fresh form', async () => {
    const { fixture } = await render();
    expect(errorOf(fixture, 'AUTH.LOGIN.USERNAME')).toBe('');
  });

  it('shows the required error of a field after it was left empty', async () => {
    const { fixture } = await render();
    const username = findControl(fixture, 'AUTH.LOGIN.USERNAME');
    username.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(errorOf(fixture, 'AUTH.LOGIN.USERNAME')).toBe('FORM.ISSUE.REQUIRED');
    expect(errorOf(fixture, 'AUTH.LOGIN.PASSWORD')).toBe('');
    expect(username.getAttribute('aria-invalid')).toBe('true');
    findControl(fixture, 'AUTH.LOGIN.PASSWORD').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(errorOf(fixture, 'AUTH.LOGIN.PASSWORD')).toBe('FORM.ISSUE.REQUIRED');
  });

  it('shows every missing field on submit, focuses the first and sends nothing', async () => {
    const { fixture } = await render();
    await submitForm(fixture);
    expect(errorOf(fixture, 'AUTH.LOGIN.USERNAME')).toBe('FORM.ISSUE.REQUIRED');
    expect(errorOf(fixture, 'AUTH.LOGIN.PASSWORD')).toBe('FORM.ISSUE.REQUIRED');
    expect(document.activeElement).toBe(findControl(fixture, 'AUTH.LOGIN.USERNAME'));
    backend().expectNone(`${API}/v1/auth/login`);
  });

  it('focuses the password when only that is missing', async () => {
    const { fixture } = await render();
    await typeInto(fixture, 'AUTH.LOGIN.USERNAME', 'mario.rossi');
    await submitForm(fixture);
    expect(document.activeElement).toBe(findControl(fixture, 'AUTH.LOGIN.PASSWORD'));
  });

  describe('success', () => {
    it('opens the home page', async () => {
      const { fill, signIn, navigateByUrl } = await render();
      await fill();
      await signIn();
      expect(navigateByUrl).toHaveBeenCalledWith('/');
      expect(TestBed.inject(SessionService).status()).toBe('authenticated');
    });

    it('opens the page the user came from', async () => {
      const { fill, signIn, navigateByUrl } = await render('/profile/sessions?x=1');
      await fill();
      await signIn();
      expect(navigateByUrl).toHaveBeenCalledWith('/profile/sessions?x=1');
    });

    it.each([
      'https://evil.example/',
      '//evil.example',
      '/\\evil',
      'javascript:alert(1)',
      '/login',
    ])('ignores the unsafe return url %s', async (returnUrl) => {
      const { fill, signIn, navigateByUrl } = await render(returnUrl);
      await fill();
      await signIn();
      expect(navigateByUrl).toHaveBeenCalledWith('/');
    });

    it('goes to the change-password page after a temporary password, ignoring the return url', async () => {
      const { fill, signIn, navigateByUrl } = await render('/profile');
      await fill();
      await signIn(fakeProfile({ passwordChangeRequired: true }));
      expect(navigateByUrl).toHaveBeenCalledWith('/change-password');
    });

    it('sends the credentials exactly as typed and persists no password', async () => {
      const { fixture, fill } = await render();
      await fill(' mario ', ' pass word ');
      await submitForm(fixture);
      const request = backend().expectOne(`${API}/v1/auth/login`);
      expect(request.request.body).toEqual({ username: ' mario ', password: ' pass word ' });
      request.flush(errorBody('INVALID_CREDENTIALS'), { status: 401, statusText: 'x' });
      await settle();
      expect(JSON.stringify(sessionStorage) + JSON.stringify(localStorage)).not.toContain(
        'pass word',
      );
    });
  });

  describe('failure', () => {
    async function failWith(code: string, headers?: Record<string, string>) {
      const ctx = await render();
      await ctx.fill();
      await submitForm(ctx.fixture);
      failRequest(backend(), '/v1/auth/login', code, { headers });
      await settle();
      await ctx.fixture.whenStable();
      return ctx;
    }

    it('answers wrong credentials with one generic message, focused, keeping the username', async () => {
      const { fixture, alert, submitButton } = await failWith('INVALID_CREDENTIALS');
      expect(alert()?.textContent).toContain('AUTH.LOGIN.INVALID_CREDENTIALS');
      expect(alert()?.getAttribute('role')).toBe('alert');
      expect(document.activeElement).toBe(alert());
      expect((findControl(fixture, 'AUTH.LOGIN.USERNAME') as HTMLInputElement).value).toBe(
        'mario.rossi',
      );
      expect((findControl(fixture, 'AUTH.LOGIN.PASSWORD') as HTMLInputElement).value).toBe('');
      expect(errorOf(fixture, 'AUTH.LOGIN.PASSWORD')).toBe('');
      expect(submitButton().disabled).toBe(false);
      expect(TestBed.inject(SessionService).status()).toBe('unknown');
    });

    it('does not flag the emptied password as missing until the user interacts again', async () => {
      const { fixture } = await failWith('INVALID_CREDENTIALS');
      const password = findControl(fixture, 'AUTH.LOGIN.PASSWORD');
      password.dispatchEvent(new Event('blur')); // focus moving to the message
      await fixture.whenStable();
      expect(errorOf(fixture, 'AUTH.LOGIN.PASSWORD')).toBe('');
      password.dispatchEvent(new Event('blur')); // a later, genuine blur
      await fixture.whenStable();
      expect(errorOf(fixture, 'AUTH.LOGIN.PASSWORD')).toBe('FORM.ISSUE.REQUIRED');
    });

    it('hides the password again after a failure', async () => {
      const ctx = await render();
      (findControl(ctx.fixture, 'AUTH.LOGIN.SHOW_PASSWORD') as HTMLInputElement).click();
      await ctx.fixture.whenStable();
      await ctx.fill();
      await submitForm(ctx.fixture);
      failRequest(backend(), '/v1/auth/login', 'INVALID_CREDENTIALS');
      await settle();
      await ctx.fixture.whenStable();
      expect((findControl(ctx.fixture, 'AUTH.LOGIN.PASSWORD') as HTMLInputElement).type).toBe(
        'password',
      );
    });

    it('tells how many seconds to wait after a 429 with Retry-After', async () => {
      const { alert } = await failWith('RATE_LIMITED', { 'Retry-After': '42' });
      expect(alert()?.textContent).toContain('AUTH.LOGIN.RATE_LIMITED_WAIT {"seconds":42}');
    });

    it('uses the generic rate-limit message without Retry-After', async () => {
      const { alert } = await failWith('RATE_LIMITED');
      expect(alert()?.textContent).toContain('ERRORS.API.RATE_LIMITED');
    });

    it('reports an unreachable service', async () => {
      const { fixture, alert, fill } = await render();
      await fill();
      await submitForm(fixture);
      backend().expectOne(`${API}/v1/auth/login`).error(new ProgressEvent('error'));
      await settle();
      await fixture.whenStable();
      expect(alert()?.textContent).toContain('ERRORS.API.NETWORK_ERROR');
    });

    it('reports an unexpected failure generically and logs it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, alert, fill } = await render();
      await fill();
      await submitForm(fixture);
      backend().expectOne(`${API}/v1/auth/login`).flush({});
      await settle();
      await fixture.whenStable();
      expect(alert()?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
      expect(console.error).toHaveBeenCalledOnce();
    });

    it('clears the message when the user tries again', async () => {
      const { fixture, alert, fill } = await failWith('INVALID_CREDENTIALS');
      await fill('mario.rossi', 'other-pass');
      await submitForm(fixture);
      expect(alert()).toBeNull();
      backend().expectOne(`${API}/v1/auth/login`).flush(errorBody('INVALID_CREDENTIALS'), {
        status: 401,
        statusText: 'x',
      });
    });
  });

  it('shows a waiting state and ignores a second submit while the request runs', async () => {
    const { fixture, fill, submitButton } = await render();
    await fill();
    await submitForm(fixture);
    expect(submitButton().getAttribute('aria-busy')).toBe('true');
    expect(submitButton().disabled).toBe(true);
    await submitForm(fixture);
    const request = backend().expectOne(`${API}/v1/auth/login`);
    request.flush(errorBody('INVALID_CREDENTIALS'), { status: 401, statusText: 'x' });
    await settle();
    await fixture.whenStable();
    expect(submitButton().getAttribute('aria-busy')).toBeNull();
  });
});
