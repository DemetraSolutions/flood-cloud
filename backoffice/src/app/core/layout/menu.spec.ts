import { Role } from '../session/session.types';
import {
  activeMenuIds,
  activeParentIds,
  chooserTarget,
  GROUP_TARGETS,
  MENU,
  MenuItem,
  visibleMenu,
} from './menu';

const allowAll = (): boolean => true;

const ITEMS: MenuItem[] = [
  { id: 'a', labelKey: 'A', icon: 'home', route: '/a' },
  { id: 'b', labelKey: 'B', icon: 'home', route: '/b', permission: 'b.read' },
  { id: 'c', labelKey: 'C', icon: 'home', route: '/c', feature: 'fiscal' },
  {
    id: 'g',
    labelKey: 'G',
    icon: 'home',
    route: '/g',
    children: [
      { id: 'g1', labelKey: 'G1', icon: 'home', route: '/g/1', permission: 'g.read' },
      { id: 'g2', labelKey: 'G2', icon: 'home', route: '/g/2' },
    ],
  },
  {
    id: 'h',
    labelKey: 'H',
    icon: 'home',
    route: '/h',
    children: [{ id: 'h1', labelKey: 'H1', icon: 'home', route: '/h/1', permission: 'h.read' }],
  },
];

const ids = (items: MenuItem[]) => items.map((i) => i.id);

