import {
  CategoryNode,
  QUICK_COLORS,
  categoryRoute,
  flatten,
  hasHiddenParent,
  isCategoryEditable,
  nodeName,
  selfAndDescendants,
} from './category.types';

const node = (id: string, children: CategoryNode[] = [], name: string | null = id): CategoryNode => ({
  id,
  name,
  parentId: null,
  position: null,
  enabled: true,
  children,
});

const TREE = [node('a', [node('b', [node('c')]), node('d')]), node('e')];

describe('category types', () => {
  it('flattens the tree in reading order with the level', () => {
    expect(flatten(TREE).map((entry) => [entry.node.id, entry.level])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 1],
      ['e', 0],
    ]);
    expect(flatten([])).toEqual([]);
  });

  it('finds a category and everything below it', () => {
    expect([...selfAndDescendants(TREE, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...selfAndDescendants(TREE, 'b')].sort()).toEqual(['b', 'c']);
    expect([...selfAndDescendants(TREE, 'e')]).toEqual(['e']);
  });

  it('knows only the id of a category that is not in the tree', () => {
    expect([...selfAndDescendants(TREE, 'zzz')]).toEqual(['zzz']);
  });

  it('names a node, with the empty text for none', () => {
    expect(nodeName(node('a', [], 'Pizze'), 'vuoto')).toBe('Pizze');
    expect(nodeName(node('a', [], null), 'vuoto')).toBe('vuoto');
    expect(nodeName(node('a', [], ''), 'vuoto')).toBe('vuoto');
  });

  it('is editable unless the server says otherwise', () => {
    expect(isCategoryEditable({})).toBe(true);
    expect(isCategoryEditable({ editable: true })).toBe(true);
    expect(isCategoryEditable({ editable: false })).toBe(false);
  });

  it('has a hidden parent only when the server says so', () => {
    expect(hasHiddenParent({})).toBe(false);
    expect(hasHiddenParent({ parentHidden: false })).toBe(false);
    expect(hasHiddenParent({ parentHidden: true })).toBe(true);
  });

  it('builds the router links', () => {
    expect(categoryRoute('g')).toEqual(['/groups', 'g', 'product-categories']);
    expect(categoryRoute('g', null)).toEqual(['/groups', 'g', 'product-categories', 'new']);
    expect(categoryRoute('g', 'c1')).toEqual(['/groups', 'g', 'product-categories', 'c1']);
  });

  it('has twelve unique lowercase hexadecimal quick colors', () => {
    expect(QUICK_COLORS).toHaveLength(12);
    expect(new Set(QUICK_COLORS).size).toBe(12);
    for (const color of QUICK_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
