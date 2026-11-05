import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { fakeProfile, signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { ScopeSummary } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { buildProfilePatch, ProfilePage, toProfileModel } from './profile';

const FIRST = 'PROFILE.FIRST_NAME';
const LAST = 'PROFILE.LAST_NAME';
const EMAIL = 'PROFILE.EMAIL';
const PHONE = 'PROFILE.PHONE';

describe('toProfileModel', () => {
  it('turns null fields into empty strings', () => {
    expect(
      toProfileModel(fakeProfile({ firstName: null, lastName: null, email: null, phone: null })),
    ).toEqual({ firstName: '', lastName: '', email: '', phone: '', language: 'it' });
    expect(toProfileModel(fakeProfile()).lastName).toBe('Rossi');
  });

  it('is empty without a profile', () => {
    expect(toProfileModel(null)).toEqual({
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      language: '',
    });
  });
});

describe('buildProfilePatch', () => {
  const profile = fakeProfile();
  const same = toProfileModel(profile);

  it('is empty when nothing changed', () => {
    expect(buildProfilePatch(same, profile)).toEqual({});
  });

  it('includes only the changed fields, trimmed', () => {
    expect(buildProfilePatch({ ...same, firstName: '  Luigi ', phone: '333 1' }, profile)).toEqual({
      firstName: 'Luigi',
      phone: '333 1',
    });
  });

  it('turns an emptied or blank text field into null', () => {
    expect(buildProfilePatch({ ...same, lastName: '', email: '   ' }, profile)).toEqual({
      lastName: null,
      email: null,
    });
  });

  it('does not patch a field that was null and is still blank', () => {
    const empty = fakeProfile({ phone: null });
    expect(buildProfilePatch({ ...toProfileModel(empty), phone: ' ' }, empty)).toEqual({});
  });

  it('includes the language when it changed', () => {
    expect(buildProfilePatch({ ...same, language: 'en' }, profile)).toEqual({ language: 'en' });
  });

  it('is empty without a profile', () => {
    expect(buildProfilePatch(same, null)).toEqual({});
  });
});

async function render(overrides: Parameters<typeof fakeProfile>[0] = {}) {
  sessionStorage.clear();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn(overrides);
  const fixture = TestBed.createComponent(ProfilePage);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const save = () => root.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const alert = () => root.querySelector<HTMLElement>('fc-form-error');
  const rows = () =>
    Object.fromEntries(
      [...root.querySelectorAll('dl > div')].map((d) => [
        d.querySelector('dt')!.textContent,
        d.querySelector('dd')!.textContent,
      ]),
    );
  const value = (label: string) => (findControl(fixture, label) as HTMLInputElement).value;
  return { fixture, root, save, alert, rows, value };
}

describe('ProfilePage', () => {
  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('shows the read-only account data', async () => {
    const { root, rows } = await render();
    expect(root.querySelector('h1')?.textContent).toBe('PROFILE.TITLE');
    expect(rows()).toEqual({
      'PROFILE.USERNAME': 'mario.rossi',
      'PROFILE.ROLE': 'ROLE.CA',
      'PROFILE.GROUP': 'Gruppo Esempio',
      'PROFILE.SCOPE_LABEL': 'PROFILE.SCOPE.COMPANIES {"companies":1,"places":2}',
    });
    expect(root.querySelector('dl input')).toBeNull();
  });

  it('omits the group row for roles without a group', async () => {
    const { rows } = await render({ group: null, role: 'PSA', scope: { kind: 'platform' } });
    expect(Object.keys(rows())).not.toContain('PROFILE.GROUP');
  });

  it.each<[ScopeSummary, string]>([
    [{ kind: 'platform' }, 'PROFILE.SCOPE.PLATFORM'],
    [{ kind: 'dealer', groups: 3, groupIds: [] }, 'PROFILE.SCOPE.DEALER {"groups":3}'],
    [{ kind: 'group', groupId: 'g' }, 'PROFILE.SCOPE.GROUP'],
    [{ kind: 'places', groupId: 'g', places: 4 }, 'PROFILE.SCOPE.PLACES {"places":4}'],
    [{ kind: 'none' }, 'PROFILE.SCOPE.NONE'],
  ])('describes the perimeter %j', async (scope, text) => {
    const { rows } = await render({ scope });
    expect(rows()['PROFILE.SCOPE_LABEL']).toBe(text);
  });

  it('links to the change-password and sessions pages', async () => {
    const { root } = await render();
    const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/change-password', '/profile/sessions']);
  });

  it('renders nothing but the title without a profile', async () => {
    const { fixture, root } = await render();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    TestBed.inject(SessionService).expire();
    await fixture.whenStable();
    expect(root.querySelector('h1')).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('dl')).toBeNull();
  });

  it('pre-fills the form from the profile and disables Save until something changes', async () => {
    const { fixture, save, value } = await render();
    expect(value(FIRST)).toBe('Mario');
    expect(value(LAST)).toBe('Rossi');
    expect(value(EMAIL)).toBe('mario.rossi@example.com');
    expect(value(PHONE)).toBe('+39 02 1234567');
    expect((findControl(fixture, 'PROFILE.LANGUAGE') as HTMLSelectElement).value).toBe('it');
    expect(save().disabled).toBe(true);
    await typeInto(fixture, FIRST, 'Luigi');
    expect(save().disabled).toBe(false);
    await typeInto(fixture, FIRST, 'Mario');
    expect(save().disabled).toBe(true);
  });

  it('keeps the profile language selectable and touched on blur', async () => {
    const { fixture, save } = await render();
    const select = await typeInto(fixture, 'PROFILE.LANGUAGE', 'it');
    select.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect((select as HTMLSelectElement).value).toBe('it');
    expect(errorOf(fixture, 'PROFILE.LANGUAGE')).toBe('');
    expect(save().disabled).toBe(true);
  });

  it('labels each field with the right autocomplete and type', async () => {
    const { fixture } = await render();
    expect(findControl(fixture, FIRST).getAttribute('autocomplete')).toBe('given-name');
    expect(findControl(fixture, LAST).getAttribute('autocomplete')).toBe('family-name');
    expect((findControl(fixture, EMAIL) as HTMLInputElement).type).toBe('email');
    expect((findControl(fixture, PHONE) as HTMLInputElement).type).toBe('tel');
  });

  describe('saving', () => {
    it('patches only the changed fields and refreshes the session profile', async () => {
      const { fixture, save, value } = await render();
      await typeInto(fixture, FIRST, 'Luigi');
      await typeInto(fixture, PHONE, '');
      await submitForm(fixture);
      expect(save().getAttribute('aria-busy')).toBe('true');
      const patch = backend().expectOne(`${API}/v1/me`);
      expect(patch.request.method).toBe('PATCH');
      expect(patch.request.body).toEqual({ firstName: 'Luigi', phone: null });
      patch.flush({ data: fakeProfile({ firstName: 'Luigi', phone: null }) });
      await settle();
      await fixture.whenStable();
      expect(TestBed.inject(SessionService).me()?.firstName).toBe('Luigi');
      expect(value(FIRST)).toBe('Luigi');
      expect(value(PHONE)).toBe('');
      expect(save().disabled).toBe(true);
      expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
        kind: 'success',
        message: 'PROFILE.SAVED',
      });
    });
  });

  describe('validation', () => {
    it.each([
      [FIRST, 'a'.repeat(101), 'FORM.ISSUE.MAX_LENGTH'],
      [LAST, 'a'.repeat(101), 'FORM.ISSUE.MAX_LENGTH'],
      [EMAIL, 'not-an-email', 'FORM.ISSUE.FORMAT'],
      [PHONE, 'call me', 'FORM.ISSUE.PATTERN'],
      [PHONE, '1'.repeat(33), 'FORM.ISSUE.MAX_LENGTH'],
    ])('flags %s = %j', async (label, text, key) => {
      const { fixture } = await render();
      const control = await typeInto(fixture, label, text);
      control.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, label)).toBe(key);
    });

    it('does not submit an invalid form and focuses the field to fix', async () => {
      const { fixture } = await render();
      await typeInto(fixture, EMAIL, 'nope');
      await submitForm(fixture);
      expect(errorOf(fixture, EMAIL)).toBe('FORM.ISSUE.FORMAT');
      expect(document.activeElement).toBe(findControl(fixture, EMAIL));
      backend().expectNone(`${API}/v1/me`);
    });

    it('accepts an empty email (the field is optional)', async () => {
      const { fixture } = await render();
      const control = await typeInto(fixture, EMAIL, '');
      control.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, EMAIL)).toBe('');
    });
  });

  describe('server rejections', () => {
    async function rejectWith(code: string, details?: { field: string; issue: string }[]) {
      const ctx = await render();
      await typeInto(ctx.fixture, EMAIL, 'taken@example.com');
      await submitForm(ctx.fixture);
      failRequest(backend(), '/v1/me', code, { details });
      await settle();
      await ctx.fixture.whenStable();
      return ctx;
    }

    it('puts a 422 on the field it refers to', async () => {
      const { fixture, alert, save } = await rejectWith('VALIDATION_ERROR', [
        { field: 'email', issue: 'taken' },
        { field: 'language', issue: 'enum' },
      ]);
      expect(errorOf(fixture, EMAIL)).toBe('FORM.ISSUE.TAKEN');
      expect(errorOf(fixture, 'PROFILE.LANGUAGE')).toBe('FORM.ISSUE.ENUM');
      expect(alert()).toBeNull();
      expect(save().disabled).toBe(false);
      await typeInto(fixture, EMAIL, 'free@example.com');
      expect(errorOf(fixture, EMAIL)).toBe('');
    });

    it('maps the other editable fields too', async () => {
      const { fixture } = await rejectWith('VALIDATION_ERROR', [
        { field: 'firstName', issue: 'maxLength' },
        { field: 'lastName', issue: 'maxLength' },
        { field: 'phone', issue: 'pattern' },
      ]);
      expect(errorOf(fixture, FIRST)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(errorOf(fixture, LAST)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(errorOf(fixture, PHONE)).toBe('FORM.ISSUE.PATTERN');
    });

    it('shows a form-level message for a detail that matches no field', async () => {
      const { alert } = await rejectWith('VALIDATION_ERROR', [{ field: 'role', issue: 'unknown' }]);
      expect(alert()?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
      expect(document.activeElement).toBe(alert());
    });

    it('shows a form-level message for any other failure and keeps the profile unchanged', async () => {
      const { alert } = await rejectWith('FORBIDDEN');
      expect(alert()?.textContent).toContain('ERRORS.API.FORBIDDEN');
      expect(TestBed.inject(SessionService).me()?.email).toBe('mario.rossi@example.com');
    });
  });
});