describe('visibleMenu', () => {
  it('shows everything that needs no permission or feature when nothing is granted', () => {
    const result = visibleMenu(
      ITEMS,
      () => false,
      () => false,
    );
    expect(ids(result)).toEqual(['a', 'g']);
    expect(ids([...(result[1].children ?? [])])).toEqual(['g2']);
  });

  it('shows entries whose permission and feature are satisfied, and hides empty groups', () => {
    const can = (p: string) => p === 'b.read' || p === 'g.read';
    const result = visibleMenu(ITEMS, can, (f) => f === 'fiscal');
    expect(ids(result)).toEqual(['a', 'b', 'c', 'g']);
    expect(ids([...(result[3].children ?? [])])).toEqual(['g1', 'g2']);
  });

  it('keeps a group whose only child becomes visible and drops it otherwise', () => {
    expect(
      ids(
        visibleMenu(
          ITEMS,
          (p) => p === 'h.read',
          () => false,
        ),
      ),
    ).toEqual(['a', 'g', 'h']);
  });

  it('does not mutate the configuration', () => {
    visibleMenu(
      ITEMS,
      () => false,
      () => false,
    );
    expect(ITEMS[3].children?.length).toBe(2);
  });

  it('the menu has the entries open to every role when all permissions are held', () => {
    expect(ids(visibleMenu(MENU, allowAll, allowAll))).toEqual([
      'home',
      'profile',
      'users',
      'companies',
      'places',
      'fidelity',
      'products',
      'promotions',
      'tools',
      'trash',
      'activity-log',
    ]);
  });

  it('groups fidelity pages under one entry and the favorites under products', () => {
    const menu = visibleMenu(MENU, allowAll, allowAll);
    const children = (id: string) => ids([...(menu.find((i) => i.id === id)?.children ?? [])]);
    expect(children('fidelity')).toEqual(['card-types', 'points-collections', 'prize-catalogues']);
    expect(children('products')).toEqual(['product-favorites']);
  });

  it('shows companies with companies:read in the group area', () => {
    const only = (permission: string) => ids(visibleMenu(MENU, (p) => p === permission, allowAll));
    expect(only('companies:read')).toContain('companies');
    expect(only('users:read')).not.toContain('companies');
    expect(MENU.find((item) => item.id === 'companies')).toMatchObject({
      groupPath: 'companies',
      labelKey: 'MENU.COMPANIES',
    });
  });

  it('shows the trash with the read permission of any of companies, places and users', () => {
    const only = (permission: string) => ids(visibleMenu(MENU, (p) => p === permission, allowAll));
    expect(only('companies:read')).toContain('trash');
    expect(only('places:read')).toContain('trash');
    expect(only('users:read')).toContain('trash');
    expect(only('products:read')).not.toContain('trash');
    expect(MENU.find((item) => item.id === 'trash')).toMatchObject({
      groupPath: 'trash',
      labelKey: 'MENU.TRASH',
    });
  });

  it('shows places with places:read in the group area', () => {
    const only = (permission: string) => ids(visibleMenu(MENU, (p) => p === permission, allowAll));
    expect(only('places:read')).toContain('places');
    expect(only('companies:read')).not.toContain('places');
    expect(MENU.find((item) => item.id === 'places')).toMatchObject({
      groupPath: 'places',
      labelKey: 'MENU.PLACES',
    });
  });

  it('shows fidelity with fidelity:read, and favorites and promotions with products:read', () => {
    const only = (permission: string) => ids(visibleMenu(MENU, (p) => p === permission, allowAll));
    expect(only('fidelity:read')).toContain('fidelity');
    expect(only('fidelity:read')).not.toContain('products');
    expect(only('fidelity:read')).not.toContain('promotions');
    expect(only('products:read')).toEqual(expect.arrayContaining(['products', 'promotions']));
    expect(only('products:read')).not.toContain('fidelity');
  });

  it('shows "Strumenti › Template e-mail" in the pages of the group only when the group has the email feature and the user reads places', () => {
    const children = (
      hasFeature: (feature: string) => boolean,
      can: (p: string) => boolean = allowAll,
    ) =>
      visibleMenu(MENU, can, hasFeature, 'SA')
        .find((i) => i.id === 'tools')
        ?.children?.map((i) => i.id);
    expect(children(allowAll)).toEqual(['diagnostics', 'email-templates']);
    expect(children((feature) => feature !== 'email')).toEqual(['diagnostics']);
    expect(children(allowAll, (p) => p !== 'places:read')).toBeUndefined();
    expect(
      MENU.find((i) => i.id === 'tools')?.children?.find((i) => i.id === 'email-templates'),
    ).toMatchObject({
      route: '/groups',
      groupPath: 'email-templates',
      feature: 'email',
      permission: 'places:read',
    });
  });

  it('shows "Strumenti › Nuovo cliente" to platform administrators and dealers with groups:create', () => {
    const tools = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role).find((i) => i.id === 'tools');
    expect(ids([...(tools('PSA', 'groups:create')?.children ?? [])])).toEqual(['new-customer']);
    expect(tools('D', 'groups:create')).toBeDefined();
    expect(tools('SA', 'groups:create')).toBeUndefined();
    expect(tools('PSA', 'groups:read')).toBeUndefined();
    expect(tools('SA', 'places:read')?.children?.map((i) => i.id)).toEqual([
      'diagnostics',
      'email-templates',
    ]);
    expect(tools('CA', 'places:read')).toBeDefined();
    // The parent opens the first page the user can open.
    expect(tools('SA', 'places:read')?.route).toBe('/tools/diagnostics');
    expect(tools('PSA', 'groups:create')?.route).toBe('/tools/new-customer');
    expect(ids([...(tools('PSA', 'places:read')?.children ?? [])])).toEqual([
      'diagnostics',
      'email-templates',
    ]);
    expect(MENU.find((i) => i.id === 'tools')?.children?.[1]).toMatchObject({
      route: '/tools/diagnostics',
      labelKey: 'MENU.DIAGNOSTICS',
      permission: 'places:read',
    });
    expect(MENU.find((i) => i.id === 'tools')?.children?.[0]).toMatchObject({
      route: '/tools/new-customer',
      labelKey: 'MENU.NEW_CUSTOMER',
    });
  });

  it('shows "Strumenti › Documenti in errore" to platform administrators and dealers with errorDocuments:read', () => {
    const children = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role)
        .find((i) => i.id === 'tools')
        ?.children?.map((i) => i.id);
    expect(children('PSA', 'errorDocuments:read')).toEqual(['error-documents']);
    expect(children('D', 'errorDocuments:read')).toEqual(['error-documents']);
    for (const role of ['SA', 'CA', 'PA', 'E', undefined] as const) {
      expect(children(role, 'errorDocuments:read')).toBeUndefined();
    }
    expect(
      MENU.find((i) => i.id === 'tools')?.children?.find((i) => i.id === 'error-documents'),
    ).toMatchObject({
      route: '/tools/error-documents',
      labelKey: 'MENU.ERROR_DOCUMENTS',
      permission: 'errorDocuments:read',
      roles: ['PSA', 'D'],
    });
  });

  it('shows "Attivazioni" before "Strumenti" to platform administrators and dealers, and "Listino" under Strumenti to platform administrators only', () => {
    const top = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role).map((i) => i.id);
    const children = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role)
        .find((i) => i.id === 'tools')
        ?.children?.map((i) => i.id);
    expect(top('PSA', 'activations:read')).toEqual(['home', 'activations', 'releases']);
    expect(top('D', 'activations:read')).toEqual(['home', 'activations', 'releases']);
    for (const role of ['SA', 'CA', 'PA', 'E', undefined] as const) {
      expect(top(role, 'activations:read')).not.toContain('activations');
    }
    expect(children('PSA', 'activations:read')).toBeUndefined();
    expect(children('PSA', 'activations:manage')).toBeUndefined();
    const order = MENU.map((i) => i.id);
    expect(order.indexOf('activations')).toBe(order.indexOf('tools') - 1);
    expect(MENU.find((i) => i.id === 'activations')).toMatchObject({
      route: '/activations',
      labelKey: 'MENU.ACTIVATIONS',
      permission: 'activations:read',
      roles: ['PSA', 'D'],
    });
    const tools = MENU.find((i) => i.id === 'settings')?.children;
    expect(tools?.find((i) => i.id === 'price-list')).toMatchObject({
      route: '/settings/price-list',
      labelKey: 'MENU.PRICE_LIST',
      permission: 'activations:manage',
      roles: ['PSA'],
    });
  });

  it('shows "Strumenti › Listino Tabacchi" only to platform administrators with tobaccos:read', () => {
    const children = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role)
        .find((i) => i.id === 'tools')
        ?.children?.map((i) => i.id);
    expect(children('PSA', 'tobaccos:read')).toEqual(['tobaccos']);
    for (const role of ['D', 'SA', 'CA', 'PA', 'E', undefined] as const) {
      expect(children(role, 'tobaccos:read')).toBeUndefined();
    }
    expect(children('PSA', 'places:read')).toEqual(['diagnostics', 'email-templates']);
    expect(
      MENU.find((i) => i.id === 'tools')?.children?.find((i) => i.id === 'tobaccos'),
    ).toMatchObject({
      route: '/tools/tobaccos',
      labelKey: 'MENU.TOBACCOS',
      permission: 'tobaccos:read',
      roles: ['PSA'],
    });
  });

  it('shows "Impostazioni" right after "Strumenti", with "Listino" and "Gestione stati" for platform administrators only, linking to the first visible one', () => {
    const settings = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role).find((i) => i.id === 'settings');
    expect(settings('PSA', 'activations:manage')?.children?.map((i) => i.id)).toEqual([
      'price-list',
    ]);
    expect(settings('PSA', 'activations:manage')?.route).toBe('/settings/price-list');
    expect(settings('PSA', 'countries:manage')?.children?.map((i) => i.id)).toEqual(['countries']);
    expect(settings('PSA', 'countries:manage')?.route).toBe('/settings/countries');
    expect(settings('PSA', 'places:read')).toBeUndefined();
    for (const role of ['D', 'SA', 'CA', 'PA', 'E', undefined] as const) {
      expect(settings(role, 'countries:manage')).toBeUndefined();
      expect(settings(role, 'activations:manage')).toBeUndefined();
    }
    const order = MENU.map((i) => i.id);
    expect(order.indexOf('settings')).toBe(order.indexOf('tools') + 1);
    expect(MENU.find((i) => i.id === 'settings')).toMatchObject({
      labelKey: 'MENU.SETTINGS',
      icon: 'settings',
    });
    expect(MENU.find((i) => i.id === 'tools')?.icon).not.toBe('settings');
    expect(
      MENU.find((i) => i.id === 'settings')?.children?.find((i) => i.id === 'countries'),
    ).toMatchObject({
      route: '/settings/countries',
      labelKey: 'MENU.COUNTRIES',
      permission: 'countries:manage',
      roles: ['PSA'],
    });
  });

  it('shows "Release" after the settings and only to platform administrators and dealers', () => {
    const idsOf = (role: Role | undefined) => ids(visibleMenu(MENU, allowAll, allowAll, role));
    expect(idsOf('PSA')).toContain('releases');
    expect(idsOf('D')).toContain('releases');
    for (const role of ['SA', 'CA', 'PA', 'E', undefined] as const) {
      expect(idsOf(role)).not.toContain('releases');
    }
    const order = MENU.map((item) => item.id);
    expect(order.indexOf('releases')).toBe(order.indexOf('settings') + 1);
    expect(MENU.find((i) => i.id === 'releases')).toMatchObject({
      route: '/releases',
      labelKey: 'MENU.RELEASES',
    });
  });

  it('shows entries limited to some roles only to those roles', () => {
    const items: MenuItem[] = [
      { id: 'p', labelKey: 'P', icon: 'home', route: '/p', roles: ['PSA'] },
    ];
    expect(ids(visibleMenu(items, allowAll, allowAll, 'PSA'))).toEqual(['p']);
    expect(ids(visibleMenu(items, allowAll, allowAll, 'D'))).toEqual([]);
    expect(ids(visibleMenu(items, allowAll, allowAll))).toEqual([]);
    // One single "Utenti" entry for every role: no separate entry for the platform users.
    expect(
      ids(visibleMenu(MENU, allowAll, allowAll, 'PSA')).filter((id) => id.includes('users')),
    ).toEqual(['users']);
    expect(ids(visibleMenu(MENU, allowAll, allowAll, 'PSA'))).toContain('dealers');
    expect(ids(visibleMenu(MENU, allowAll, allowAll, 'D'))).not.toContain('dealers');
    expect(ids(visibleMenu(MENU, (p) => p !== 'dealers:read', allowAll, 'PSA'))).not.toContain(
      'dealers',
    );
  });

  it('offers the groups to PSA and dealers and the group record to the SA only, with their own labels', () => {
    const labelOf = (role: 'PSA' | 'D' | 'SA' | 'CA') =>
      Object.fromEntries(
        visibleMenu(MENU, allowAll, allowAll, role).map((i) => [i.id, i.labelKey]),
      );
    expect(labelOf('PSA')).toMatchObject({ groups: 'MENU.GROUPS' });
    expect(labelOf('D')).toMatchObject({ groups: 'MENU.GROUPS' });
    expect(labelOf('PSA')).not.toHaveProperty('group-settings');
    expect(labelOf('D')).not.toHaveProperty('group-settings');
    expect(labelOf('SA')).toMatchObject({ 'account-group': 'MENU.ACCOUNT_GROUP' });
    expect(labelOf('SA')).not.toHaveProperty('groups');
    expect(labelOf('CA')).not.toHaveProperty('account-group');
  });

  describe('entries that need a working group', () => {
    const GROUP_ONLY = ['fidelity', 'products', 'promotions'];
    const idsFor = (role: Role, hasGroup: boolean) =>
      ids(visibleMenu(MENU, allowAll, allowAll, role, hasGroup));

    it('flags exactly Fidelity, Prodotti and Promozioni', () => {
      expect(MENU.filter((i) => i.requiresGroup).map((i) => i.id)).toEqual(GROUP_ONLY);
    });

    it.each(['PSA', 'D'] as const)('hides them from %s without a working group', (role) => {
      for (const id of GROUP_ONLY) {
        expect(idsFor(role, false)).not.toContain(id);
        expect(idsFor(role, true)).toContain(id);
      }
      // The group-scoped entries that are not flagged stay as they were.
      expect(idsFor(role, false)).toEqual(expect.arrayContaining(['users', 'companies', 'trash']));
    });

    it.each(['SA', 'CA', 'PA'] as const)('shows them to %s, who always has a group', (role) => {
      for (const id of GROUP_ONLY) {
        expect(idsFor(role, true)).toContain(id);
      }
    });

    it('hides the children together with their parent', () => {
      const all = visibleMenu(MENU, allowAll, allowAll, 'PSA', false).flatMap((i) => [
        i.id,
        ...(i.children ?? []).map((c) => c.id),
      ]);
      expect(all).not.toContain('card-types');
      expect(all).not.toContain('product-favorites');
    });

    it('shows everything when the group is not specified (default)', () => {
      expect(ids(visibleMenu(MENU, allowAll, allowAll, 'PSA'))).toContain('fidelity');
    });
  });

  describe('active entry', () => {
    const GROUP = '665f1c2e9b1d4a0012ab34a2';
    const linkFor = (hasGroup: boolean) => (item: MenuItem) => {
      if (item.groupPath === undefined) {
        return item.route;
      }
      return hasGroup ? `/groups/${GROUP}/${item.groupPath}` : (item.allRoute ?? item.route);
    };
    const activeFor = (role: Role, hasGroup: boolean, url: string) => {
      const menu = visibleMenu(MENU, allowAll, allowAll, role, hasGroup);
      return [...activeMenuIds(menu, linkFor(hasGroup), url)];
    };

    it('highlights only the groups list on /groups/list without a working group', () => {
      expect(activeFor('PSA', false, '/groups/list')).toEqual(['groups']);
      expect(activeFor('D', false, '/groups/list?q=a')).toEqual(['groups']);
    });

    it('keeps the group record with the list for PSA and dealers, and with the account entry for SA', () => {
      expect(activeFor('PSA', true, `/groups/${GROUP}/settings`)).toEqual(['groups']);
      expect(activeFor('D', true, `/groups/${GROUP}/settings/taxes`)).toEqual(['groups']);
      expect(activeFor('SA', true, `/groups/${GROUP}/settings`)).toEqual(['account-group']);
    });

    it('on the chooser only the entry that sent the user there is active', () => {
      expect(activeFor('PSA', false, '/groups?to=fidelity/card-types').sort()).toEqual([]);
      expect(activeFor('D', false, '/groups?to=email-templates')).toEqual(['email-templates']);
    });

    it('without a group Aziende and Punti vendita are the cross-group lists, not the chooser', () => {
      expect(activeFor('PSA', false, '/companies')).toEqual(['companies']);
      expect(activeFor('D', false, '/places?groupId=x')).toEqual(['places']);
      expect(activeFor('PSA', false, '/groups?to=companies')).toEqual([]);
      expect(activeFor('PSA', false, '/groups?to=places')).toEqual([]);
      expect(MENU.find((i) => i.id === 'companies')).toMatchObject({ allRoute: '/companies' });
      expect(MENU.find((i) => i.id === 'places')).toMatchObject({ allRoute: '/places' });
    });

    it.each([
      ['companies', 'companies'],
      ['companies/c1', 'companies'],
      ['places/p1/devices', 'places'],
      ['users', 'users'],
      ['users/u1', 'users'],
      ['trash', 'trash'],
      ['email-templates/t1', 'email-templates'],
    ])('a page /groups/:id/%s of a group other than the working one highlights %s', (path, id) => {
      const OTHER = '665f1c2e9b1d4a0012ab34ff';
      expect(activeFor('PSA', false, `/groups/${OTHER}/${path}`)).toEqual([id]);
      expect(activeFor('PSA', true, `/groups/${OTHER}/${path}`)).toEqual([id]);
    });

    it('the record of a group (settings) of another group highlights Gruppi', () => {
      expect(activeFor('PSA', false, '/groups/665f1c2e9b1d4a0012ab34ff/settings/taxes')).toEqual([
        'groups',
      ]);
    });

    it('without a group the trash is the cross-group trash, not the chooser', () => {
      expect(activeFor('PSA', false, '/trash')).toEqual(['trash']);
      expect(activeFor('D', false, '/trash?tab=users')).toEqual(['trash']);
      expect(activeFor('PSA', false, '/groups?to=trash')).toEqual([]);
      expect(activeFor('PSA', true, '/trash')).toEqual(['trash']);
      expect(MENU.find((i) => i.id === 'trash')).toMatchObject({ allRoute: '/trash' });
    });

    it('with a group the cross-group lists still belong to Aziende and Punti vendita', () => {
      expect(activeFor('PSA', true, '/companies')).toEqual(['companies']);
      expect(activeFor('PSA', true, '/places')).toEqual(['places']);
    });

    it('on the chooser nothing is active without a valid destination', () => {
      for (const url of ['/groups', '/groups?to=evil', '/groups?to=//x', '/groups?to=']) {
        expect(activeFor('PSA', false, url)).toEqual([]);
      }
      expect(activeFor('PSA', false, `/groups/${GROUP}/companies`)).toEqual(['companies']);
    });

    it('accepts as destination only the page paths of the menu', () => {
      expect([...GROUP_TARGETS]).toEqual(
        expect.arrayContaining(['users', 'companies', 'places', 'trash', 'promotions']),
      );
      expect(chooserTarget('/groups?to=companies')).toBe('companies');
      expect(chooserTarget('/groups/?to=places#x')).toBe('places');
      for (const url of [
        '/groups',
        '/groups?to=evil',
        '/groups?to=companies/..',
        '/groups?to=%2F%2Fevil',
        '/groups?to=x&to=companies',
        '/groups/list?to=companies',
        '/users?to=companies',
        '/?to=companies',
      ]) {
        expect(chooserTarget(url), url).toBeNull();
      }
    });

    it.each([
      ['companies', 'companies'],
      ['places', 'places'],
      ['places/abc', 'places'],
      ['users', 'users'],
      ['trash', 'trash'],
      ['promotions', 'promotions'],
      ['fidelity/points-collections', 'points-collections'],
      ['email-templates', 'email-templates'],
    ])('with a group, /groups/:id/%s highlights only %s', (path, id) => {
      expect(activeFor('PSA', true, `/groups/${GROUP}/${path}`)).toEqual([id]);
    });

    it('never makes a parent the current page, even when it shares the link of its first child', () => {
      expect(activeFor('PSA', true, `/groups/${GROUP}/product-favorites`)).toEqual([
        'product-favorites',
      ]);
      expect(activeFor('PSA', true, `/groups/${GROUP}/fidelity/card-types`)).toEqual([
        'card-types',
      ]);
      expect(activeFor('PSA', true, `/groups/${GROUP}/fidelity/prize-catalogues`)).toEqual([
        'prize-catalogues',
      ]);
    });

    it('marks the parent the same way for every one of its children', () => {
      for (const role of ['PSA', 'D', 'SA', 'CA', 'PA'] as const) {
        for (const hasGroup of [false, true]) {
          const menu = visibleMenu(MENU, allowAll, allowAll, role, hasGroup);
          const link = linkFor(hasGroup);
          for (const parent of menu.filter((item) => item.children !== undefined)) {
            for (const child of parent.children!) {
              const active = activeMenuIds(menu, link, `${link(child)}/x`);
              const parents = activeParentIds(menu, active);
              const label = `${role} ${hasGroup} ${parent.id} > ${child.id}`;
              // Skip children that cannot be told apart from a sibling sharing their link.
              if (active.has(child.id)) {
                expect([...parents], label).toEqual([parent.id]);
                expect(active.has(parent.id), label).toBe(false);
              }
            }
          }
        }
      }
    });

    it('marks no parent when nothing inside it is current', () => {
      const menu = visibleMenu(MENU, allowAll, allowAll, 'PSA', true);
      const active = activeMenuIds(menu, linkFor(true), '/profile');
      expect([...activeParentIds(menu, active)]).toEqual([]);
    });

    it('matches whole segments, the home link only on the home page, and tolerates the fragment', () => {
      expect(activeFor('PSA', false, '/')).toEqual(['home']);
      expect(activeFor('PSA', false, '/profile#top')).toEqual(['profile']);
      expect(activeFor('PSA', false, '/profiles')).toEqual([]);
      expect(activeFor('PSA', false, '/unknown')).toEqual([]);
    });

    it('never highlights two leaf entries together, on any page of the menu', () => {
      const roles: Role[] = ['PSA', 'D', 'SA', 'CA', 'PA', 'E'];
      const known = [
        '/groups',
        '/groups/list',
        `/groups/${GROUP}/settings`,
        `/groups/${GROUP}/settings/features`,
        '/users/new',
        '/platform/users/new',
        '/activations/abc',
      ];
      for (const role of roles) {
        for (const hasGroup of [false, true]) {
          const menu = visibleMenu(MENU, allowAll, allowAll, role, hasGroup);
          const link = linkFor(hasGroup);
          const flat = menu.flatMap((item) => [item, ...(item.children ?? [])]);
          const urls = [...known, ...flat.flatMap((item) => [link(item), `${link(item)}/x/y`])];
          for (const url of urls) {
            const active = activeMenuIds(menu, link, url);
            const leaves = flat.filter(
              (item) => item.children === undefined && active.has(item.id),
            );
            const links = new Set(leaves.map((item) => link(item)));
            expect(links.size, `${role} ${hasGroup} ${url}`).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  });
});
