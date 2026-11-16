import { API, backend } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import {
  adminProfile,
  GROUP,
  renderWithState,
  StateOptions,
  storedUser,
  USER_ADMIN_PERMISSIONS,
} from '../../../testing/user-form-state';
import { ReferenceApi } from '../../core/reference/reference-api';
import { UserScopeSection } from './user-scope-section';
import { Component, inject } from '@angular/core';
import { UserFormState } from './user-form-state';

@Component({
  imports: [UserScopeSection],
  providers: [UserFormState],
  template: '<fc-user-scope-section />',
})
class Host {
  readonly state = inject(UserFormState);
}

const COMPANY = { id: 'c1', name: 'Azienda Uno' };
const PLACE = { id: 'p1', name: 'Negozio Uno' };
const SERVICE = { id: 's1', name: 'Taglio' };
const page = (data: object[]) => ({ data: data as never[], page: { limit: 25, next: null } });

function spyReference() {
  return {
    companies: vi.spyOn(ReferenceApi.prototype, 'companies').mockResolvedValue(page([COMPANY])),
    places: vi.spyOn(ReferenceApi.prototype, 'places').mockResolvedValue(page([PLACE])),
    services: vi.spyOn(ReferenceApi.prototype, 'services').mockResolvedValue(page([SERVICE])),
    names: vi.spyOn(ReferenceApi.prototype, 'serviceNames').mockResolvedValue({ s1: 'Taglio' }),
  };
}

async function render(options: StateOptions & { user?: ReturnType<typeof storedUser> } = {}) {
  const spies = spyReference();
  const rendered = await renderWithState(Host, options);
  const legends = () =>
    [...rendered.root.querySelectorAll('legend')].map((legend) => legend.textContent?.trim());
  const as = async (role: string) => {
    rendered.state.model.update((model) => ({ ...model, role }));
    await rendered.view();
  };
  return { ...rendered, ...spies, legends, as };
}

beforeEach(() => sessionStorage.clear());

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserScopeSection: companies', () => {
  it('lets a CA choose companies of the group', async () => {
    const { as, legends, root, companies, state } = await render();
    await as('CA');
    expect(legends()).toContain('USERS.FORM.COMPANIES');
    expect(legends()).not.toContain('USERS.FORM.PLACES');
    expect(companies).toHaveBeenCalledWith(GROUP, { q: '', cursor: null });
    expect(root.textContent).toContain('Azienda Uno');
    const box = root.querySelector<HTMLInputElement>('li input[type=checkbox]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    box.dispatchEvent(new Event('blur'));
    expect(state.model().companyIds).toEqual(['c1']);
    expect(state.userForm.companyIds().touched()).toBe(true);
    expect(root.querySelector('p.note.note')).toBeNull();
  });

  it('shows the error of the companies', async () => {
    const { as, view, root, state } = await render();
    await as('CA');
    state.userForm.companyIds().markAsTouched();
    await view();
    expect(root.textContent).toContain('FORM.ISSUE.REQUIRED');
  });
});

