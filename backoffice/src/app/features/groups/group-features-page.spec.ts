import { TestBed } from '@angular/core/testing';
import { backend, errorBody, provideApiTesting } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { GroupSettingsState } from './group-settings-state';
import { fakeSettingsState, renderGroupSection } from '../../../testing/group-settings';
import { fakeFeatureFlags, fakeGroup } from '../../../testing/groups';
import { FEATURE_NAMES, featureTextKey } from '../../core/groups/feature-catalog';
import { Profile } from '../../core/session/session.types';
import { GroupFeaturesPage } from './group-features-page';

const GROUP = fakeGroup({ features: fakeFeatureFlags(false, { cash: true, rooms: true }) });
const CASH = featureTextKey('cash', 'LABEL');
const MONOPOLY = featureTextKey('tobaccosGamesMonopoly', 'LABEL');

async function render(profile: Partial<Profile> = {}) {
  const view = await renderGroupSection(GroupFeaturesPage, { profile, group: GROUP });
  await view.load();
  const patch = () => backend().expectOne(view.url);
  return { ...view, patch };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupFeaturesPage', () => {
  it('shows a switch with label and description for each feature of the catalog', async () => {
    const { root, box, save } = await render();
    expect(root.querySelectorAll('fc-checkbox')).toHaveLength(FEATURE_NAMES.length);
    expect(featureTextKey('tobaccosGamesMonopoly', 'DESCRIPTION')).toBe(
      'FEATURE.TOBACCOS_GAMES_MONOPOLY.DESCRIPTION',
    );
    expect(root.textContent).toContain('FEATURE.TOBACCOS_GAMES_MONOPOLY.DESCRIPTION');
    expect(box(CASH).checked).toBe(true);
    expect(box(MONOPOLY).checked).toBe(false);
    expect(save()?.disabled).toBe(true);
    expect(root.textContent).not.toContain('GROUP_SETTINGS.FEATURES.READ_ONLY');
  });

  it.each(['PSA', 'D'] as const)(
    'lets %s switch features and sends only what changed',
    async (role) => {
      const { toggle, save, submit, patch, view, toasts, refresh, box } = await render({ role });
      await toggle(MONOPOLY, true);
      await toggle(CASH, false);
      await toggle(featureTextKey('rooms', 'LABEL'), false);
      await toggle(featureTextKey('rooms', 'LABEL'), true);
      expect(save()?.disabled).toBe(false);
      await submit();
      const request = patch();
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({
        features: { cash: false, tobaccosGamesMonopoly: true },
      });
      request.flush({
        data: fakeGroup({
          features: fakeFeatureFlags(false, { rooms: true, tobaccosGamesMonopoly: true }),
        }),
      });
      await view();
      expect(toasts()).toEqual(['GROUP_SETTINGS.SAVED']);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(box(CASH).checked).toBe(false);
      expect(save()?.disabled).toBe(true);
    },
  );

  it('marks a switch as touched when it loses the focus', async () => {
    const { control, view, save } = await render();
    control(CASH).dispatchEvent(new Event('blur'));
    await view();
    expect(save()?.disabled).toBe(true);
  });

  it('is read-only for the group administrator', async () => {
    const { root, box, save } = await render({ role: 'SA', groupId: GROUP.id });
    expect(root.querySelector('p.note')?.textContent).toContain(
      'GROUP_SETTINGS.FEATURES.READ_ONLY',
    );
    expect(box(CASH).disabled).toBe(true);
    expect(save()).toBeNull();
  });

  it('is read-only for a platform administrator without groups:update', async () => {
    const { box, save } = await render({ permissions: ['groups:read'] });
    expect(box(CASH).disabled).toBe(true);
    expect(save()).toBeNull();
  });

  describe('errors of the backend', () => {
    async function rejected(
      status: number,
      code: string,
      details?: { field: string; issue: string }[],
    ) {
      const view = await render();
      await view.toggle(MONOPOLY, true);
      await view.submit();
      view.patch().flush(errorBody(code, details), { status, statusText: 'x' });
      await view.view();
      return view;
    }

    it('puts a 422 detail under the feature', async () => {
      const { error, formError, toasts } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'features.tobaccosGamesMonopoly', issue: 'type' },
        { field: 'features.tobaccosGamesMonopoly', issue: 'unknown' },
      ]);
      expect(error(MONOPOLY)).toBe('FORM.ISSUE.TYPE');
      expect(formError()).toBeNull();
      expect(toasts()).toEqual([]);
    });

    it('puts a 403 notAllowed under the feature', async () => {
      const { error } = await rejected(403, 'FORBIDDEN', [
        { field: 'features.tobaccosGamesMonopoly', issue: 'notAllowed' },
      ]);
      expect(error(MONOPOLY)).toBe('FORM.ISSUE.NOT_ALLOWED');
    });

    it('shows a form message for a detail that matches no feature and for a 422 without details', async () => {
      const unmatched = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'features.nothing', issue: 'unknown' },
      ]);
      expect(unmatched.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const bare = await rejected(422, 'VALIDATION_ERROR');
      expect(bare.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    });

    it('shows a 403 and a 404 as form messages', async () => {
      const forbidden = await rejected(403, 'FORBIDDEN');
      expect(forbidden.formError()).toContain('ERRORS.API.FORBIDDEN');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const missing = await rejected(404, 'NOT_FOUND');
      expect(missing.formError()).toContain('ERRORS.API.NOT_FOUND');
    });

    it('invites to reload on a 409 and reloads the group', async () => {
      const { formError, root, view, url, box } = await rejected(409, 'CONFLICT');
      expect(formError()).toContain('GROUP_SETTINGS.ERROR.CONFLICT');
      [...root.querySelectorAll<HTMLButtonElement>('.actions button')]
        .find((b) => b.textContent?.trim() === 'GROUP_SETTINGS.RELOAD')!
        .click();
      await view();
      expect(formError()).toBeNull();
      backend()
        .expectOne(url)
        .flush({ data: fakeGroup({ features: fakeFeatureFlags(true) }) });
      await view();
      expect(box(MONOPOLY).checked).toBe(true);
    });

    it('reports a network failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await render();
      await view.toggle(MONOPOLY, true);
      await view.submit();
      view.patch().error(new ProgressEvent('error'));
      await view.view();
      expect(view.formError()).toContain('ERRORS.');
    });
  });

  describe('without a loaded group', () => {
    it('renders nothing and has no features to send', async () => {
      const state = fakeSettingsState();
      TestBed.configureTestingModule({
        providers: [...provideApiTesting(), { provide: GroupSettingsState, useValue: state }],
      });
      vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
      const fixture = TestBed.createComponent(GroupFeaturesPage);
      await fixture.whenStable();
      expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
      const instance = fixture.componentInstance as unknown as { patch(): unknown };
      expect(() => instance.patch()).not.toThrow();
    });
  });
});
