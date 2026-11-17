import { Component, Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { fakeGroup } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';
import { GroupFeatures } from '../../core/groups/group-features';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { Group } from './group.types';
import { GROUP_SECTIONS, GroupSettings } from './group-settings';

@Component({ template: '<p>general section</p>' })
class GeneralStub {}
@Component({ template: '<p>features section</p>' })
class FeaturesStub {}

const GROUP = fakeGroup();
const URL = `${API}/v1/groups/${GROUP.id}`;
const BASE = `/groups/${GROUP.id}/settings`;
const ALL = ['groups:read', 'groups:update', 'groups:suspend', 'groups:trash', 'apiKeys:read'];

async function render(profile: Partial<Profile> = {}, extra: Provider[] = [], url = BASE) {
  emulateNativeDialog();
  const refresh = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: GroupFeatures, useValue: { refresh } },
      ...extra,
      provideRouter(
        [
          {
            path: 'groups/:groupId/settings',
            component: GroupSettings,
            children: [
              { path: '', component: GeneralStub },
              { path: 'features', component: FeaturesStub },
              { path: '**', children: [] },
            ],
          },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', groupId: null, permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const load = async (group: Group | null = GROUP, status = 404) => {
    const request = backend().expectOne(URL);
    if (group === null) {
      request.flush(errorBody('NOT_FOUND'), { status, statusText: 'x' });
    } else {
      request.flush({ data: group });
    }
    await view();
  };
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('.actions button')];
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog')!;
  return { harness, root, view, load, buttons, dialog, refresh, router: TestBed.inject(Router) };
}

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupSettings', () => {
  it('shows a loading message until the group arrives', async () => {
    const { root, view, load } = await render();
    await view();
    expect(root.querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    expect(root.querySelector('h1')).toBeNull();
    await load();
  });

  it('shows the name, the sections and the child route', async () => {
    const { root, load } = await render();
    await load();
    expect(root.querySelector('h1')?.textContent).toBe(GROUP.name);
    expect(root.querySelectorAll('fc-status-badge')).toHaveLength(0);
    expect(root.querySelector('.banner')).toBeNull();
    const links = [...root.querySelectorAll<HTMLAnchorElement>('nav.sections a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual(
      GROUP_SECTIONS.map((s) => `GROUP_SETTINGS.SECTION.${s.key}`),
    );
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      GROUP_SECTIONS.map((s) => (s.path === '' ? BASE : `${BASE}/${s.path}`)),
    );
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe('GROUP_SETTINGS.SECTIONS');
    expect(root.textContent).toContain('general section');
  });

  it.each([
    ['PSA', ['groups:read', 'groups:update'], false],
    ['SA', ['groups:read'], false],
    ['D', ['groups:read', 'groups:update', 'apiKeys:read'], true],
  ] as const)(
    'shows the public API tab only with apiKeys:read (%s)',
    async (role, permissions, shown) => {
      const { root, load } = await render({ role, permissions: [...permissions] });
      await load();
      const keys = [...root.querySelectorAll('nav.sections a')].map((a) => a.textContent?.trim());
      expect(keys.includes('GROUP_SETTINGS.SECTION.PUBLIC_API')).toBe(shown);
      expect(keys).toHaveLength(GROUP_SECTIONS.length - (shown ? 0 : 1));
    },
  );

  it('marks the open section as the current page and navigates between sections', async () => {
    const { root, load, view, router } = await render();
    await load();
    const link = (index: number) =>
      root.querySelectorAll<HTMLAnchorElement>('nav.sections a')[index];
    expect(link(0).getAttribute('aria-current')).toBe('page');
    expect(link(1).getAttribute('aria-current')).toBeNull();
    link(1).click();
    await view();
    expect(router.url).toBe(`${BASE}/features`);
    expect(link(1).getAttribute('aria-current')).toBe('page');
    expect(link(0).getAttribute('aria-current')).toBeNull();
    expect(root.textContent).toContain('features section');
    expect(root.textContent).not.toContain('general section');
  });

  it('makes the group the working group of the platform administrator', async () => {
    const { load } = await render();
    await load();
    const context = TestBed.inject(GroupContext);
    expect(context.groupId()).toBe(GROUP.id);
    expect(context.groupName()).toBe(GROUP.name);
  });

  describe('state of the group', () => {
    it('offers suspend and trash for an active group', async () => {
      const { buttons, load } = await render();
      await load();
      expect(buttons().map((b) => b.textContent?.trim())).toEqual([
        'GROUPS.ACTION.SUSPEND',
        'GROUPS.ACTION.TRASH',
      ]);
    });

    it('shows the suspended state, its banner and the way back', async () => {
      const { root, buttons, load } = await render();
      await load(fakeGroup({ status: 'suspended' }));
      expect(root.querySelector('.state')?.textContent).toContain('GROUPS.STATUS.SUSPENDED');
      expect(root.querySelector('.banner')?.getAttribute('role')).toBe('status');
      expect(root.querySelector('.banner')?.textContent).toContain(
        'GROUP_SETTINGS.BANNER.SUSPENDED',
      );
      expect(buttons().map((b) => b.textContent?.trim())).toEqual([
        'GROUPS.ACTION.REACTIVATE',
        'GROUPS.ACTION.TRASH',
      ]);
    });

    it('shows the trashed state, its banner and the way back', async () => {
      const { root, buttons, load } = await render();
      await load(fakeGroup({ trashed: true }));
      expect(root.querySelector('.state')?.textContent).toContain('GROUPS.TRASHED');
      expect(root.querySelector('.banner')?.textContent).toContain('GROUP_SETTINGS.BANNER.TRASHED');
      expect(buttons().map((b) => b.textContent?.trim())).toEqual([
        'GROUPS.ACTION.SUSPEND',
        'GROUPS.ACTION.RESTORE',
      ]);
    });

    it('says the group is trashed when it is also suspended', async () => {
      const { root, load } = await render();
      await load(fakeGroup({ trashed: true, status: 'suspended' }));
      expect(root.querySelector('.banner')?.textContent).toContain('GROUP_SETTINGS.BANNER.TRASHED');
      expect(root.querySelector('.banner')?.textContent).not.toContain(
        'GROUP_SETTINGS.BANNER.SUSPENDED',
      );
    });

    it('offers no state action without the permissions', async () => {
      const { buttons, load } = await render({ role: 'D', permissions: ['groups:read'] });
      await load();
      expect(buttons()).toHaveLength(0);
    });

    it('offers suspend alone and trash alone according to the permission', async () => {
      const suspend = await render({ permissions: ['groups:suspend'] });
      await suspend.load();
      expect(suspend.buttons().map((b) => b.textContent?.trim())).toEqual([
        'GROUPS.ACTION.SUSPEND',
      ]);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const trash = await render({ permissions: ['groups:trash'] });
      await trash.load();
      expect(trash.buttons().map((b) => b.textContent?.trim())).toEqual(['GROUPS.ACTION.TRASH']);
    });

    it.each([
      [0, 'suspend', 'POST', '/suspension', { status: 'suspended' }],
      [1, 'trash', 'POST', '/trash', { trashed: true }],
    ] as const)(
      'button %s asks to %s, calls the API and reloads the record and the features',
      async (index, action, method, path, changed) => {
        const { buttons, dialog, load, view, refresh } = await render();
        await load();
        buttons()[index].click();
        await view();
        expect(dialog().hasAttribute('open')).toBe(true);
        expect(dialog().textContent).toContain(`GROUP_ACTIONS.CONFIRM.${action.toUpperCase()}`);
        dialog().querySelectorAll<HTMLButtonElement>('footer button')[1].click();
        await settle();
        const call = backend().expectOne(`${URL}${path}`);
        expect(call.request.method).toBe(method);
        call.flush(null, { status: 204, statusText: 'No Content' });
        await view();
        await load(fakeGroup(changed));
        expect(refresh).toHaveBeenCalledTimes(1);
      },
    );

    it('asks to restore a trashed group and to reactivate a suspended one', async () => {
      const { buttons, dialog, load, view } = await render();
      await load(fakeGroup({ trashed: true, status: 'suspended' }));
      buttons()[0].click();
      await view();
      expect(dialog().textContent).toContain('GROUP_ACTIONS.CONFIRM.REACTIVATE');
      dialog().querySelectorAll<HTMLButtonElement>('footer button')[0].click();
      await view();
      buttons()[1].click();
      await view();
      expect(dialog().textContent).toContain('GROUP_ACTIONS.CONFIRM.RESTORE');
      dialog().querySelectorAll<HTMLButtonElement>('footer button')[0].click();
      await view();
    });
  });

  describe('when the group cannot be loaded', () => {
    it('shows the error with the request id and retries', async () => {
      const { root, load, view, refresh } = await render();
      backend()
        .expectOne(URL)
        .flush(errorBody('NOT_FOUND'), {
          status: 404,
          statusText: 'x',
          headers: { 'X-Request-Id': 'req-9' },
        });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('GROUP_SETTINGS.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
      expect(state.textContent).toContain('req-9');
      expect(root.querySelector('h1')).toBeNull();
      expect(root.querySelector('nav.sections')).toBeNull();
      state.querySelector('button')!.click();
      await view();
      await load();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelector('h1')?.textContent).toBe(GROUP.name);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not make the group of a failed page the working group', async () => {
      const { load } = await render();
      await load(null);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render({}, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });
});