describe('UserScopeSection: stores', () => {
  it('lets a PA choose stores, filtered by company when the actor reads the companies', async () => {
    const { as, view, root, places, state } = await render();
    await as('PA');
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/companies`)
      .flush(page([COMPANY]));
    await view();
    const filter = root.querySelector<HTMLSelectElement>('fc-select select')!;
    expect(filter.previousElementSibling?.textContent).toBe('USERS.FORM.COMPANY_FILTER');
    expect([...filter.options].map((option) => option.textContent?.trim())).toEqual([
      'USERS.FORM.ALL_COMPANIES',
      'Azienda Uno',
    ]);
    expect(places).toHaveBeenLastCalledWith(GROUP, { q: '', cursor: null, companyId: undefined });
    filter.value = 'c1';
    filter.dispatchEvent(new Event('change'));
    await view();
    expect(places).toHaveBeenLastCalledWith(GROUP, { q: '', cursor: null, companyId: 'c1' });
    filter.value = '';
    filter.dispatchEvent(new Event('change'));
    await view();
    expect(places).toHaveBeenLastCalledWith(GROUP, { q: '', cursor: null, companyId: undefined });

    const box = [...root.querySelectorAll<HTMLInputElement>('li input[type=checkbox]')].find(
      (input) => input.closest('label')?.textContent?.includes('Negozio Uno'),
    )!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    box.dispatchEvent(new Event('blur'));
    expect(state.model().placeIds).toEqual(['p1']);
    expect(state.userForm.placeIds().touched()).toBe(true);
  });

  it('asks the companies with a request limited to 200', async () => {
    const { as } = await render();
    await as('E');
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/companies`);
    expect(request.request.params.get('limit')).toBe('200');
    request.flush(page([]));
  });

  it('has no company filter without the permission to read the companies', async () => {
    const { as, legends, root } = await render({
      profile: adminProfile({
        permissions: USER_ADMIN_PERMISSIONS.filter((p) => p !== 'companies:read'),
      }),
    });
    await as('PA');
    expect(legends()).toContain('USERS.FORM.PLACES');
    expect(root.querySelector('fc-select')).toBeNull();
  });

  it('has no company filter in the platform area', async () => {
    const { legends, root, state } = await render({
      groupId: null,
      profile: { role: 'PSA', groupId: null, permissions: ['users:create', 'companies:read'] },
    });
    expect(state.groupId()).toBeUndefined();
    expect(root.querySelector('fc-select')).toBeNull();
    expect(legends()).toEqual([]);
  });

  it('shows the stores of the stored user', async () => {
    const { root, legends } = await render({ user: storedUser({ role: 'E', placeIds: ['p1'] }) });
    backend()
      .match((r) => r.url === `${API}/v1/groups/${GROUP}/companies`)
      .forEach((r) => r.flush(page([])));
    expect(legends()).toContain('USERS.FORM.PLACES');
    expect(root.textContent).toContain('Negozio Uno');
  });
});

describe('UserScopeSection: services', () => {
  it('lets an SA with the feature choose the services, with the names of the selected ones', async () => {
    const { view, root, legends, services, names, state, as } = await render({
      user: storedUser({ role: 'SA', serviceIds: ['s1'] }),
    });
    await as('SA');
    expect(legends()).toEqual(['USERS.FORM.SERVICES']);
    expect(names).toHaveBeenCalledWith(GROUP, ['s1']);
    await view();
    expect(services).toHaveBeenCalledWith(GROUP, { q: '', cursor: null });
    expect(root.querySelector('ul.chosen')?.textContent).toContain('Taglio');
    expect(root.querySelector('p.note')).toBeNull();
    const box = root.querySelector<HTMLInputElement>('li input[type=checkbox]')!;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    box.dispatchEvent(new Event('blur'));
    expect(state.userForm.serviceIds().touched()).toBe(true);
  });

  it('shows the services next to the stores of a PA', async () => {
    const { legends, as } = await render();
    await as('PA');
    backend()
      .match((r) => r.url === `${API}/v1/groups/${GROUP}/companies`)
      .forEach((r) => r.flush(page([])));
    expect(legends()).toEqual(['USERS.FORM.PLACES', 'USERS.FORM.SERVICES']);
  });

  it('does not offer services for the roles without duties', async () => {
    const { as, legends, root } = await render();
    await as('E');
    backend()
      .match((r) => r.url === `${API}/v1/groups/${GROUP}/companies`)
      .forEach((r) => r.flush(page([])));
    expect(legends()).toEqual(['USERS.FORM.PLACES']);
    expect(root.querySelector('p.note')).toBeNull();
  });

  it('says there is nothing to choose when the group has no services feature', async () => {
    const { as, legends, root } = await render({
      profile: adminProfile({ groupFeatures: fakeFeatureFlags(false, { cash: true }) }),
    });
    await as('SA');
    expect(legends()).toEqual([]);
    expect(root.querySelector('p.note')?.textContent).toBe('USERS.FORM.SCOPE_NONE');
  });

  it('says so too for a role without perimeter in the platform area', async () => {
    const { root, state } = await render({
      groupId: null,
      profile: { role: 'PSA', groupId: null, permissions: ['users:create'] },
    });
    expect(state.scopeKind()).toBe('none');
    expect(root.querySelector('p.note')?.textContent).toBe('USERS.FORM.SCOPE_NONE');
  });
});

it('uses the state provided by the page', async () => {
  const { state } = await render();
  expect(state).toBeInstanceOf(UserFormState);
});
