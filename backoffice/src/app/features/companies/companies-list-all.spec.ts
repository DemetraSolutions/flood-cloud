import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { COMPANY, COUNTRIES, GROUP } from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { CompaniesList } from './companies-list';
import { CompanyListItem } from './company.types';

const G2 = '665f1c2e9b1d4a0012ab34a2';
const DEALER = '665f1c2e9b1d4a0012ab34d1';
const LIST = `${API}/v1/companies`;
const PERMISSIONS = [
  'companies:read',
  'companies:create',
  'companies:trash',
  'companies:delete',
  'dealers:read',
];

const ONE: CompanyListItem = {
  id: COMPANY,
  name: 'Alfa Srl',
  vatNumber: '01114601006',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
  status: 'active',
  trashed: false,
  groupId: GROUP,
  groupName: 'Gruppo Uno',
};
/** A company of a group without a text name (`''`), and one whose group does not exist (`null`). */
const TWO: CompanyListItem = {
  ...ONE,
  id: '665f1c2e9b1d4a0012ab34b9',
  name: 'Beta Srl',
  groupId: G2,
  groupName: '',
};
const THREE: CompanyListItem = {
  ...ONE,
  id: '665f1c2e9b1d4a0012ab34ba',
  name: 'Gamma Srl',
  groupId: '665f1c2e9b1d4a0012ab34a3',
  groupName: null,
};

async function render(url = '/companies', profile: Partial<Profile> = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter(
        [
          { path: 'companies', component: CompaniesList, data: { scope: 'all' } },
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
  /** Answers the page, the group and dealer pickers and the countries. */
  const flush = async (data: CompanyListItem[]) => {
    const request = backend().expectOne((r) => r.url === LIST);
    request.flush({ data, page: { limit: 25, next: null } });
    backend().expectOne(`${API}/v1/countries`).flush(COUNTRIES);
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups`)
      .flush({ data: [{ id: GROUP, name: 'Gruppo Uno' }], page: { limit: 100, next: null } });
    for (const dealers of backend().match((r) => r.url === `${API}/v1/dealers`)) {
      dealers.flush({ data: [], page: { limit: 200, next: null } });
    }
    await view();
    return request;
  };
  return { harness, root, view, flush, router: TestBed.inject(Router) };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CompaniesList across groups', () => {
  it('reads GET /v1/companies without a group and shows the group column', async () => {
    const { flush, root } = await render();
    const request = await flush([ONE, TWO, THREE]);
    expect(request.request.params.keys().sort()).toEqual(['limit', 'sort']);
    const headers = [...root.querySelectorAll('thead th')].map((h) => h.textContent?.trim());
    expect(headers[0]).toBe('CROSS_GROUP.COLUMN.GROUP');
    const groupLinks = [...root.querySelectorAll<HTMLAnchorElement>('tbody tr td a')].filter((a) =>
      a.getAttribute('href')?.endsWith('/settings'),
    );
    expect(groupLinks.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['Gruppo Uno', `/groups/${GROUP}/settings`],
      ['CROSS_GROUP.NO_NAME', `/groups/${G2}/settings`],
    ]);
    // A group that does not exist is shown as a dash, without a link.
    const groupCells = [...root.querySelectorAll('tbody tr')].map((row) =>
      row.querySelector('td')?.textContent?.trim(),
    );
    expect(groupCells).toEqual(['Gruppo Uno', 'CROSS_GROUP.NO_NAME', 'CROSS_GROUP.NO_NAME']);
  });

  it('opens the company in its group and makes that group the working group', async () => {
    const { flush, root, view } = await render();
    await flush([ONE]);
    const link = root.querySelector<HTMLAnchorElement>(
      `a[href="/groups/${GROUP}/companies/${COMPANY}"]`,
    )!;
    expect(link.textContent).toBe('Alfa Srl');
    link.click();
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
    expect(TestBed.inject(GroupContext).groupName()).toBe('Gruppo Uno');
  });

  it('chooses the group of a row without a name with an empty name', async () => {
    const { flush, root, view } = await render();
    await flush([TWO]);
    root.querySelector<HTMLAnchorElement>(`a[href="/groups/${G2}/companies/${TWO.id}"]`)!.click();
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBe(G2);
  });

  it('does not offer to create, trash or delete, and tells to choose a group when creating is allowed', async () => {
    const { flush, root } = await render();
    await flush([ONE]);
    expect(root.querySelector('a.new')).toBeNull();
    expect(root.querySelector('td.actions button')).toBeNull();
    expect(root.querySelector('.hint')?.textContent).toBe('COMPANIES.CHOOSE_GROUP_TO_CREATE');
  });

  it('shows no hint to who cannot create', async () => {
    const { flush, root } = await render('/companies', { permissions: ['companies:read'] });
    await flush([ONE]);
    expect(root.querySelector('.hint')).toBeNull();
  });

  it('sends the group and dealer filters of the URL (a platform administrator) and drops invalid ones', async () => {
    const { flush } = await render(`/companies?groupId=${GROUP}&dealerId=${DEALER}`);
    const request = await flush([]);
    expect(request.request.params.get('groupId')).toBe(GROUP);
    expect(request.request.params.get('dealerId')).toBe(DEALER);
  });

  it('never sends a dealer filter for a dealer, nor an invalid group', async () => {
    const { flush } = await render(`/companies?groupId=nope&dealerId=${DEALER}`, { role: 'D' });
    const request = await flush([]);
    expect(request.request.params.has('groupId')).toBe(false);
    expect(request.request.params.has('dealerId')).toBe(false);
  });

  it('puts the chosen group and dealer in the URL and clears them', async () => {
    const { flush, root, view, router } = await render();
    await flush([ONE]);
    const select = (label: string) =>
      root.querySelector<HTMLSelectElement>(
        `#${([...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label) as HTMLLabelElement).htmlFor}`,
      )!;
    select('CROSS_GROUP.FILTER.GROUP').value = GROUP;
    select('CROSS_GROUP.FILTER.GROUP').dispatchEvent(new Event('change'));
    await view();
    expect(router.url).toBe(`/companies?groupId=${GROUP}`);
    backend()
      .expectOne((r) => r.url === LIST)
      .flush({ data: [], page: { limit: 25, next: null } });
    await view();
    select('CROSS_GROUP.FILTER.GROUP').value = '';
    select('CROSS_GROUP.FILTER.GROUP').dispatchEvent(new Event('change'));
    await view();
    expect(router.url).toBe('/companies');
    backend()
      .expectOne((r) => r.url === LIST)
      .flush({ data: [], page: { limit: 25, next: null } });
  });

  it('tolerates a row without its group (nothing is chosen when it is opened)', async () => {
    const { flush, root, view } = await render();
    const orphan = { ...ONE, groupId: undefined, groupName: undefined };
    await flush([orphan]);
    root.querySelector<HTMLAnchorElement>('tbody a')!.click();
    await view();
    expect(TestBed.inject(GroupContext).groupId()).toBeNull();
  });

  it('opens the company of a group that does not exist without a name', async () => {
    const { flush, root, view } = await render();
    await flush([THREE]);
    root
      .querySelector<HTMLAnchorElement>(`a[href="/groups/${THREE.groupId}/companies/${THREE.id}"]`)!
      .click();
    await view();
    expect(TestBed.inject(GroupContext).groupName()).toBe('');
  });
});
