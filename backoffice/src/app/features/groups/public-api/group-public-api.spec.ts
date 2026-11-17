import { TestBed } from '@angular/core/testing';
import { API, backend } from '../../../../testing/api';
import { fakeApiKey } from '../../../../testing/api-keys';
import { renderGroupSection } from '../../../../testing/group-settings';
import { fakeGroup } from '../../../../testing/groups';
import { emulateNativeDialog } from '../../../../testing/dialog';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { Profile } from '../../../core/session/session.types';
import { Group } from '../group.types';
import { GroupPublicApi } from './group-public-api';

const GROUP = fakeGroup({
  publicApi: {
    enabled: true,
    defaultRateLimitPerMinute: 30,
    defaultDailyQuota: 500,
    groupRateLimitPerMinute: 90,
    groupDailyQuota: 5000,
  },
});
const KEYS = `${API}/v1/groups/${GROUP.id}/api-keys`;

async function render(profile: Partial<Profile> = {}, group: Group = GROUP) {
  emulateNativeDialog();
  vi.spyOn(ReferenceApi.prototype, 'companies').mockResolvedValue({
    data: [],
    page: { limit: 25, next: null },
  });
  vi.spyOn(ReferenceApi.prototype, 'places').mockResolvedValue({
    data: [],
    page: { limit: 25, next: null },
  });
  const view = await renderGroupSection(GroupPublicApi, {
    profile: {
      permissions: ['groups:read', 'groups:update', 'apiKeys:read', 'apiKeys:manage'],
      ...profile,
    },
    group,
  });
  await view.load();
  backend()
    .expectOne((r) => r.url === KEYS)
    .flush({ data: [fakeApiKey()], page: { limit: 25, next: null } });
  await view.view();
  return view;
}

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupPublicApi', () => {
  it('shows the settings of the group and its keys', async () => {
    const { root, control } = await render();
    expect(root.querySelector('fc-public-api-settings')).not.toBeNull();
    expect(root.querySelector('fc-api-keys-list')).not.toBeNull();
    expect(control('PUBLIC_API.SETTINGS.CAP_PER_MINUTE').value).toBe('90');
    expect(root.querySelector('tbody')?.textContent).toContain('Webshop');
  });

  it('gives the editor of a new key the limits of the group, not the platform ones', async () => {
    const { root, view } = await render();
    [...root.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'PUBLIC_API.LIST.NEW')!
      .click();
    await view();
    const label = [...root.querySelectorAll('dialog label')].find(
      (l) => l.textContent?.trim() === 'PUBLIC_API.KEY.PER_MINUTE',
    ) as HTMLLabelElement;
    expect(root.querySelector<HTMLInputElement>(`dialog #${label.htmlFor}`)?.value).toBe('30');
  });

  it('falls back to the platform defaults for a group that never set them', async () => {
    const { root, view } = await render({}, fakeGroup());
    [...root.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'PUBLIC_API.LIST.NEW')!
      .click();
    await view();
    const label = [...root.querySelectorAll('dialog label')].find(
      (l) => l.textContent?.trim() === 'PUBLIC_API.KEY.PER_DAY',
    ) as HTMLLabelElement;
    expect(root.querySelector<HTMLInputElement>(`dialog #${label.htmlFor}`)?.value).toBe('10000');
  });

  it('lets a dealer read the settings and manage the keys', async () => {
    const { root, control } = await render({ role: 'D', groupId: null });
    expect(control('PUBLIC_API.SETTINGS.ENABLED').disabled).toBe(true);
    expect(root.textContent).toContain('PUBLIC_API.LIST.NEW');
    TestBed.inject(ReferenceApi);
  });
});
