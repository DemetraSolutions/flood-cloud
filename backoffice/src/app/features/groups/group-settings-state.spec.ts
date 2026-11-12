import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeGroup } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { GroupContext } from '../../core/groups/group-context';
import { GroupFeatures } from '../../core/groups/group-features';
import { Profile } from '../../core/session/session.types';
import { GroupSettingsState } from './group-settings-state';

@Component({ template: '', providers: [GroupSettingsState] })
class Host {
  readonly state = inject(GroupSettingsState);
  readonly id = signal('665f1c2e9b1d4a0012ab34a1');
}

const GROUP = fakeGroup();
const URL = `${API}/v1/groups/${GROUP.id}`;

function setup(profile: Partial<Profile> = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [...provideApiTesting(), { provide: GroupFeatures, useValue: { refresh } }],
  });
  signIn({ role: 'PSA', groupId: null, permissions: ['groups:read', 'groups:update'], ...profile });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  const attach = async () => {
    host.state.attach(host.id);
    fixture.detectChanges();
    await settle();
  };
  return {
    fixture,
    host,
    state: host.state,
    refresh,
    attach,
    context: TestBed.inject(GroupContext),
  };
}

afterEach(() => backend().verify());

describe('GroupSettingsState', () => {
  it('does not read anything before the layout attached the group id', async () => {
    const { fixture, state } = setup();
    fixture.detectChanges();
    await settle();
    expect(state.groupId()).toBeNull();
    expect(state.group()).toBeNull();
  });

  it('loads the group once attached and follows the id', async () => {
    const { host, state, attach, fixture } = setup();
    await attach();
    expect(state.groupId()).toBe(GROUP.id);
    expect(state.loading()).toBe(true);
    backend().expectOne(URL).flush({ data: GROUP });
    await settle();
    expect(state.loading()).toBe(false);
    expect(state.group()).toEqual(GROUP);
    host.id.set('665f1c2e9b1d4a0012ab34a2');
    fixture.detectChanges();
    await settle();
    backend()
      .expectOne(`${API}/v1/groups/665f1c2e9b1d4a0012ab34a2`)
      .flush({ data: fakeGroup({ name: 'Altro' }) });
    await settle();
    expect(state.group()?.name).toBe('Altro');
  });

  it.each([
    ['NOT_FOUND', 404],
    ['FORBIDDEN', 403],
  ] as const)('exposes a %s as the load error and no group', async (code, status) => {
    const { state, attach } = setup();
    await attach();
    backend().expectOne(URL).flush(errorBody(code), { status, statusText: 'x' });
    await settle();
    expect(state.group()).toBeNull();
    expect(state.loadError()?.code).toBe(code);
  });

  it('reloads the group and the features of the context', async () => {
    const { state, attach, refresh } = setup();
    await attach();
    backend().expectOne(URL).flush({ data: GROUP });
    await settle();
    state.reload();
    await settle();
    backend()
      .expectOne(URL)
      .flush({ data: fakeGroup({ status: 'suspended' }) });
    await settle();
    expect(state.group()?.status).toBe('suspended');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('takes the updated group, adopts it as working group and refreshes the features', async () => {
    const { state, attach, refresh, context } = setup();
    await attach();
    backend().expectOne(URL).flush({ data: GROUP });
    await settle();
    state.apply(fakeGroup({ name: 'Nuovo nome' }));
    expect(state.group()?.name).toBe('Nuovo nome');
    expect(context.groupId()).toBe(GROUP.id);
    expect(context.groupName()).toBe('Nuovo nome');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('adopts the loaded group as working group', async () => {
    const { state, attach, context } = setup();
    await attach();
    backend().expectOne(URL).flush({ data: GROUP });
    await settle();
    state.adopt(GROUP);
    expect(context.groupId()).toBe(GROUP.id);
    expect(context.groupName()).toBe(GROUP.name);
  });

  describe('what the user may change', () => {
    it.each([
      ['PSA', true, true, true],
      ['D', true, true, false],
      ['SA', true, false, false],
    ] as const)('%s with groups:update', (role, canUpdate, canManage, canDemo) => {
      const { state } = setup({ role, groupId: role === 'SA' ? GROUP.id : null });
      expect([state.canUpdate(), state.canManage(), state.canDemo()]).toEqual([
        canUpdate,
        canManage,
        canDemo,
      ]);
    });

    it.each(['PSA', 'D', 'SA', 'CA'] as const)(
      '%s without groups:update changes nothing',
      (role) => {
        const { state } = setup({ role, permissions: ['groups:read'] });
        expect([state.canUpdate(), state.canManage(), state.canDemo()]).toEqual([
          false,
          false,
          false,
        ]);
      },
    );

    it('does not let a role without the platform rank manage with the permission', () => {
      const { state } = setup({ role: 'CA', permissions: ['groups:update'] });
      expect([state.canUpdate(), state.canManage(), state.canDemo()]).toEqual([true, false, false]);
    });
  });
});
