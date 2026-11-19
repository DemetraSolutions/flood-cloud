import { GroupContext } from './core/groups/group-context';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { fakeCompany } from '../testing/companies';
import { fakePlace } from '../testing/places';
import { fakeFeatureFlags, fakeGroup } from '../testing/groups';
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
      ['/platform/users', psa(), '⟦USERS.TITLE⟧'],
      ['/users', psa(), '⟦USERS.TITLE⟧'],
      ['/dealers', psa(['dealers:read']), '⟦DEALERS.TITLE⟧'],
      [
        '/dealers/new',
        psa(['dealers:read', 'dealers:create', 'users:create']),
        '⟦DEALERS.FORM.NEW_TITLE⟧',
      ],
      ['/dealers/d1', psa(['dealers:read']), '⟦DEALERS.FORM.EDIT_TITLE⟧'],
      ['/tools/new-customer', psa(['groups:create']), '⟦NEW_CUSTOMER.TITLE⟧'],
      [
        '/tools/new-customer',
        { ...psa(['groups:create']), role: 'D' as const },
        '⟦NEW_CUSTOMER.TITLE⟧',
      ],
      ['/users', { ...psa(), role: 'D' as const }, '⟦USERS.TITLE⟧'],
      ['/platform/users/new', psa([...READ, 'users:create']), '⟦USERS.FORM.NEW_TITLE⟧'],
      ['/platform/users/u1', psa(), '⟦USERS.FORM.EDIT_TITLE⟧'],
      ['/groups', psa(), '⟦GROUP_CHOOSER.TITLE⟧'],
      ['/groups/list', psa(['groups:read']), '⟦GROUPS.TITLE⟧'],
      ['/trash', psa(['companies:read']), '⟦TRASH.TITLE⟧'],
      ['/trash', { ...psa(['users:read']), role: 'D' as const }, '⟦TRASH.TITLE⟧'],
      ['/companies', psa(['companies:read']), '⟦COMPANIES.TITLE⟧'],
      ['/companies', { ...psa(['companies:read']), role: 'D' as const }, '⟦COMPANIES.TITLE⟧'],
      ['/places', psa(['places:read']), '⟦PLACES.TITLE⟧'],
      ['/places', { ...psa(['places:read']), role: 'D' as const }, '⟦PLACES.TITLE⟧'],
      ['/groups/list', { ...psa(['groups:read']), role: 'D' as const }, '⟦GROUPS.TITLE⟧'],
      ['/activity-log', sa(['activityLog:read', 'profile:read']), '⟦ACTIVITY.TITLE⟧'],
      ['/tools/tobaccos', psa(['tobaccos:read']), '⟦TOBACCOS.TITLE⟧'],
      ['/settings/countries', psa(['countries:manage']), '⟦COUNTRIES.TITLE⟧'],
      ['/settings/countries/IT', psa(['countries:manage']), '⟦COUNTRIES.DETAIL_TITLE⟧'],
    ])('lazy-loads %s', async (url, profile, expected) => {
      expect(await go(url, profile)).toBe(expected);
    });

    it('redirects the old platform list to the one list, keeping the filters', async () => {
      await go('/platform/users?role=D&q=ann', psa());
      expect(location()).toBe('/users?role=D&q=ann');
    });

    it.each([
      ['/tools/activations?month=2026-05', '/activations?month=2026-05'],
      [
        '/tools/activations/d1?month=2026-05&section=renewals',
        '/activations/d1?month=2026-05&section=renewals',
      ],
    ])('redirects the old activations address %s keeping the query', async (from, to) => {
      await go(from, psa([...READ, 'activations:read']));
      expect(location()).toBe(to);
    });

    it('redirects the old price list address to the settings', async () => {
      await go('/tools/price-list', psa([...READ, 'activations:manage']));
      expect(location()).toBe('/settings/price-list');
    });

    it('opens the list of the chosen group when a PSA goes to the cross-group list', async () => {
      setup();
      sessionStorage.clear();
      signIn(psa());
      TestBed.inject(GroupContext).choose({ id: GROUP, name: 'Alfa' });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/users?status=active&cursor=c1');
      expect(location()).toBe(`/groups/${GROUP}/users?status=active`);
      sessionStorage.clear();
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

    it('lazy-loads the public API section for whoever has apiKeys:read', async () => {
      setup();
      sessionStorage.clear();
      signIn({
        role: 'D',
        groupId: null,
        permissions: ['groups:read', 'apiKeys:read', 'profile:read'],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(`/groups/${GROUP}/settings/public-api`);
      TestBed.inject(HttpTestingController)
        .expectOne((r) => r.url.endsWith(`/v1/groups/${GROUP}`))
        .flush({ data: fakeGroup({ id: GROUP }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      const root = harness.routeNativeElement as HTMLElement;
      expect(root.querySelector('main nav a.active')?.textContent?.trim()).toBe(
        '⟦GROUP_SETTINGS.SECTION.PUBLIC_API⟧',
      );
      expect(root.querySelector('fc-group-public-api')).not.toBeNull();
      TestBed.inject(HttpTestingController).match(() => true);
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
      ['/tools/new-customer', psa([])],
      ['/tools/new-customer', sa(['groups:create'])],
      ['/tools/tobaccos', psa([])],
      ['/tools/tobaccos', { ...psa(['tobaccos:read']), role: 'D' as const }],
      ['/tools/tobaccos', sa(['tobaccos:read'])],
      ['/settings/countries', psa([])],
      ['/settings/countries', { ...psa(['countries:manage']), role: 'D' as const }],
      ['/settings/countries/IT', sa(['countries:manage'])],
      ['/users', psa([])],
      ['/platform/users', { ...psa([]) }],
      ['/activity-log', sa()],
      ['/groups/list', psa([])],
      ['/trash', psa([])],
      ['/trash', sa(['companies:read'])],
      ['/companies', psa([])],
      ['/companies', sa(['companies:read'])],
      ['/places', psa([])],
      ['/places', sa(['places:read'])],
      ['/groups/list', sa(['groups:read'])],
      [`/groups/${GROUP}/settings`, sa([])],
      [`/groups/${GROUP}/settings/public-api`, sa(['groups:read'])],
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
  describe('email templates', () => {
    const GROUP = '665f1c2e9b1d4a0012ab34a1';
    const TEMPLATE = '665f1c2e9b1d4a0012ab34c1';
    const ON = fakeFeatureFlags(false, { email: true });

    afterEach(() => sessionStorage.clear());

    async function open(url: string, permissions: string[], groupFeatures = ON) {
      setup();
      sessionStorage.clear();
      signIn({ role: 'SA', permissions: [...permissions, 'profile:read'], groupFeatures });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(url);
      return harness;
    }

    it('lazy-loads the list for whoever reads places', async () => {
      const harness = await open(`/groups/${GROUP}/email-templates`, ['places:read']);
      expect(
        (harness.routeNativeElement as HTMLElement).querySelector('main h1')?.textContent,
      ).toBe('⟦EMAIL_TEMPLATES.TITLE⟧');
    });

    it('lazy-loads the page of a new template for whoever updates places', async () => {
      const harness = await open(`/groups/${GROUP}/email-templates/new`, [
        'places:read',
        'places:update',
      ]);
      const root = harness.routeNativeElement as HTMLElement;
      expect(root.querySelector('fc-email-template-page')).not.toBeNull();
      expect(root.querySelector('fc-email-preview iframe')).not.toBeNull();
    });

    it('lazy-loads the page of a template', async () => {
      const harness = await open(`/groups/${GROUP}/email-templates/${TEMPLATE}`, ['places:read']);
      TestBed.inject(HttpTestingController)
        .expectOne((r) => r.url.endsWith(`/v1/groups/${GROUP}/email-templates/${TEMPLATE}`))
        .flush({
          data: { id: TEMPLATE, name: 'N', text: '', html: '', createdAt: null, updatedAt: null },
        });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.detectChanges();
      expect(
        (harness.routeNativeElement as HTMLElement).querySelector('fc-email-template-page'),
      ).not.toBeNull();
    });

    it.each([
      [`/groups/${GROUP}/email-templates`, []],
      [`/groups/${GROUP}/email-templates/${TEMPLATE}`, []],
      [`/groups/${GROUP}/email-templates/new`, ['places:read']],
    ])('protects %s with the permissions', async (url, permissions) => {
      await open(url, permissions);
      expect(location()).toBe('/forbidden');
    });

    it.each([
      `/groups/${GROUP}/email-templates`,
      `/groups/${GROUP}/email-templates/new`,
      `/groups/${GROUP}/email-templates/${TEMPLATE}`,
    ])('sends %s to the feature-disabled page when the group has no e-mail', async (url) => {
      await open(url, ['places:read', 'places:update'], fakeFeatureFlags(false));
      expect(location()).toBe('/feature-disabled');
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
      ['/devices', 'fc-place-devices'],
      ['/print-stations', 'fc-place-print-stations'],
      ['/rooms', 'fc-place-rooms'],
      ['/storages', 'fc-place-storages'],
      ['/hours', 'fc-place-hours'],
      ['/media', 'fc-place-media'],
      ['/integrations', 'fc-place-integrations'],
      ['/settings', 'fc-place-settings'],
      ['/settings/dealer', 'fc-place-dealer'],
      ['/settings/general', 'fc-place-cash'],
      ['/settings/rooms-settings', 'fc-place-tables'],
      ['/settings/delivery', 'fc-place-delivery'],
      ['/settings/reservations', 'fc-place-reservations'],
      ['/settings/self-ordering', 'fc-place-self-ordering'],
      ['/settings/external-display', 'fc-place-scalar-tab'],
      ['/settings/kiosk', 'fc-place-kiosk'],
      ['/settings/appointments', 'fc-place-scalar-tab'],
      ['/settings/fidelity', 'fc-place-scalar-tab'],
      ['/settings/tobacco', 'fc-place-scalar-tab'],
      ['/settings/print', 'fc-place-printing'],
      ['/settings/other', 'fc-place-other'],
      ['/settings/payments', 'fc-place-payments'],
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

    it.each([
      [`/groups/${GROUP}/places`, []],
      [`/groups/${GROUP}/places/${PLACE}`, []],
      [`/groups/${GROUP}/places/${PLACE}/settings/general`, []],
      [`/groups/${GROUP}/places/new`, ['places:read']],
      [`/groups/${GROUP}/places/new`, ['places:create']],
    ])('protects %s', async (url, permissions) => {
      await open(url, permissions);
      expect(location()).toBe('/forbidden');
    });
  });
});
