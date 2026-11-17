import { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TrashPage } from '../app/features/trash/trash-page';
import {
  TrashedCompany,
  TrashedGroup,
  TrashedPlace,
  TrashedUser,
  TrashItemResult,
  TrashKind,
} from '../app/features/trash/trash.types';
import { I18nService } from '../app/core/i18n/i18n.service';
import { Profile } from '../app/core/session/session.types';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, provideApiTesting, settle } from './api';
import { GROUP } from './companies';
import { emulateNativeDialog } from './dialog';
import { signIn } from './session';
import { fakeGroupListItem } from './groups';
import { fakeUser } from './users';

export { GROUP };

/** Permissions of a platform administrator on the trash. */
export const TRASH_ALL = [
  'companies:read',
  'companies:trash',
  'companies:delete',
  'places:read',
  'places:trash',
  'places:delete',
  'users:read',
  'users:trash',
  'users:delete',
  'groups:trash',
  'dealers:read',
  'trash:empty',
  'profile:read',
];

export const TRASHED_AT = '2026-11-10T10:00:00.000Z';

export const COMPANY_ROW: TrashedCompany = {
  id: '665f1c2e9b1d4a0012ab3501',
  name: 'Alfa Srl',
  vatNumber: '01114601006',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
  status: 'active',
  trashed: true,
  trashedAt: TRASHED_AT,
};
export const COMPANY_LEGACY: TrashedCompany = {
  ...COMPANY_ROW,
  id: '665f1c2e9b1d4a0012ab3502',
  name: 'Beta Srl',
  vatNumber: null,
  city: null,
  province: null,
  country: null,
  trashedAt: null,
};
export const PLACE_ROW: TrashedPlace = {
  id: '665f1c2e9b1d4a0012ab3601',
  name: 'Bar Centro',
  companyId: COMPANY_ROW.id,
  trashed: true,
  plan: null,
  status: 'active',
  city: 'Roma',
  province: 'RM',
  country: 'IT',
  expirationDate: null,
  trashedAt: TRASHED_AT,
};
export const PLACE_NO_COMPANY: TrashedPlace = {
  ...PLACE_ROW,
  id: '665f1c2e9b1d4a0012ab3602',
  name: 'Bar Nord',
  companyId: null,
  city: null,
  province: null,
  country: null,
  trashedAt: null,
};
export const USER_ROW: TrashedUser = {
  ...fakeUser({
    id: '665f1c2e9b1d4a0012ab3701',
    username: 'anna',
    firstName: 'Anna',
    lastName: 'Verdi',
    email: 'anna@example.com',
    role: 'CA',
    groupId: GROUP,
    trashed: true,
  }),
  trashedAt: TRASHED_AT,
};
export const USER_BARE: TrashedUser = {
  ...fakeUser({
    id: '665f1c2e9b1d4a0012ab3702',
    username: 'bare',
    firstName: null,
    lastName: null,
    email: null,
    role: 'E',
    groupId: GROUP,
    trashed: true,
  }),
  trashedAt: null,
};
export const GROUP_ROW: TrashedGroup = {
  ...fakeGroupListItem({
    id: '665f1c2e9b1d4a0012ab3801',
    name: 'Gruppo Alfa',
    trashed: true,
    dealerId: '665f1c2e9b1d4a0012ab34d1',
  }),
  trashedAt: TRASHED_AT,
};
export const GROUP_NO_DEALER: TrashedGroup = {
  ...fakeGroupListItem({ id: '665f1c2e9b1d4a0012ab3802', name: 'Gruppo Beta', trashed: true }),
  trashedAt: null,
};

/** A page of the list of a tab. */
export function trashPage<T>(data: T[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

/** Result of an item of a bulk call. */
export function result(
  id: string,
  outcome: TrashItemResult['outcome'],
  issue?: TrashItemResult['issue'],
): TrashItemResult {
  return issue === undefined ? { id, outcome } : { id, outcome, issue };
}

/** URL of the list of a tab. */
export function listUrl(kind: TrashKind): string {
  return kind === 'groups' ? `${API}/v1/groups` : `${API}/v1/groups/${GROUP}/${kind}`;
}

/** Answers the reads that go with a tab: the companies of the places (not the list) and the dealers of the groups. */
function answerLookups(companies: object[], dealers: object[]): void {
  const lookup = (r: { url: string; params: { get(name: string): string | null } }) =>
    r.url === `${API}/v1/groups/${GROUP}/companies` && r.params.get('trashed') === null;
  for (const read of backend().match(lookup)) {
    read.flush(trashPage(companies));
  }
  for (const read of backend().match((r) => r.url === `${API}/v1/dealers`)) {
    read.flush(trashPage(dealers));
  }
}

/** Renders the trash page at a URL as a user with the given permissions (a platform administrator by default). */
export async function renderTrash(
  url = `/groups/${GROUP}/trash`,
  profile: Partial<Profile> = {},
  extra: Provider[] = [],
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/trash', component: TrashPage },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', groupId: null, group: null, permissions: TRASH_ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const router = TestBed.inject(Router);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  /** The read of the list of a tab (`trashed=true`). */
  const request = (kind: TrashKind) =>
    backend().expectOne((r) => r.url === listUrl(kind) && r.params.get('trashed') === 'true');
  /** Answers the reads that go with a tab (companies of the places, dealers of the groups). */
  const lookups = async (companies: object[] = [COMPANY_ROW], dealers: object[] = []) => {
    answerLookups(companies, dealers);
    await view();
  };
  const flush = async (kind: TrashKind, data: object[], next: string | null = null) => {
    const req = request(kind);
    req.flush(trashPage(data, next));
    await view();
    return req;
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const checkboxes = () => [...root.querySelectorAll<HTMLInputElement>('td input[type=checkbox]')];
  const tick = async (input: HTMLInputElement, checked = true) => {
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const selectAll = () =>
    [...root.querySelectorAll<HTMLInputElement>('.bulk fc-checkbox input')][0];
  const button = (text: string, scope = '.bulk') =>
    [...root.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
      (b) => b.textContent?.trim() === text,
    );
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    );
  const openDialogs = () => [...root.querySelectorAll('dialog[open]')];
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const search = () => new URL(router.url, 'http://x').searchParams;
  return {
    harness,
    root,
    router,
    view,
    request,
    lookups,
    flush,
    rows,
    cells,
    checkboxes,
    tick,
    selectAll,
    button,
    dialogButton,
    openDialogs,
    toasts,
    search,
  };
}

/** Closes the test: every read was answered, nothing is left in the document. */
export function finishTrash(): void {
  answerLookups([], []);
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
}
