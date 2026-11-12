import { signal, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from './api';
import { fakeFeatureFlags } from './groups';
import { signIn } from './session';
import { fakeUser } from './users';
import { I18nService } from '../app/core/i18n/i18n.service';
import { Profile } from '../app/core/session/session.types';
import { UserRecord } from '../app/features/users/user.types';
import { UserFormState } from '../app/features/users/user-form-state';

/** Group of the pages under test. */
export const GROUP = '665f1c2e9b1d4a0012ab34a1';
/** Id of the stored user under test. */
export const USER_ID = '665f1c2e9b1d4a0012ab34ff';

/** Permissions of an actor who manages users, as the server computes them. */
export const USER_ADMIN_PERMISSIONS = [
  'users:read',
  'users:create',
  'users:update',
  'companies:read',
  'places:read',
  'groups:read',
  'products:read',
];

/** Options of {@link renderWithState}. */
export interface StateOptions {
  /** Profile of the signed-in actor (defaults: SA of the group, services and cash on). */
  readonly profile?: Partial<Profile>;
  /** Group of the URL; `null` for the platform area. */
  readonly groupId?: string | null;
  /** User of the URL; `null` for the creation form. */
  readonly userId?: string | null;
}

/** Profile of an SA that manages users and permissions in a group with the services and cash. */
export function adminProfile(overrides: Partial<Profile> = {}): Partial<Profile> {
  return {
    role: 'SA',
    groupId: GROUP,
    permissions: USER_ADMIN_PERMISSIONS,
    canManagePermissions: true,
    groupFeatures: fakeFeatureFlags(false, { cash: true, services: true }),
    ...overrides,
  };
}

/** Configures the TestBed (real interceptors over the testing backend) and signs the actor in. */
export function configureForState(options: StateOptions = {}): void {
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  signIn(options.profile ?? adminProfile());
}

/** A host of tests: it provides its own {@link UserFormState}, as the form page does. */
export interface StateHost {
  readonly state: UserFormState;
}

/**
 * Creates a host that provides a {@link UserFormState} attached to the route parameters in
 * `options`. Nothing is rendered yet.
 */
export function createWithState<T extends StateHost>(host: Type<T>, options: StateOptions = {}) {
  const fixture = TestBed.createComponent(host);
  const state = fixture.componentInstance.state;
  const groupId = signal<string | undefined>(
    options.groupId === null ? undefined : (options.groupId ?? GROUP),
  );
  const userId = signal<string | undefined>(options.userId ?? undefined);
  state.attach(groupId, userId);
  return { fixture, state, groupId, userId };
}

/** Same as {@link createWithState}, rendered and with a stored user applied when given. */
export async function renderWithState<T extends StateHost>(
  component: Type<T>,
  options: StateOptions & { user?: UserRecord } = {},
) {
  configureForState(options);
  const created = createWithState(component, options);
  document.body.appendChild(created.fixture.nativeElement);
  // `whenStable` would wait for the requests that stay open: render with plain change detection.
  created.fixture.detectChanges();
  if (options.user !== undefined) {
    created.userId.set(options.user.id);
    created.fixture.detectChanges();
    backend()
      .expectOne(`${API}/v1/groups/${GROUP}/users/${options.user.id}`)
      .flush({ data: options.user });
  }
  const root = created.fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    created.fixture.detectChanges();
    answerCatalogs();
    await settle();
    created.fixture.detectChanges();
  };
  await view();
  return { ...created, root, view };
}

/** Answers the reads of the price lists and favorites of the POS section with nothing. */
export function answerCatalogs(): void {
  backend()
    .match((request) => /\/(price-lists|product-favorites)$/.test(request.url))
    .filter((request) => !request.cancelled)
    .forEach((request) => request.flush({ data: [], page: { limit: 25, next: null } }));
}

/** A stored user of the group under test. */
export function storedUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return fakeUser({ id: USER_ID, groupId: GROUP, ...overrides });
}
