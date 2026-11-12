import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { fakeProfile, signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { ScopeSummary } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { posKey, POS_BOOLEAN_OPTIONS } from '../../core/users/pos.catalog';
import { AvatarEncoder } from '../../shared/util/avatar-encoder';
import { blankPos, posModelOf } from '../users/user-model';
import { fakePos } from '../../../testing/users';
import { Profile } from '../../core/session/session.types';
import { buildProfilePatch, hasPosPreferences, ProfilePage, toProfileModel } from './profile';

const FIRST = 'PROFILE.FIRST_NAME';
const LAST = 'PROFILE.LAST_NAME';
const EMAIL = 'PROFILE.EMAIL';
const PHONE = 'PROFILE.PHONE';
const IMAGE = 'data:image/webp;base64,AAAA';
const QUICK = 'USERS.POS.OPTION.QUICK_DISCOUNT';

const LANGUAGE_OF_PROFILE = 'it';

/** Group features with the cash register enabled (or not). */
const features = (cash: boolean) => ({ cash }) as unknown as Profile['groupFeatures'];
const withPos = (overrides: Partial<Profile> = {}) =>
  fakeProfile({ groupFeatures: features(true), ...overrides });

describe('hasPosPreferences', () => {
  it('needs the POS enabled and the cash feature in the group', () => {
    expect(hasPosPreferences(withPos())).toBe(true);
    expect(hasPosPreferences(fakeProfile({ groupFeatures: features(false) }))).toBe(false);
    expect(hasPosPreferences(fakeProfile({ groupFeatures: null }))).toBe(false);
    expect(hasPosPreferences(withPos({ pos: fakePos({ enabled: false }) }))).toBe(false);
  });

  it('is false for the roles without a point of sale and without a profile', () => {
    expect(hasPosPreferences(withPos({ role: 'PSA', pos: fakePos({ enabled: false }) }))).toBe(
      false,
    );
    expect(hasPosPreferences(withPos({ role: 'D', pos: fakePos({ enabled: false }) }))).toBe(false);
    expect(hasPosPreferences(null)).toBe(false);
  });
});

describe('toProfileModel', () => {
  it('turns null fields into empty strings and carries avatar and preferences', () => {
    const model = toProfileModel(
      fakeProfile({ firstName: null, lastName: null, email: null, phone: null }),
    );
    expect(model).toMatchObject({
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      language: LANGUAGE_OF_PROFILE,
      avatar: '',
    });
    expect(model.pos.options).toEqual(posModelOf(fakePos()).options);
    expect(toProfileModel(fakeProfile()).lastName).toBe('Rossi');
    expect(toProfileModel(fakeProfile({ avatar: IMAGE })).avatar).toBe(IMAGE);
  });

  it('is empty without a profile', () => {
    expect(toProfileModel(null)).toEqual({
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      language: '',
      avatar: '',
      pos: { options: blankPos().options },
    });
  });
});

describe('buildProfilePatch', () => {
  const profile = fakeProfile();
  const same = toProfileModel(profile);
  const posProfile = withPos();
  const posSame = toProfileModel(posProfile);

  it('is empty when nothing changed', () => {
    expect(buildProfilePatch(same, profile)).toEqual({});
    expect(buildProfilePatch(posSame, posProfile)).toEqual({});
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

  it('sends a new avatar, and null when it was removed', () => {
    expect(buildProfilePatch({ ...same, avatar: IMAGE }, profile)).toEqual({ avatar: IMAGE });
    const withAvatar = fakeProfile({ avatar: IMAGE });
    expect(buildProfilePatch(toProfileModel(withAvatar), withAvatar)).toEqual({});
    expect(buildProfilePatch({ ...toProfileModel(withAvatar), avatar: '' }, withAvatar)).toEqual({
      avatar: null,
    });
  });

  it('sends the changed POS preferences only when the profile has them', () => {
    const options = { ...posSame.pos.options, quickDiscount: '10', side: 'sx' };
    const model = { ...posSame, pos: { options } };
    expect(buildProfilePatch(model, posProfile)).toEqual({
      pos: { options: { quickDiscount: 10, side: 'sx' } },
    });
    const cashOff = fakeProfile({ groupFeatures: features(false) });
    expect(buildProfilePatch({ ...toProfileModel(cashOff), pos: { options } }, cashOff)).toEqual(
      {},
    );
  });

  it('never sends price lists nor the default one', () => {
    const options = {
      ...posSame.pos.options,
      defaultPriceListId: 'pl1',
      priceLists: [{ id: 'pl1', isDefault: true }] as never,
    };
    expect(buildProfilePatch({ ...posSame, pos: { options } }, posProfile)).toEqual({});
  });

  it('is empty without a profile', () => {
    expect(buildProfilePatch(same, null)).toEqual({});
  });
});

async function render(
  overrides: Parameters<typeof fakeProfile>[0] = {},
  { waitForRequests = true } = {},
) {
  sessionStorage.clear();
  const encode = vi.fn<(file: File) => Promise<string>>();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter([]),
      { provide: AvatarEncoder, useValue: { encode } },
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn(overrides);
  const fixture = TestBed.createComponent(ProfilePage);
  document.body.appendChild(fixture.nativeElement);
  if (waitForRequests) {
    await fixture.whenStable();
  } else {
    // A pending request keeps the fixture unstable until the test answers it.
    fixture.detectChanges();
    await settle();
  }
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
  const settled = async () => {
    await settle();
    await fixture.whenStable();
  };
  return { fixture, root, save, alert, rows, value, encode, settled };
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

  it('has no initials without a profile', async () => {
    const { fixture } = await render();
    const page = fixture.componentInstance as unknown as { initials(): string };
    expect(page.initials()).toBe('MR');
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    TestBed.inject(SessionService).expire();
    expect(page.initials()).toBe('');
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

  describe('avatar', () => {
    it('shows the initials of the user and no image', async () => {
      const { root } = await render();
      expect(root.querySelector('legend')?.textContent).toBe('AVATAR.LABEL');
      expect(root.querySelector('fc-avatar')?.textContent?.trim()).toBe('MR');
      expect(root.querySelector('fc-avatar img')).toBeNull();
    });

    it('patches a new avatar chosen with the file input', async () => {
      const { fixture, root, save, encode, settled } = await render();
      encode.mockResolvedValue(IMAGE);
      const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(picker, 'files', {
        configurable: true,
        value: { item: () => new File(['x'], 'a.png', { type: 'image/png' }) },
      });
      picker.dispatchEvent(new Event('change'));
      await settled();
      expect(save().disabled).toBe(false);
      await submitForm(fixture);
      const patch = backend().expectOne(`${API}/v1/me`);
      expect(patch.request.body).toEqual({ avatar: IMAGE });
      patch.flush({ data: fakeProfile({ avatar: IMAGE }) });
      await settled();
      expect(TestBed.inject(SessionService).me()?.avatar).toBe(IMAGE);
      expect(root.querySelector('fc-avatar img')?.getAttribute('src')).toBe(IMAGE);
    });

    it('removes the avatar with null', async () => {
      const { fixture, root, settled } = await render({ avatar: IMAGE });
      expect(root.querySelector('fc-avatar img')).not.toBeNull();
      const remove = [...root.querySelectorAll<HTMLButtonElement>('fieldset button')].find(
        (b) => b.textContent?.trim() === 'AVATAR.REMOVE',
      )!;
      remove.click();
      await settled();
      await submitForm(fixture);
      const patch = backend().expectOne(`${API}/v1/me`);
      expect(patch.request.body).toEqual({ avatar: null });
      patch.flush({ data: fakeProfile({ avatar: null }) });
      await settled();
      expect(root.querySelector('fc-avatar img')).toBeNull();
    });
  });

  describe('point of sale preferences', () => {
    const FLAG = `USERS.POS.OPTION.${posKey(POS_BOOLEAN_OPTIONS[0])}`;

    it.each([
      ['without the cash feature', { groupFeatures: features(false) }],
      ['without feature flags', { groupFeatures: null }],
      [
        'with the POS disabled',
        { groupFeatures: features(true), pos: fakePos({ enabled: false }) },
      ],
    ])('hides the section %s', async (_name, overrides) => {
      const { root } = await render(overrides);
      expect(root.querySelector('fc-pos-options-fields')).toBeNull();
      expect(root.querySelector('#pos-heading')).toBeNull();
      backend().expectNone(`${API}/v1/groups/${fakeProfile().groupId}/product-favorites`);
    });

    it('shows the section with POS and the cash feature, without reading the favorites', async () => {
      const { fixture, root, value } = await render({ groupFeatures: features(true) });
      expect(root.querySelector('#pos-heading')?.textContent).toBe('PROFILE.POS_PREFERENCES');
      expect(root.querySelector('fc-pos-options-fields')).not.toBeNull();
      expect(value(QUICK)).toBe('');
      expect(findControl(fixture, FLAG)).toBeTruthy();
      backend().expectNone(`${API}/v1/groups/${fakeProfile().groupId}/product-favorites`);
    });

    it('sends only the changed preferences of the user', async () => {
      const { fixture, save, settled } = await render({ groupFeatures: features(true) });
      const flag = findControl(fixture, FLAG) as HTMLInputElement;
      flag.checked = true;
      flag.dispatchEvent(new Event('change'));
      await typeInto(fixture, QUICK, '12.5');
      expect(save().disabled).toBe(false);
      await submitForm(fixture);
      const patch = backend().expectOne(`${API}/v1/me`);
      expect(patch.request.body).toEqual({
        pos: { options: { [POS_BOOLEAN_OPTIONS[0]]: true, quickDiscount: 12.5 } },
      });
      patch.flush({ data: fakeProfile({ groupFeatures: features(true) }) });
      await settled();
    });

    it.each([
      ['abc', 'FORM.ISSUE.TYPE'],
      ['-1', 'FORM.ISSUE.MINIMUM'],
      ['101', 'FORM.ISSUE.MAXIMUM'],
    ])('rejects the quick discount %j before sending', async (text, key) => {
      const { fixture } = await render({ groupFeatures: features(true) });
      const control = await typeInto(fixture, QUICK, text);
      control.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(errorOf(fixture, QUICK)).toBe(key);
      await submitForm(fixture);
      backend().expectNone(`${API}/v1/me`);
    });

    it('accepts a valid or empty quick discount', async () => {
      const { fixture } = await render({ groupFeatures: features(true) });
      for (const text of ['100', '0', '']) {
        const control = await typeInto(fixture, QUICK, text);
        control.dispatchEvent(new Event('blur'));
        await fixture.whenStable();
        expect(errorOf(fixture, QUICK)).toBe('');
      }
    });

    it('reads the favorites lists of the group with products:read', async () => {
      const profile = fakeProfile({
        groupFeatures: features(true),
        permissions: ['profile:read', 'profile:update', 'products:read'],
      });
      const { fixture, settled } = await render(profile, { waitForRequests: false });
      const request = backend().expectOne(`${API}/v1/groups/${profile.groupId}/product-favorites`);
      expect(request.request.method).toBe('GET');
      request.flush({ data: [{ id: 'f1', name: 'Bar' }] });
      await settled();
      const select = findControl(fixture, 'USERS.POS.OPTION.FAVORITES_ID') as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent?.trim())).toContain('Bar');
    });

    it('does not read the favorites lists without products:read', async () => {
      const { root } = await render({ groupFeatures: features(true) });
      expect(root.querySelector('fc-pos-options-fields')).not.toBeNull();
      backend().expectNone(`${API}/v1/groups/${fakeProfile().groupId}/product-favorites`);
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

    it('puts a 422 on the avatar and on the quick discount of the preferences', async () => {
      const { fixture, root, settled } = await render({ groupFeatures: features(true) });
      await typeInto(fixture, QUICK, '10');
      await submitForm(fixture);
      failRequest(backend(), '/v1/me', 'VALIDATION_ERROR', {
        details: [
          { field: 'avatar', issue: 'tooLong' },
          { field: 'pos.options.quickDiscount', issue: 'maximum' },
        ],
      });
      await settled();
      expect(root.querySelector('fc-avatar-field .error')?.textContent).toContain(
        'FORM.ISSUE.TOO_LONG',
      );
      expect(errorOf(fixture, QUICK)).toBe('FORM.ISSUE.MAXIMUM');
      expect(root.querySelector('fc-form-error')).toBeNull();
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
