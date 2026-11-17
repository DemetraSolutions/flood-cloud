import { TestBed } from '@angular/core/testing';
import { backend, errorBody, provideApiTesting } from '../../../../testing/api';
import { fakeSettingsState, renderGroupSection } from '../../../../testing/group-settings';
import { fakeGroup } from '../../../../testing/groups';
import { I18nService } from '../../../core/i18n/i18n.service';
import { Profile } from '../../../core/session/session.types';
import { GroupSettingsState } from '../group-settings-state';
import { PublicApiSettings } from './api-key.types';
import { PublicApiSettingsBlock } from './public-api-settings';

const SETTINGS: PublicApiSettings = {
  enabled: true,
  defaultRateLimitPerMinute: 30,
  defaultDailyQuota: 500,
  groupRateLimitPerMinute: 90,
  groupDailyQuota: 5000,
};
const GROUP = fakeGroup({ publicApi: SETTINGS });
const ENABLED = 'PUBLIC_API.SETTINGS.ENABLED';
const DEFAULT_MIN = 'PUBLIC_API.SETTINGS.DEFAULT_PER_MINUTE';
const DEFAULT_DAY = 'PUBLIC_API.SETTINGS.DEFAULT_PER_DAY';
const CAP_MIN = 'PUBLIC_API.SETTINGS.CAP_PER_MINUTE';
const CAP_DAY = 'PUBLIC_API.SETTINGS.CAP_PER_DAY';
const PERMISSIONS = ['groups:read', 'groups:update', 'apiKeys:read', 'apiKeys:manage'];

