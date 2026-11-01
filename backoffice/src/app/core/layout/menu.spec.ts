import { allowAll, MENU, MenuItem, visibleMenu } from './menu';

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

  it('allowAll allows anything and the initial menu has the home entry', () => {
    expect(allowAll('x')).toBe(true);
    expect(ids(visibleMenu(MENU, allowAll, allowAll))).toEqual(['home']);
  });
});
