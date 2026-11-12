import { Component, inject, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { fakePos, fakeUser } from '../../../testing/users';
import { FEATURE_NAMES, FeatureFlags } from '../../core/groups/feature-catalog';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { UserFormState } from './user-form-state';
import { UserPosSection } from './user-pos-section';
import { UsersApi } from './users-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const USER = fakeUser({ id: '665f1c2e9b1d4a0012ab3401' });
const USER_URL = `${API}/v1/groups/${GROUP}/users/${USER.id}`;
const LISTS_URL = `${API}/v1/groups/${GROUP}/lookup/price-lists`;
const FAVORITES_URL = `${API}/v1/groups/${GROUP}/product-favorites`;
const CASH = Object.fromEntries(FEATURE_NAMES.map((n) => [n, n === 'cash'])) as FeatureFlags;
const BASE = ['users:read', 'users:create', 'users:update'];

@Component({
  imports: [UserPosSection],
  providers: [UserFormState],
  template: `<fc-user-pos-section />`,
})
class Host {
  readonly state = inject(UserFormState);
  readonly groupId = signal<string | undefined>(GROUP);
  readonly userId = signal<string | undefined>(undefined);

  constructor() {
    this.state.attach(this.groupId, this.userId);
  }
}

async function render(options: { edit?: boolean; profile?: Partial<Profile> } = {}) {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(UsersApi.prototype, 'isUsernameAvailable').mockResolvedValue(true);
  signIn({ role: 'SA', permissions: BASE, groupFeatures: CASH, ...options.profile });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  if (options.edit) {
    fixture.componentInstance.userId.set(USER.id);
  }
  fixture.detectChanges();
  await settle();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const loadUser = async (user = USER) => {
    backend().expectOne(USER_URL).flush({ data: user });
    await view();
  };
  const loadUserWithoutLists = async (user = USER) => {
    await loadUser(user);
    backend().expectOne(LISTS_URL).flush({ data: [] });
    await view();
  };
  const text = () => root.textContent ?? '';
  const check = async (label: string, checked: boolean) => {
    const box = findControl(fixture as ComponentFixture<unknown>, label) as HTMLInputElement;
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  return {
    fixture,
    state: fixture.componentInstance.state,
    root,
    view,
    loadUser,
    loadUserWithoutLists,
    text,
    check,
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserPosSection: creation', () => {
  it('only explains that the role defaults apply, with no control and no price lists read', async () => {
    const { root, text, state } = await render({
      profile: { permissions: [...BASE, 'products:read'], canManagePermissions: true },
    });
    expect(text()).toContain('USERS.FORM.DEFAULTS_NOTE');
    expect(text()).not.toContain('USERS.FORM.RELOGIN_WARNING');
    expect(text()).not.toContain('USERS.POS.PERMISSIONS_READONLY');
    expect(root.querySelector('input')).toBeNull();
    expect(root.querySelector('fc-checkbox')).toBeNull();
    expect(root.querySelector('#pos-grants')).toBeNull();
    expect(root.querySelector('fc-pos-grants-fields')).toBeNull();
    expect(root.querySelector('fc-pos-options-fields')).toBeNull();
    expect(root.querySelector('fc-pos-price-lists')).toBeNull();
    expect(state.posGrantsEditable()).toBe(false);
    expect(state.posOptionsEditable()).toBe(false);
    backend().expectNone(LISTS_URL);
    backend().expectNone(FAVORITES_URL);
  });
});

describe('UserPosSection: editing', () => {
  it('warns that sessions are not interrupted and shows the details of the stored user', async () => {
    const { loadUserWithoutLists, text, root } = await render({ edit: true });
    await loadUserWithoutLists();
    expect(text()).toContain('USERS.FORM.RELOGIN_WARNING');
    expect(text()).not.toContain('USERS.FORM.DEFAULTS_NOTE');
    expect(root.querySelector('fc-checkbox input')).not.toBeNull();
    expect(root.querySelector('fc-pos-grants-fields')).not.toBeNull();
    expect(root.querySelector('fc-pos-options-fields')).not.toBeNull();
    expect(text()).not.toContain('USERS.POS.DEFINE');
  });

  it('tells whoever cannot manage permissions that they are read-only', async () => {
    const { loadUserWithoutLists, text } = await render({ edit: true });
    await loadUserWithoutLists();
    expect(text()).toContain('USERS.POS.PERMISSIONS_READONLY');
  });

  it('does not say so to a permissions manager', async () => {
    const { loadUserWithoutLists, text } = await render({
      edit: true,
      profile: { canManagePermissions: true },
    });
    await loadUserWithoutLists();
    expect(text()).not.toContain('USERS.POS.PERMISSIONS_READONLY');
  });

  it('explains that the POS cannot be switched on by an actor who does not hold it', async () => {
    const { loadUserWithoutLists, text, root } = await render({
      edit: true,
      profile: {
        role: 'CA',
        canManagePermissions: true,
        pos: fakePos({ enabled: false }),
        permissions: [...BASE, 'companies:read'],
      },
    });
    await loadUserWithoutLists(fakeUser({ ...USER, pos: fakePos({ enabled: false }) }));
    expect(text()).toContain('USERS.POS.NOT_GRANTABLE');
    expect(
      (findControl({ nativeElement: root } as never, 'USERS.POS.ENABLED') as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it('does not show that hint to an actor who may give the POS', async () => {
    const { loadUserWithoutLists, root } = await render({
      edit: true,
      profile: { canManagePermissions: true },
    });
    await loadUserWithoutLists();
    const enabled = root.querySelector('fc-checkbox')!;
    expect(enabled.textContent).not.toContain('USERS.POS.NOT_GRANTABLE');
  });

  it('keeps the checkbox of an actor who holds the POS enabled', async () => {
    const { loadUserWithoutLists, root } = await render({
      edit: true,
      profile: { role: 'CA', canManagePermissions: true, pos: fakePos({ enabled: true }) },
    });
    await loadUserWithoutLists();
    expect(root.querySelector('fc-checkbox')?.textContent).not.toContain('USERS.POS.NOT_GRANTABLE');
    expect(
      (findControl({ nativeElement: root } as never, 'USERS.POS.ENABLED') as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });
});

describe('UserPosSection: price lists', () => {
  const LISTS = [
    { id: 'l1', name: 'Listino 1', enabled: true, isDefault: false },
    { id: 'l2', name: 'Listino 2', enabled: true, isDefault: false },
  ];

  it('reads them from the lookup with users:read only, for a CA or PA too', async () => {
    const { loadUser, root, view } = await render({
      edit: true,
      profile: { role: 'CA', permissions: ['users:read', 'users:update'] },
    });
    await loadUser();
    backend().expectOne(LISTS_URL).flush({ data: LISTS });
    await view();
    expect(root.querySelector('fc-pos-price-lists')).not.toBeNull();
  });

  it('shows a loading state while reading them', async () => {
    const { loadUser, root } = await render({
      edit: true,
      profile: { permissions: [...BASE] },
    });
    await loadUser();
    expect(root.querySelector('#pos-lists ~ [role=status], [role=status]')?.textContent).toContain(
      'COMMON.LOADING',
    );
    backend().expectOne(LISTS_URL).flush({ data: [] });
  });

  it('offers a retry when reading them fails', async () => {
    const { loadUser, root, view, text } = await render({
      edit: true,
      profile: { permissions: [...BASE] },
    });
    await loadUser();
    backend()
      .expectOne(LISTS_URL)
      .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('[role=alert]')?.textContent).toContain(
      'USERS.POS.PRICE_LISTS_ERROR',
    );
    root.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    await view();
    backend().expectOne(LISTS_URL).flush({ data: [] });
    await view();
    expect(text()).toContain('USERS.POS.PRICE_LISTS_EMPTY');
    expect(root.querySelector('[role=alert]')).toBeNull();
  });

  it('says there are none when the group has no price list', async () => {
    const { loadUser, root, view, text } = await render({
      edit: true,
      profile: { permissions: [...BASE] },
    });
    await loadUser();
    backend().expectOne(LISTS_URL).flush({ data: [] });
    await view();
    expect(text()).toContain('USERS.POS.PRICE_LISTS_EMPTY');
    expect(root.querySelector('fc-pos-price-lists')).toBeNull();
  });

  it('shows the price lists and the choice of the starting one', async () => {
    const { loadUser, root, view, text } = await render({
      edit: true,
      profile: { permissions: [...BASE] },
    });
    await loadUser();
    backend().expectOne(LISTS_URL).flush({ data: LISTS });
    await view();
    expect(text()).not.toContain('USERS.POS.PRICE_LISTS_EMPTY');
    const rows = root.querySelectorAll('fc-pos-price-lists li');
    expect(rows[0].textContent).toContain('Listino 1');
    expect(root.querySelector('fc-pos-price-lists legend')?.textContent).toBe(
      'USERS.POS.PRICE_LISTS_USABLE',
    );
    const start = findControl({ nativeElement: root } as never, 'USERS.POS.START_PRICE_LIST');
    expect(
      [...(start as HTMLSelectElement).options].map((o) => [o.value, o.textContent?.trim()]),
    ).toEqual([
      ['', 'USERS.POS.CHOICE_NONE'],
      ['l1', 'Listino 1'],
      ['l2', 'Listino 2'],
    ]);
  });

  it('edits the stored price lists of the user and the starting one', async () => {
    const { loadUser, root, view, state } = await render({
      edit: true,
      profile: { permissions: [...BASE] },
    });
    const pos = fakePos();
    await loadUser(
      fakeUser({
        ...USER,
        pos: {
          ...pos,
          options: {
            ...pos.options,
            priceLists: [{ priceListId: 'l1', enabled: true, isDefault: true }],
            defaultPriceListId: 'l1',
          },
        },
      }),
    );
    backend().expectOne(LISTS_URL).flush({ data: LISTS });
    await view();
    const radios = root.querySelectorAll<HTMLInputElement>('fc-pos-price-lists input[type=radio]');
    expect(radios[0].checked).toBe(true);
    const second = root.querySelectorAll<HTMLInputElement>(
      'fc-pos-price-lists input[type=checkbox]',
    )[1];
    second.checked = true;
    second.dispatchEvent(new Event('change'));
    await view();
    expect(state.model().pos.options.priceLists.map((l) => l.priceListId)).toEqual(['l1', 'l2']);
    const start = findControl(
      { nativeElement: root } as never,
      'USERS.POS.START_PRICE_LIST',
    ) as HTMLSelectElement;
    expect(start.value).toBe('l1');
    start.value = 'l2';
    start.dispatchEvent(new Event('change'));
    await view();
    expect(state.model().pos.options.defaultPriceListId).toBe('l2');
  });
});

describe('UserPosSection: favorites', () => {
  it('passes the favorites lists of the group to the preferences', async () => {
    const { loadUserWithoutLists, view, root } = await render({
      edit: true,
      profile: { permissions: [...BASE, 'products:read'] },
    });
    await loadUserWithoutLists();
    backend()
      .expectOne(FAVORITES_URL)
      .flush({ data: [{ id: 'f1', name: 'Preferiti bar' }] });
    await view();
    expect(root.querySelector('fc-pos-options-fields')?.textContent).toContain('Preferiti bar');
  });

  it('shows no favorites choice without the products:read permission', async () => {
    const { loadUserWithoutLists, root } = await render({ edit: true });
    await loadUserWithoutLists();
    expect(root.querySelector('fc-pos-options-fields')?.textContent).not.toContain('Preferiti bar');
    backend().expectNone(FAVORITES_URL);
  });
});