async function render(profile: Partial<Profile> = {}, group = GROUP) {
  const view = await renderGroupSection(PublicApiSettingsBlock, {
    profile: { permissions: PERMISSIONS, ...profile },
    group,
  });
  await view.load();
  const patch = () => backend().expectOne(view.url);
  return { ...view, patch };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PublicApiSettingsBlock', () => {
  it('shows the settings of the group', async () => {
    const { root, box, control, save } = await render();
    expect(box(ENABLED).checked).toBe(true);
    expect(control(DEFAULT_MIN).value).toBe('30');
    expect(control(DEFAULT_DAY).value).toBe('500');
    expect(control(CAP_MIN).value).toBe('90');
    expect(control(CAP_DAY).value).toBe('5000');
    expect(root.querySelector('.banner')).toBeNull();
    expect(root.textContent).not.toContain('PUBLIC_API.SETTINGS.READ_ONLY');
    expect(save()?.disabled).toBe(true);
  });

  it('shows the platform defaults, and a notice that no key works, for a group that never set them', async () => {
    const { root, box, control } = await render({}, fakeGroup());
    expect(box(ENABLED).checked).toBe(false);
    expect(root.querySelector('.banner[role=status]')?.textContent).toContain(
      'PUBLIC_API.SETTINGS.OFF_NOTICE',
    );
    expect(
      [DEFAULT_MIN, DEFAULT_DAY, CAP_MIN, CAP_DAY].map((label) => control(label).value),
    ).toEqual(['60', '10000', '120', '20000']);
  });

  it('lets the platform administrator change everything and sends only what changed', async () => {
    const { toggle, type, save, submit, patch, view, toasts, refresh, box, control, root } =
      await render({ role: 'PSA' });
    await toggle(ENABLED, false);
    await type(DEFAULT_MIN, '45');
    await type(CAP_DAY, '6000');
    expect(save()?.disabled).toBe(false);
    await submit();
    const request = patch();
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({
      publicApi: { enabled: false, defaultRateLimitPerMinute: 45, groupDailyQuota: 6000 },
    });
    request.flush({
      data: fakeGroup({
        publicApi: {
          ...SETTINGS,
          enabled: false,
          defaultRateLimitPerMinute: 45,
          groupDailyQuota: 6000,
        },
      }),
    });
    await view();
    expect(toasts()).toEqual(['GROUP_SETTINGS.SAVED']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(box(ENABLED).checked).toBe(false);
    expect(control(DEFAULT_MIN).value).toBe('45');
    expect(save()?.disabled).toBe(true);
    expect(root.querySelector('.banner')).not.toBeNull();
  });

  it('sends the other two limits too when they change', async () => {
    const { type, submit, patch } = await render();
    await type(DEFAULT_DAY, '600');
    await type(CAP_MIN, '100');
    await submit();
    const request = patch();
    expect(request.request.body).toEqual({
      publicApi: { defaultDailyQuota: 600, groupRateLimitPerMinute: 100 },
    });
    request.flush({ data: GROUP });
  });

  it('is read-only for a dealer', async () => {
    const { root, box, control, save } = await render({ role: 'D', groupId: null });
    expect(root.querySelector('p.note')?.textContent).toContain('PUBLIC_API.SETTINGS.READ_ONLY');
    expect(box(ENABLED).disabled).toBe(true);
    expect(control(DEFAULT_MIN).disabled).toBe(true);
    expect(control(CAP_DAY).disabled).toBe(true);
    expect(save()).toBeNull();
  });

  it('is read-only for a platform administrator without groups:update', async () => {
    const { control, save } = await render({ permissions: ['groups:read', 'apiKeys:read'] });
    expect(control(DEFAULT_MIN).disabled).toBe(true);
    expect(save()).toBeNull();
  });

  describe('validation', () => {
    it.each([
      [DEFAULT_MIN, '0', 'FORM.ISSUE.MINIMUM'],
      [DEFAULT_MIN, '6001', 'FORM.ISSUE.MAXIMUM'],
      [DEFAULT_DAY, '10000001', 'FORM.ISSUE.MAXIMUM'],
      [CAP_MIN, '1.5', 'FORM.ISSUE.TYPE'],
      [CAP_DAY, '', 'FORM.ISSUE.REQUIRED'],
    ])('refuses %s = "%s" without a request', async (label, value, message) => {
      const { type, submit, error, control } = await render();
      await type(label, value);
      await submit();
      expect(error(label)).toBe(message);
      expect(control(label).getAttribute('aria-invalid')).toBe('true');
    });

    it('accepts the highest values', async () => {
      const { type, submit, patch } = await render();
      await type(DEFAULT_MIN, '6000');
      await type(DEFAULT_DAY, '10000000');
      await submit();
      patch().flush({ data: GROUP });
    });
  });

  it('marks a field as touched when it loses the focus', async () => {
    const { control, view, error, type } = await render();
    await type(DEFAULT_MIN, '0');
    expect(error(DEFAULT_MIN)).toBe('');
    control(DEFAULT_MIN).dispatchEvent(new Event('blur'));
    await view();
    expect(error(DEFAULT_MIN)).toBe('FORM.ISSUE.MINIMUM');
    control(CAP_MIN).dispatchEvent(new Event('blur'));
    control(CAP_DAY).dispatchEvent(new Event('blur'));
    control(DEFAULT_DAY).dispatchEvent(new Event('blur'));
    await view();
  });

  it('marks the switch as touched when it loses the focus', async () => {
    const { control, view, save } = await render();
    control(ENABLED).dispatchEvent(new Event('blur'));
    await view();
    expect(save()?.disabled).toBe(true);
  });

  describe('errors of the backend', () => {
    async function rejected(
      status: number,
      code: string,
      details?: { field: string; issue: string }[],
    ) {
      const view = await render();
      await view.toggle(ENABLED, false);
      await view.submit();
      view.patch().flush(errorBody(code, details), { status, statusText: 'x' });
      await view.view();
      return view;
    }

    it('puts a 422 detail under the field', async () => {
      const { error, formError } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'publicApi.groupDailyQuota', issue: 'maximum' },
      ]);
      expect(error(CAP_DAY)).toBe('FORM.ISSUE.MAXIMUM');
      expect(formError()).toBeNull();
    });

    it('puts a 403 notAllowed under the switch', async () => {
      const { error } = await rejected(403, 'FORBIDDEN', [
        { field: 'publicApi.enabled', issue: 'notAllowed' },
      ]);
      expect(error(ENABLED)).toBe('FORM.ISSUE.NOT_ALLOWED');
    });

    it('shows a form message for a detail that matches no field', async () => {
      const { formError } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'publicApi.other', issue: 'unknown' },
      ]);
      expect(formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    });

    it('shows a 403 and a 404 as form messages', async () => {
      const forbidden = await rejected(403, 'FORBIDDEN');
      expect(forbidden.formError()).toContain('ERRORS.API.FORBIDDEN');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const missing = await rejected(404, 'NOT_FOUND');
      expect(missing.formError()).toContain('ERRORS.API.NOT_FOUND');
    });

    it.each([
      [409, 'CONFLICT'],
      [412, 'PRECONDITION_FAILED'],
    ])('invites to reload on a %s and reloads the group', async (status, code) => {
      const { formError, root, view, url, box } = await rejected(status, code);
      expect(formError()).toContain('GROUP_SETTINGS.ERROR.CONFLICT');
      [...root.querySelectorAll<HTMLButtonElement>('.actions button')]
        .find((b) => b.textContent?.trim() === 'GROUP_SETTINGS.RELOAD')!
        .click();
      await view();
      expect(formError()).toBeNull();
      backend()
        .expectOne(url)
        .flush({ data: fakeGroup({ publicApi: { ...SETTINGS, enabled: false } }) });
      await view();
      expect(box(ENABLED).checked).toBe(false);
    });

    it('does not offer to reload on other failures', async () => {
      const { root } = await rejected(429, 'RATE_LIMITED');
      expect(root.querySelector('.actions button[type=button]')).toBeNull();
    });

    it('reports a network failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await render();
      await view.toggle(ENABLED, false);
      await view.submit();
      view.patch().error(new ProgressEvent('error'));
      await view.view();
      expect(view.formError()).toContain('ERRORS.');
    });
  });

  describe('without a loaded group', () => {
    it('renders nothing', async () => {
      TestBed.configureTestingModule({
        providers: [
          ...provideApiTesting(),
          { provide: GroupSettingsState, useValue: fakeSettingsState() },
        ],
      });
      vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
      const fixture = TestBed.createComponent(PublicApiSettingsBlock);
      await fixture.whenStable();
      expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
    });
  });
});
