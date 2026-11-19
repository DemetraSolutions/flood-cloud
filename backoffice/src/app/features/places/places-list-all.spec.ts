import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { COMPANY, COUNTRIES, GROUP, PLACE, fakeListItem } from '../../../testing/places';
import { signIn } from '../../../testing/session';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { PlaceListItem } from './place.types';
import { PlacesList } from './places-list';

const G2 = '665f1c2e9b1d4a0012ab34a2';
const DEALER = '665f1c2e9b1d4a0012ab34d1';
const LIST = `${API}/v1/places`;
const PERMISSIONS = [
  'places:read',
  'places:create',
  'places:update',
  'places:trash',
  'companies:read',
  'dealers:read',
];

const ONE = fakeListItem({ groupId: GROUP, groupName: 'Gruppo Uno' });
const TWO = fakeListItem({
  id: '665f1c2e9b1d4a0012ab34b6',
  name: 'Bar Milano',
  groupId: G2,
  groupName: '',
});
const THREE = fakeListItem({
  id: '665f1c2e9b1d4a0012ab34b7',
  name: 'Bar Torino',
  groupId: '665f1c2e9b1d4a0012ab34a3',
  groupName: null,
});

async function render(url = '/places', profile: Partial<Profile> = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter(
        [
          { path: 'places', component: PlacesList, data: { scope: 'all' } },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  signIn({ role: 'PSA', groupId: null, group: null, permissions: PERMISSIONS, ...profile });
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
  /** Answers the page, the pickers, the countries and (when a group is filtered) its companies. */
  const flush = async (
    data: PlaceListItem[],
    dealers: { id: string; businessName: string }[] = [],
  ) => {
    const request = backend().expectOne((r) => r.url === LIST);
    request.flush({ data, page: { limit: 25, next: null } });
    backend().expectOne(`${API}/v1/countries`).flush(COUNTRIES);
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups`)
      .flush({ data: [{ id: GROUP, name: 'Gruppo Uno' }], page: { limit: 100, next: null } });
    for (const request of backend().match((r) => r.url === `${API}/v1/dealers`)) {
      request.flush({ data: dealers, page: { limit: 200, next: null } });
    }
    const companies = backend().match((r) => r.url === `${API}/v1/groups/${GROUP}/companies`);
    for (const request of companies) {
      request.flush({
        data: [{ id: COMPANY, name: 'Azienda del gruppo', trashed: false }],
        page: { limit: 100, next: null },
      });
    }
    await view();
    return { request, companies: companies.length };
  };
  return { root, view, flush, router: TestBed.inject(Router) };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('PlacesList across groups', () => {
  it('reads GET /v1/places without a group (and no companies) and shows the group column', async () => {
    const { flush, root } = await render();
    const { request, companies } = await flush([ONE, TWO, THREE]);
    expect(request.request.params.keys().sort()).toEqual(['limit', 'sort']);
    expect(companies).toBe(0);
    const headers = [...root.querySelectorAll('thead th')].map((h) => h.textContent?.trim());
    expect(headers[0]).toBe('CROSS_GROUP.COLUMN.GROUP');
    const groupLinks = [...root.querySelectorAll<HTMLAnchorElement>('tbody tr td a')].filter((a) =>
      a.getAttribute('href')?.endsWith('/settings'),
    );
    expect(groupLinks.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['Gruppo Uno', `/groups/${GROUP}/settings`],
      ['CROSS_GROUP.NO_NAME', `/groups/${G2}/settings`],
    ]);
    const groupCells = [...root.querySelectorAll('tbody tr')].map((row) =>
      row.querySelector('td')?.textContent?.trim(),
    );
    expect(groupCells).toEqual(['Gruppo Uno', 'CROSS_GROUP.NO_NAME', 'CROSS_GROUP.NO_NAME']);
    // No company names come from the server: no always-empty column.
    expect(headers).not.toContain('PLACES.COLUMN.COMPANY');
  });

  it('opens the place in its group and makes that group the working group', async () => {
    const { flush, root, view } = await render();
    await flush([ONE]);
    root.querySelector<HTMLAnchorElement>(`a[href="/groups/${GROUP}/places/${PLACE}"]`)!.click();
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
    expect(TestBed.inject(GroupContext).groupName()).toBe('Gruppo Uno');
  });

  it('shows the expiration as text (no renewal), no actions, no create and the hint', async () => {
    const { flush, root } = await render();
    await flush([ONE]);
    expect(root.querySelector('a.new')).toBeNull();
    expect(root.querySelector('td.actions button')).toBeNull();
    expect(root.querySelector('fc-place-renewal')).toBeNull();
    expect(root.querySelector('tbody tr')?.textContent).toContain('2030-01-01');
    expect(root.querySelector('.hint')?.textContent).toBe('PLACES.CHOOSE_GROUP_TO_CREATE');
  });

  it('shows no hint to who cannot create', async () => {
    const { flush, root } = await render('/places', { permissions: ['places:read'] });
    await flush([ONE]);
    expect(root.querySelector('.hint')).toBeNull();
  });

  it('sends the group and dealer filters and reads the companies of the filtered group', async () => {
    const { flush } = await render(`/places?groupId=${GROUP}&dealerId=${DEALER}`);
    const { request, companies } = await flush([]);
    expect(request.request.params.get('groupId')).toBe(GROUP);
    expect(request.request.params.get('dealerId')).toBe(DEALER);
    expect(companies).toBe(1);
  });

  it('never sends a dealer filter for a dealer, nor an invalid group', async () => {
    const { flush } = await render(`/places?groupId=nope&dealerId=${DEALER}`, { role: 'D' });
    const { request } = await flush([]);
    expect(request.request.params.has('groupId')).toBe(false);
    expect(request.request.params.has('dealerId')).toBe(false);
  });

  it('changing the group drops the company filter, clearing it keeps the others', async () => {
    const { flush, root, view, router } = await render(
      `/places?groupId=${GROUP}&companyId=${COMPANY}&q=bar`,
    );
    await flush([ONE]);
    const group = root.querySelector<HTMLSelectElement>(
      `#${([...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'CROSS_GROUP.FILTER.GROUP') as HTMLLabelElement).htmlFor}`,
    )!;
    group.value = '';
    group.dispatchEvent(new Event('change'));
    await view();
    expect(router.url).toBe('/places?q=bar');
    backend()
      .expectOne((r) => r.url === LIST)
      .flush({ data: [], page: { limit: 25, next: null } });
    await view();
  });

  it('tolerates a row without its group (nothing is chosen when it is opened)', async () => {
    const { flush, root, view } = await render();
    const orphan = { ...ONE, groupId: undefined, groupName: undefined };
    await flush([orphan]);
    root.querySelector<HTMLAnchorElement>('tbody a')!.click();
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
  });

  it('puts the chosen dealer in the URL', async () => {
    const { flush, root, view, router } = await render();
    await flush([ONE], [{ id: DEALER, businessName: 'Dealer Uno' }]);
    const dealer = root.querySelector<HTMLSelectElement>(
      `#${([...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'CROSS_GROUP.FILTER.DEALER') as HTMLLabelElement).htmlFor}`,
    )!;
    dealer.value = DEALER;
    dealer.dispatchEvent(new Event('change'));
    await view();
    expect(router.url).toBe(`/places?dealerId=${DEALER}`);
    backend()
      .expectOne((r) => r.url === LIST)
      .flush({ data: [], page: { limit: 25, next: null } });
    await view();
  });

  it('chooses the group of a row without a name with an empty name', async () => {
    const { flush, root, view } = await render();
    await flush([TWO]);
    root.querySelector<HTMLAnchorElement>(`a[href="/groups/${G2}/places/${TWO.id}"]`)!.click();
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBe(G2);
    expect(TestBed.inject(GroupContext).groupName()).toBe('');
  });

  it('names the companies when a group is filtered', async () => {
    const { flush, root } = await render(`/places?groupId=${GROUP}`);
    await flush([ONE]);
    const headers = [...root.querySelectorAll('thead th')].map((h) => h.textContent?.trim());
    expect(headers).toContain('PLACES.COLUMN.COMPANY');
    expect(root.querySelector('tbody tr')?.textContent).toContain('Azienda del gruppo');
  });

  it('opens the place of a group that does not exist without a name', async () => {
    const { flush, root, view } = await render();
    await flush([THREE]);
    root
      .querySelector<HTMLAnchorElement>(`a[href="/groups/${THREE.groupId}/places/${THREE.id}"]`)!
      .click();
    await view();
    expect(TestBed.inject(GroupContext).groupName()).toBe('');
  });
});
