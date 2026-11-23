/** Most categories a group may have (a creation beyond it is refused, and a group that has more by the legacy has no tree, no depth and no hierarchy change from here). */
export const MAX_CATEGORIES = 2000;

/** Most levels of the tree of categories: a root is on level 1, so the deepest `depth` (which starts at 0) is one less. */
export const MAX_LEVELS = 10;

/** A category as the tree sees it. */
export interface TreeNode {
  /** Id, hexadecimal. */
  readonly id: string;
  /** The stored parent, hexadecimal; `null` for a root, and for a `parentId` that is not an `ObjectId`. */
  readonly parent: string | null;
}

/** The shape of the tree of a group, with the anomalies of the legacy (a parent that does not exist, a cycle) already resolved. */
export interface TreeShape {
  /** The parent each category is read with: the stored one, `null` for a root, for a parent that does not exist and for the category that closes a cycle. */
  readonly parentOf: ReadonlyMap<string, string | null>;
  /** The categories that close a cycle of the stored parents: in a cycle the one with the smallest id, which is read as a root. */
  readonly cyclic: ReadonlySet<string>;
  /** Level below the roots: 0 for a root. */
  readonly depthOf: ReadonlyMap<string, number>;
  /** Levels below a category: 0 for a category with no subcategory. */
  readonly heightOf: ReadonlyMap<string, number>;
  /** The categories read with a category as their parent, in id order. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
}

/**
 * Works out the shape of the tree of a group from the stored parent of each category. The legacy never checked the parents, so the tree is read tolerantly: a parent that does not exist
 * makes a root; of the categories that form a cycle (a category that is its own ancestor, or its own parent) the one with the smallest id is read as a root, which breaks the cycle in
 * the same place for every reader. Nothing is ever repaired in the database.
 *
 * @param nodes The categories of the group (every one, whoever the caller is).
 * @returns The effective parent, depth and height of each, the categories that close a cycle, and the children of each.
 */
export function shapeOf(nodes: readonly TreeNode[]): TreeShape {
  const stored = new Map(nodes.map((node) => [node.id, node.parent] as const));
  // Walk up from each category: 1 while it is on the path being walked, 2 once its whole chain is known.
  const state = new Map<string, 1 | 2>();
  const cyclic = new Set<string>();
  for (const start of [...stored.keys()].sort()) {
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && stored.has(current) && state.get(current) === undefined) {
      state.set(current, 1);
      path.push(current);
      current = stored.get(current) ?? null;
    }
    if (current !== null && state.get(current) === 1) {
      const members = path.slice(path.indexOf(current));
      cyclic.add(members.reduce((smallest, member) => (member < smallest ? member : smallest)));
    }
    for (const id of path) {
      state.set(id, 2);
    }
  }
  const parentOf = new Map<string, string | null>();
  for (const [id, parent] of stored) {
    parentOf.set(id, parent !== null && stored.has(parent) && !cyclic.has(id) ? parent : null);
  }
  const children = new Map<string, string[]>();
  for (const id of [...parentOf.keys()].sort()) {
    const parent = parentOf.get(id) ?? null;
    if (parent !== null) {
      children.set(parent, [...(children.get(parent) ?? []), id]);
    }
  }
  const depthOf = new Map<string, number>();
  const order: string[] = [];
  let level = [...parentOf.entries()].filter(([, parent]) => parent === null).map(([id]) => id).sort();
  for (let depth = 0; level.length > 0; depth += 1) {
    for (const id of level) {
      depthOf.set(id, depth);
      order.push(id);
    }
    level = level.flatMap((id) => children.get(id) ?? []);
  }
  const heightOf = new Map<string, number>(order.map((id) => [id, 0]));
  for (const id of [...order].reverse()) {
    const parent = parentOf.get(id) ?? null;
    if (parent !== null) {
      heightOf.set(parent, Math.max(heightOf.get(parent)!, heightOf.get(id)! + 1));
    }
  }
  return { parentOf, cyclic, depthOf, heightOf, childrenOf: children };
}

/**
 * Whether a category is on a cycle of the stored parents, followed from the stored parent of each category: what a concurrent write that made a category the descendant of its own descendant leaves.
 *
 * @param nodes The categories of the group.
 * @param id The category to follow up from.
 */
export function onCycle(nodes: readonly TreeNode[], id: string): boolean {
  const parents = new Map(nodes.map((node) => [node.id, node.parent] as const));
  const seen = new Set<string>();
  let current = parents.get(id) ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === id) {
      return true;
    }
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

/**
 * Whether a category is a descendant of another (or the same one), following the parents it is read with.
 *
 * @param shape The shape of the tree.
 * @param id The category.
 * @param ancestor The category that may be above it.
 */
export function isWithin(shape: TreeShape, id: string, ancestor: string): boolean {
  for (let current: string | null = id; current !== null; current = shape.parentOf.get(current) ?? null) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}
