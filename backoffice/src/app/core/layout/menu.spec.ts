import { Role } from '../session/session.types';
import { MENU, MenuItem, visibleMenu } from './menu';

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

  it('shows "Strumenti › Nuovo cliente" to platform administrators and dealers with groups:create', () => {
    const tools = (role: Role | undefined, permission: string) =>
      visibleMenu(MENU, (p) => p === permission, allowAll, role).find((i) => i.id === 'tools');
    expect(ids([...(tools('PSA', 'groups:create')?.children ?? [])])).toEqual(['new-customer']);
    expect(tools('D', 'groups:create')).toBeDefined();
    expect(tools('SA', 'groups:create')).toBeUndefined();
    expect(tools('PSA', 'groups:read')).toBeUndefined();
    expect(MENU.find((i) => i.id === 'tools')?.children?.[0]).toMatchObject({
      route: '/tools/new-customer',
      labelKey: 'MENU.NEW_CUSTOMER',
    });
  });

  it('shows "Release" after the tools and only to platform administrators and dealers', () => {
    const idsOf = (role: Role | undefined) => ids(visibleMenu(MENU, allowAll, allowAll, role));
    expect(idsOf('PSA')).toContain('releases');
    expect(idsOf('D')).toContain('releases');
    for (const role of ['SA', 'CA', 'PA', 'E', undefined] as const) {
      expect(idsOf(role)).not.toContain('releases');
    }
    const order = MENU.map((item) => item.id);
    expect(order.indexOf('releases')).toBe(order.indexOf('tools') + 1);
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

  it('offers the groups to PSA and dealers and the group record to PSA, dealers and SA, with their own labels', () => {
    const labelOf = (role: 'PSA' | 'D' | 'SA' | 'CA') =>
      Object.fromEntries(
        visibleMenu(MENU, allowAll, allowAll, role).map((i) => [i.id, i.labelKey]),
      );
    expect(labelOf('PSA')).toMatchObject({
      groups: 'MENU.GROUPS',
      'group-settings': 'MENU.GROUP_SETTINGS',
    });
    expect(labelOf('D')).toMatchObject({
      groups: 'MENU.GROUPS',
      'group-settings': 'MENU.GROUP_SETTINGS',
    });
    expect(labelOf('SA')).toMatchObject({ 'account-group': 'MENU.ACCOUNT_GROUP' });
    expect(labelOf('SA')).not.toHaveProperty('groups');
    expect(labelOf('CA')).not.toHaveProperty('account-group');
    expect(labelOf('CA')).not.toHaveProperty('group-settings');
  });
});
