import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { fakeCompany } from '../testing/companies';
import { fakePlace } from '../testing/places';
import { fakeGroup } from '../testing/groups';
import { signIn } from '../testing/session';
import { App } from './app';
import { StartupState } from './core/startup/startup-state';
import { routes } from './app.routes';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter(routes, withComponentInputBinding()),
    ],
  });
}

describe('App', () => {
  it('renders the routed application when startup succeeded', async () => {
    setup();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('router-outlet')).not.toBeNull();
    expect(root.querySelector('fc-toast-region')).not.toBeNull();
    expect(root.querySelector('fc-startup-error')).toBeNull();
  });

  it('renders the startup error page instead of the application when startup failed', async () => {
    setup();
    TestBed.inject(StartupState).fail();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('fc-startup-error')).not.toBeNull();
    expect(root.querySelector('router-outlet')).toBeNull();
    expect(root.querySelector('fc-toast-region')).toBeNull();
  });
});

describe('routes', () => {
  async function open(url: string) {
    setup();
    const harness = await RouterTestingHarness.create();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await harness.navigateByUrl(url);
    return { harness, root: harness.routeNativeElement as HTMLElement };
  }

  const title = (root: HTMLElement) => root.querySelector('h1')?.textContent;
  const location = () => TestBed.inject(Router).url;

  it.each([
    ['/', 'HOME.TITLE'],
    ['/forbidden', 'ERRORS.FORBIDDEN.TITLE'],
    ['/error', 'ERRORS.GENERIC.TITLE'],
    ['/does/not/exist', 'ERRORS.NOT_FOUND.TITLE'],
    ['/profile', 'PROFILE.TITLE'],
    ['/profile/sessions', 'SESSIONS.TITLE'],
    ['/change-password', 'AUTH.CHANGE_PASSWORD.TITLE'],
  ])('lazy-loads %s inside the shell for a signed-in user', async (url, expected) => {
    setup();
    signIn();
    const harness = await RouterTestingHarness.create();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('main h1')?.textContent).toBe(`⟦${expected}⟧`);
    expect(root.querySelector('header')).not.toBeNull();
  });

  it('shows the login page, outside the shell, to an anonymous visitor', async () => {
    const { root } = await open('/login');
    expect(title(root)).toBe('⟦AUTH.LOGIN.TITLE⟧');
    expect(root.querySelector('header')).toBeNull();
  });

  it('sends an anonymous visitor to the login keeping the requested page', async () => {
    const { root } = await open('/profile/sessions?x=1');
    expect(location()).toBe('/login?returnUrl=%2Fprofile%2Fsessions%3Fx%3D1');
    expect(title(root)).toBe('⟦AUTH.LOGIN.TITLE⟧');
  });

  it('sends an anonymous visitor of the home page to a plain login', async () => {
    await open('/');
    expect(location()).toBe('/login');
  });

  it('keeps a signed-in user away from the login page', async () => {
    setup();
    signIn();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login');
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('lets only the change-password page through while a temporary password is pending', async () => {
    setup();
    signIn({ passwordChangeRequired: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = await RouterTestingHarness.create();
    for (const url of ['/', '/profile', '/does/not/exist']) {
      await harness.navigateByUrl(url);
      expect(TestBed.inject(Router).url).toBe('/change-password');
    }
    expect((harness.routeNativeElement as HTMLElement).querySelector('h1')?.textContent).toBe(
      '⟦AUTH.CHANGE_PASSWORD.TITLE⟧',
    );
  });

  it('protects the route, not only the menu entry, with the permission', async () => {
    setup();
    signIn({ permissions: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/profile/sessions');
    expect(TestBed.inject(Router).url).toBe('/forbidden');
  });

  describe('users', () => {
    const GROUP = '665f1c2e9b1d4a0012ab34a1';
    const READ = ['users:read', 'profile:read'];
    const sa = (permissions: string[] = READ) => ({ role: 'SA' as const, permissions });
    const psa = (permissions: string[] = READ) => ({
      role: 'PSA' as const,
      groupId: null,
      group: null,
      permissions,
    });

    async function go(url: string, profile: Parameters<typeof signIn>[0]) {
      setup();
      sessionStorage.clear();
      signIn(profile);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      return (harness.routeNativeElement as HTMLElement).querySelector('main h1')?.textContent;
    }

    it.each([
      [`/groups/${GROUP}/users`, sa(), '⟦USERS.TITLE⟧'],
      [`/groups/${GROUP}/users/new`, sa([...READ, 'users:create']), '⟦USERS.FORM.NEW_TITLE⟧'],
      [`/groups/${GROUP}/users/u1`, sa(), '⟦USERS.FORM.EDIT_TITLE⟧'],
      ['/platform/users', psa(), '⟦USERS.PLATFORM_TITLE⟧'],
      ['/users', psa(), '⟦USERS.TITLE⟧'],
      ['/dealers', psa(['dealers:read']), '⟦DEALERS.TITLE⟧'],
      [
        '/dealers/new',
        psa(['dealers:read', 'dealers:create', 'users:create']),
        '⟦DEALERS.FORM.NEW_TITLE⟧',
      ],
      ['/dealers/d1', psa(['dealers:read']), '⟦DEALERS.FORM.EDIT_TITLE⟧'],
      ['/users', { ...psa(), role: 'D' as const }, '⟦USERS.TITLE⟧'],
      ['/platform/users/new', psa([...READ, 'users:create']), '⟦USERS.FORM.NEW_TITLE⟧'],
      ['/platform/users/u1', psa(), '⟦USERS.FORM.EDIT_TITLE⟧'],
      ['/groups', psa(), '⟦GROUP_CHOOSER.TITLE⟧'],
      ['/groups/list', psa(['groups:read']), '⟦GROUPS.TITLE⟧'],
      ['/groups/list', { ...psa(['groups:read']), role: 'D' as const }, '⟦GROUPS.TITLE⟧'],
      ['/activity-log', sa(['activityLog:read', 'profile:read']), '⟦ACTIVITY.TITLE⟧'],
    ])('lazy-loads %s', async (url, profile, expected) => {
      expect(await go(url, profile)).toBe(expected);
    });

    it.each([
      ['', 'GENERAL'],
      ['/features', 'FEATURES'],
      ['/integrations', 'INTEGRATIONS'],
      ['/price-lists', 'PRICE_LISTS'],
      ['/taxes', 'TAXES'],
      ['/currencies', 'CURRENCIES'],
      ['/measure-units', 'MEASURE_UNITS'],
      ['/warehouse-rules', 'WAREHOUSE_RULES'],
      ['/fidelity-card-rules', 'FIDELITY_CARD_RULES'],
    ])('lazy-loads the section %s of the group record', async (path, key) => {
      setup();
      sessionStorage.clear();
      signIn({ role: 'SA', permissions: ['groups:read', 'profile:read'] });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(`/groups/${GROUP}/settings${path}`);
      TestBed.inject(HttpTestingController)
        .expectOne((r) => r.url.endsWith(`/v1/groups/${GROUP}`))
        .flush({
          data: fakeGroup({ id: GROUP }),
        });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      const active = (harness.routeNativeElement as HTMLElement).querySelector('main nav a.active');
      expect(active?.textContent?.trim()).toBe(`⟦GROUP_SETTINGS.SECTION.${key}⟧`);
    });

    it.each([
      ['fidelity/card-types', 'fidelity:read', 'CARD_TYPES'],
      ['fidelity/points-collections', 'fidelity:read', 'POINTS_COLLECTIONS'],
      ['fidelity/prize-catalogues', 'fidelity:read', 'PRIZE_CATALOGUES'],
      ['product-favorites', 'products:read', 'PRODUCT_FAVORITES'],
      ['promotions', 'products:read', 'PROMOTIONS'],
    ])('lazy-loads %s for the user of the group, who needs only %s', async (path, needed, kind) => {
      setup();
      sessionStorage.clear();
      signIn({ role: 'CA', permissions: [needed, 'profile:read'] });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(`/groups/${GROUP}/${path}`);
      const root = harness.routeNativeElement as HTMLElement;
      expect(root.querySelector('main h2')?.textContent).toBe(`⟦CATALOG.${kind}.TITLE⟧`);
    });

    it.each([
      ['fidelity/card-types', 'products:read'],
      ['fidelity/points-collections', 'products:read'],
      ['fidelity/prize-catalogues', 'groups:read'],
      ['product-favorites', 'fidelity:read'],
      ['promotions', 'fidelity:read'],
    ])('protects %s: %s is not enough', async (path, granted) => {
      await go(`/groups/${GROUP}/${path}`, sa([granted]));
      expect(location()).toBe('/forbidden');
    });

    it('shows the feature-disabled page', async () => {
      expect(await go('/feature-disabled', sa())).toBe('⟦ERRORS.FEATURE_DISABLED.TITLE⟧');
    });

    it('sends the user of a group from /groups to the users of their group', async () => {
      await go('/groups', sa());
      expect(location()).toBe(`/groups/${GROUP}/users`);
    });

    it.each([
      [`/groups/${GROUP}/users`, sa([])],
      [`/groups/${GROUP}/users/new`, sa()],
      ['/groups', sa([])],
      ['/platform/users', sa()],
      ['/users', sa()],
      ['/dealers', sa(['dealers:read'])],
      ['/dealers', psa([])],
      ['/dealers/new', psa(['dealers:read', 'dealers:create'])],
      ['/users', psa([])],
      ['/platform/users', { ...psa([]) }],
      ['/activity-log', sa()],
      ['/groups/list', psa([])],
      ['/groups/list', sa(['groups:read'])],
      [`/groups/${GROUP}/settings`, sa([])],
    ])('protects %s', async (url, profile) => {
      await go(url, profile);
      expect(location()).toBe('/forbidden');
    });
  });

  describe('companies', () => {
    const GROUP = '665f1c2e9b1d4a0012ab34a1';
    const COMPANY = '665f1c2e9b1d4a0012ab34b2';
    const sa = (permissions: string[]) => ({
      role: 'SA' as const,
      permissions: [...permissions, 'profile:read'],
    });

    async function open(url: string, permissions: string[]) {
      setup();
      sessionStorage.clear();
      signIn(sa(permissions));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      return harness;
    }

    it('lazy-loads the list', async () => {
      const list = await open(`/groups/${GROUP}/companies`, ['companies:read']);
      expect((list.routeNativeElement as HTMLElement).querySelector('main h1')?.textContent).toBe(
        '⟦COMPANIES.TITLE⟧',
      );
    });

    it('lazy-loads the page of a new company', async () => {
      const created = await open(`/groups/${GROUP}/companies/new`, [
        'companies:read',
        'companies:create',
      ]);
      expect(
        (created.routeNativeElement as HTMLElement).querySelector('main h1')?.textContent,
      ).toBe('⟦COMPANIES.NEW_TITLE⟧');
    });

    it.each([
      ['', 'fc-company-general'],
      ['/e-invoicing', 'fc-company-e-invoicing'],
      ['/invoice-numbering', 'fc-company-numbering'],
      ['/bank-accounts', 'fc-company-banks'],
      ['/meal-vouchers', 'fc-company-meal-vouchers'],
      ['/customer-app', 'fc-company-customer-app'],
      ['/media', 'fc-company-media'],
    ])('lazy-loads the tab %s of a company', async (path, selector) => {
      const harness = await open(`/groups/${GROUP}/companies/${COMPANY}${path}`, [
        'companies:read',
      ]);
      TestBed.inject(HttpTestingController)
        .expectOne((r) => r.url.endsWith(`/v1/groups/${GROUP}/companies/${COMPANY}`))
        .flush({ data: fakeCompany() });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      expect((harness.routeNativeElement as HTMLElement).querySelector(selector)).not.toBeNull();
    });

    it.each([
      [`/groups/${GROUP}/companies`, []],
      [`/groups/${GROUP}/companies/${COMPANY}`, []],
      [`/groups/${GROUP}/companies/new`, ['companies:read']],
    ])('protects %s', async (url, permissions) => {
      await open(url, permissions);
      expect(location()).toBe('/forbidden');
    });
  });
  describe('places', () => {
    const GROUP = '665f1c2e9b1d4a0012ab34a1';
    const PLACE = '665f1c2e9b1d4a0012ab34b3';
    const sa = (permissions: string[]) => ({
      role: 'SA' as const,
      permissions: [...permissions, 'profile:read'],
    });

    async function open(url: string, permissions: string[]) {
      setup();
      sessionStorage.clear();
      signIn(sa(permissions));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      return harness;
    }

    it('lazy-loads the list', async () => {
      const list = await open(`/groups/${GROUP}/places`, ['places:read']);
      expect((list.routeNativeElement as HTMLElement).querySelector('main h1')?.textContent).toBe(
        '⟦PLACES.TITLE⟧',
      );
    });

    it('lazy-loads the page of a new place', async () => {
      const created = await open(`/groups/${GROUP}/places/new`, ['places:read', 'places:create']);
      const root = created.routeNativeElement as HTMLElement;
      expect(root.querySelector('fc-place-page')).not.toBeNull();
      expect(root.querySelector('fc-place-general')).not.toBeNull();
    });

    it.each([
      ['', 'fc-place-general'],
      ['/license', 'fc-place-license'],
      ['/opening-hours', 'fc-place-hours'],
      ['/cash', 'fc-place-cash'],
      ['/printing', 'fc-place-printing'],
      ['/payments', 'fc-place-payments'],
      ['/tables', 'fc-place-tables'],
      ['/reservations', 'fc-place-reservations'],
      ['/delivery', 'fc-place-delivery'],
      ['/self-ordering', 'fc-place-self-ordering'],
      ['/kiosk', 'fc-place-kiosk'],
      ['/appointments', 'fc-place-scalar-tab'],
      ['/external-display', 'fc-place-scalar-tab'],
      ['/fidelity', 'fc-place-scalar-tab'],
      ['/tobacco', 'fc-place-scalar-tab'],
      ['/media', 'fc-place-media'],
    ])('lazy-loads the tab %s of a place', async (path, selector) => {
      const harness = await open(`/groups/${GROUP}/places/${PLACE}${path}`, ['places:read']);
      TestBed.inject(HttpTestingController)
        .expectOne((r) => r.url.endsWith(`/v1/groups/${GROUP}/places/${PLACE}`))
        .flush({ data: fakePlace() });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      expect((harness.routeNativeElement as HTMLElement).querySelector(selector)).not.toBeNull();
    });

    it('lazy-loads the store key tab with storeKeys:read', async () => {
      const harness = await open(`/groups/${GROUP}/places/${PLACE}/store-key`, [
        'places:read',
        'storeKeys:read',
      ]);
      TestBed.inject(HttpTestingController)
        .expectOne((r) => r.url.endsWith(`/v1/groups/${GROUP}/places/${PLACE}`))
        .flush({ data: fakePlace() });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      expect(
        (harness.routeNativeElement as HTMLElement).querySelector('fc-place-store-key'),
      ).not.toBeNull();
    });

    it('protects the store key tab without storeKeys:read', async () => {
      await open(`/groups/${GROUP}/places/${PLACE}/store-key`, ['places:read']);
      expect(location()).toBe('/forbidden');
    });

    it.each([
      [`/groups/${GROUP}/places`, []],
      [`/groups/${GROUP}/places/${PLACE}`, []],
      [`/groups/${GROUP}/places/${PLACE}/license`, []],
      [`/groups/${GROUP}/places/new`, ['places:read']],
      [`/groups/${GROUP}/places/new`, ['places:create']],
    ])('protects %s', async (url, permissions) => {
      await open(url, permissions);
      expect(location()).toBe('/forbidden');
    });
  });
});
