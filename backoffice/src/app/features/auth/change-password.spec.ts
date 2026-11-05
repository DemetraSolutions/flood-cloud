import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ChangePassword } from './change-password';

const CURRENT = 'AUTH.CHANGE_PASSWORD.CURRENT';
const NEW = 'AUTH.CHANGE_PASSWORD.NEW';
const CONFIRM = 'AUTH.CHANGE_PASSWORD.CONFIRM';
const GOOD = 'a-long-enough-password';

async function render(pending = false) {
  sessionStorage.clear();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  signIn({ passwordChangeRequired: pending });
  const fixture = TestBed.createComponent(ChangePassword);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const alert = () => root.querySelector<HTMLElement>('fc-form-error');
  const fill = async (current = 'Temp-pass-1', next = GOOD, confirm = next) => {
    await typeInto(fixture, CURRENT, current);
    await typeInto(fixture, NEW, next);
    await typeInto(fixture, CONFIRM, confirm);
  };
  const submitAndFail = async (code: string, details?: { field: string; issue: string }[]) => {
    await fill();
    await submitForm(fixture);
    failRequest(backend(), '/v1/me/password', code, { details });
    await settle();
    await fixture.whenStable();
  };
  return { fixture, root, navigateByUrl, alert, fill, submitAndFail };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ChangePassword', () => {
  it('explains the mandatory change after a temporary password, with no way out', async () => {
    const { root } = await render(true);
    expect(root.querySelector('h1')?.textContent).toBe('AUTH.CHANGE_PASSWORD.TITLE');
    expect(root.querySelector('p')?.textContent).toContain('AUTH.CHANGE_PASSWORD.INTRO_REQUIRED');
    expect(root.querySelector('a')).toBeNull();
  });

  it('offers a voluntary change with a way back to the profile', async () => {
    const { root } = await render();
    expect(root.querySelector('p')?.textContent).toContain('AUTH.CHANGE_PASSWORD.INTRO');
    expect(root.querySelector('p')?.textContent).not.toContain('INTRO_REQUIRED');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/profile');
  });

  it('labels the three password fields and states the policy', async () => {
    const { fixture, root } = await render();
    expect(findControl(fixture, CURRENT).getAttribute('autocomplete')).toBe('current-password');
    expect(findControl(fixture, NEW).getAttribute('autocomplete')).toBe('new-password');
    expect(findControl(fixture, CONFIRM).getAttribute('autocomplete')).toBe('new-password');
    for (const label of [CURRENT, NEW, CONFIRM]) {
      expect((findControl(fixture, label) as HTMLInputElement).type).toBe('password');
    }
    expect(root.querySelector('.hint')?.textContent).toContain('{"min":12,"max":128}');
    expect(findControl(fixture, NEW).getAttribute('aria-describedby')).toContain(
      root.querySelector('.hint')!.id,
    );
  });

  describe('client validation', () => {
    it('requires every field and sends nothing', async () => {
      const { fixture } = await render();
      await submitForm(fixture);
      for (const label of [CURRENT, NEW, CONFIRM]) {
        expect(errorOf(fixture, label)).toBe('FORM.ISSUE.REQUIRED');
      }
      expect(document.activeElement).toBe(findControl(fixture, CURRENT));
      backend().expectNone(`${API}/v1/me/password`);
    });

    it('shows the required error of the current password once it was left', async () => {
      const { fixture } = await render();
      findControl(fixture, CURRENT).dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, CURRENT)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('rejects a password that is too short, only after the field was touched', async () => {
      const { fixture } = await render();
      await typeInto(fixture, NEW, 'short');
      expect(errorOf(fixture, NEW)).toBe('');
      findControl(fixture, NEW).dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, NEW)).toBe('FORM.ISSUE.TOO_SHORT');
    });

    it('accepts exactly the minimum and maximum lengths', async () => {
      const { fixture } = await render();
      for (const length of [12, 128]) {
        await typeInto(fixture, NEW, 'a'.repeat(length));
        findControl(fixture, NEW).dispatchEvent(new Event('blur'));
        await fixture.whenStable();
        expect(errorOf(fixture, NEW)).toBe('');
      }
    });

    it('rejects a password that is too long', async () => {
      const { fixture } = await render();
      await typeInto(fixture, NEW, 'a'.repeat(129));
      findControl(fixture, NEW).dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, NEW)).toBe('FORM.ISSUE.TOO_LONG');
    });

    it('requires the confirmation to match, checked on the client only', async () => {
      const { fixture } = await render();
      await typeInto(fixture, NEW, GOOD);
      await typeInto(fixture, CONFIRM, 'something-else-entirely');
      findControl(fixture, CONFIRM).dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, CONFIRM)).toBe('FORM.ISSUE.MISMATCH');
      await typeInto(fixture, CONFIRM, GOOD);
      expect(errorOf(fixture, CONFIRM)).toBe('');
    });
  });

  describe('success', () => {
    async function change(pending: boolean) {
      const ctx = await render(pending);
      await ctx.fill();
      await submitForm(ctx.fixture);
      const put = backend().expectOne(`${API}/v1/me/password`);
      expect(put.request.method).toBe('PUT');
      expect(put.request.body).toEqual({ currentPassword: 'Temp-pass-1', newPassword: GOOD });
      put.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      const me = backend().expectOne(`${API}/v1/me`);
      me.flush({ data: { ...TestBed.inject(SessionService).me(), passwordChangeRequired: false } });
      await settle();
      await ctx.fixture.whenStable();
      return ctx;
    }

    it('after a mandatory change reloads the profile, thanks the user and opens the home page', async () => {
      const { navigateByUrl } = await change(true);
      expect(TestBed.inject(SessionService).status()).toBe('authenticated');
      expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
        kind: 'success',
        message: 'AUTH.CHANGE_PASSWORD.SUCCESS',
      });
      expect(navigateByUrl).toHaveBeenCalledWith('/');
    });

    it('after a voluntary change goes back to the profile', async () => {
      const { navigateByUrl } = await change(false);
      expect(navigateByUrl).toHaveBeenCalledWith('/profile');
    });

    it('empties the password fields', async () => {
      const { fixture } = await change(false);
      for (const label of [CURRENT, NEW, CONFIRM]) {
        expect((findControl(fixture, label) as HTMLInputElement).value).toBe('');
        expect(errorOf(fixture, label)).toBe('');
      }
    });
  });

  describe('server rejections', () => {
    async function renderAndFail(issue: string, field: string) {
      const ctx = await render(true);
      await ctx.submitAndFail('VALIDATION_ERROR', [{ field, issue }]);
      return ctx;
    }

    it('puts a wrong current password on its field, without a form-level message', async () => {
      const { fixture, alert } = await renderAndFail('incorrect', 'currentPassword');
      expect(errorOf(fixture, CURRENT)).toBe('FORM.ISSUE.INCORRECT');
      expect(errorOf(fixture, NEW)).toBe('');
      expect(alert()).toBeNull();
    });

    it.each([
      ['tooShort', 'FORM.ISSUE.TOO_SHORT'],
      ['tooLong', 'FORM.ISSUE.TOO_LONG'],
      ['sameAsUsername', 'FORM.ISSUE.SAME_AS_USERNAME'],
      ['invalidCharacters', 'FORM.ISSUE.INVALID_CHARACTERS'],
      ['reused', 'FORM.ISSUE.REUSED'],
    ])('puts the %s policy violation on the new password', async (issue, key) => {
      const { fixture } = await renderAndFail(issue, 'newPassword');
      expect(errorOf(fixture, NEW)).toBe(key);
    });

    it('keeps only the first issue of a field', async () => {
      const ctx = await render();
      await ctx.submitAndFail('VALIDATION_ERROR', [
        { field: 'newPassword', issue: 'tooShort' },
        { field: 'newPassword', issue: 'sameAsUsername' },
      ]);
      expect(errorOf(ctx.fixture, NEW)).toBe('FORM.ISSUE.TOO_SHORT');
    });

    it('empties the current password when it was wrong, keeping the new one and the error', async () => {
      const { fixture } = await renderAndFail('incorrect', 'currentPassword');
      expect((findControl(fixture, CURRENT) as HTMLInputElement).value).toBe('');
      expect(errorOf(fixture, CURRENT)).toBe('FORM.ISSUE.INCORRECT');
      expect((findControl(fixture, NEW) as HTMLInputElement).value).toBe(GOOD);
      expect((findControl(fixture, CONFIRM) as HTMLInputElement).value).toBe(GOOD);
    });

    it('keeps every field after a policy violation', async () => {
      const { fixture } = await renderAndFail('tooShort', 'newPassword');
      expect((findControl(fixture, CURRENT) as HTMLInputElement).value).toBe('Temp-pass-1');
      expect((findControl(fixture, NEW) as HTMLInputElement).value).toBe(GOOD);
      expect((findControl(fixture, CONFIRM) as HTMLInputElement).value).toBe(GOOD);
    });

    it('empties only the current password after a rate limit', async () => {
      const ctx = await render();
      await ctx.submitAndFail('RATE_LIMITED');
      expect((findControl(ctx.fixture, CURRENT) as HTMLInputElement).value).toBe('');
      expect(errorOf(ctx.fixture, CURRENT)).toBe('');
      expect((findControl(ctx.fixture, NEW) as HTMLInputElement).value).toBe(GOOD);
    });

    it('removes the server error when the user edits the field', async () => {
      const { fixture } = await renderAndFail('incorrect', 'currentPassword');
      await typeInto(fixture, CURRENT, 'another-one');
      expect(errorOf(fixture, CURRENT)).toBe('');
    });

    it('shows a form-level message for a detail that matches no field', async () => {
      const { alert } = await renderAndFail('required', '(body)');
      expect(alert()?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
      expect(document.activeElement).toBe(alert());
    });

    it('shows a form-level message for other failures', async () => {
      const ctx = await render();
      await ctx.submitAndFail('RATE_LIMITED');
      expect(ctx.alert()?.textContent).toContain('ERRORS.API.RATE_LIMITED');
      expect(document.activeElement).toBe(ctx.alert());
    });

    it('shows a form-level message when the profile cannot be reloaded after the change', async () => {
      const { fixture, alert, fill } = await render(true);
      await fill();
      await submitForm(fixture);
      backend().expectOne(`${API}/v1/me/password`).flush(null, { status: 204, statusText: 'x' });
      await settle();
      failRequest(backend(), '/v1/me', 'INTERNAL_ERROR');
      await settle();
      await fixture.whenStable();
      expect(alert()?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(TestBed.inject(SessionService).status()).toBe('passwordChangeRequired');
    });

    it('lets the user retry after a rejection', async () => {
      const { fixture, alert, fill } = await renderAndFail('incorrect', 'currentPassword');
      await fill('right-one');
      await submitForm(fixture);
      expect(alert()).toBeNull();
      backend().expectOne(`${API}/v1/me/password`).flush(null, { status: 204, statusText: 'x' });
      await settle();
      backend()
        .expectOne(`${API}/v1/me`)
        .flush({ data: TestBed.inject(SessionService).me() });
      await settle();
    });
  });
});
