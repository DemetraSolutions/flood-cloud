/**
 * Read-only view of a set: membership, size and iteration, nothing that can modify it. It is the
 * type of every set of security data (permissions, visible group ids).
 */
export interface ReadOnlySet<T> extends Iterable<T> {
  readonly size: number;
  has(value: T): boolean;
  values(): IterableIterator<T>;
}

/** Holds its members in a private field: the only way in is the constructor, the only ways out are the read methods. */
class FrozenSet<T> implements ReadOnlySet<T> {
  readonly #set: Set<T>;

  constructor(items: Iterable<T>) {
    this.#set = new Set(items);
  }

  get size(): number {
    return this.#set.size;
  }

  has(value: T): boolean {
    return this.#set.has(value);
  }

  values(): IterableIterator<T> {
    return this.#set.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#set.values();
  }
}

/**
 * Builds a set that cannot be modified after creation: the object exposes only `has`, `size` and
 * iteration, so there is no `add`, `delete` or `clear` to call.
 *
 * @param items Members of the set.
 * @returns A read-only view; the input is copied.
 */
export function frozenSet<T>(items: Iterable<T> = []): ReadOnlySet<T> {
  return Object.freeze(new FrozenSet(items));
}

/**
 * Copies an array into a frozen one.
 *
 * @param items Elements to copy.
 * @returns A frozen array.
 */
export function frozenArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}
