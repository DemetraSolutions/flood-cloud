import { DestroyRef, effect, inject, signal, Signal, untracked } from '@angular/core';
import { ApiPage } from '../../../core/api/api.types';
import { ApiError } from '../../../core/api/api-error';
import { LookupKind, ReferenceApi, ReferenceItem } from '../../../core/reference/reference-api';
import { ReferenceLoader } from '../../users/reference-picker';

/** Loader of a compact read of the group (products, categories, customers, contact groups). */
export function lookupLoader(
  reference: ReferenceApi,
  groupId: string,
  kind: LookupKind,
): ReferenceLoader {
  return (query) => reference.lookup(groupId, kind, query);
}

/** Loader of the stores of the group (limited by the server to the perimeter of the user). */
export function placesLoader(reference: ReferenceApi, groupId: string): ReferenceLoader {
  return (query) => reference.places(groupId, query);
}

/**
 * Loader over a list already in memory (a catalog read whole): one page, filtered by the search
 * text without distinguishing case.
 */
export function staticLoader(items: readonly ReferenceItem[]): ReferenceLoader {
  return async ({ q }): Promise<ApiPage<ReferenceItem>> => {
    const text = q.trim().toLowerCase();
    const data = items.filter((item) => item.name.toLowerCase().includes(text));
    return { data, page: { limit: Math.max(data.length, 1), next: null } };
  };
}

/**
 * Names of the elements a selector starts with (the ones saved in the element being edited),
 * for the list of the chosen ones. Call in an injection context. When the names cannot be read
 * the elements stay selected and only a warning with the error code is logged (never the ids or
 * the URL): the names just decorate the selection.
 *
 * @param ids The ids to resolve (read reactively; resolved again when they change).
 * @param resolve Reads the names of some ids.
 * @returns The names found, by id.
 */
export function selectionNames(
  ids: () => readonly string[],
  resolve: (ids: readonly string[]) => Promise<Record<string, string>>,
): Signal<Readonly<Record<string, string>>> {
  const names = signal<Readonly<Record<string, string>>>({});
  const destroyed = inject(DestroyRef);
  let alive = true;
  destroyed.onDestroy(() => (alive = false));
  effect(() => {
    const wanted = ids();
    if (wanted.length > 0) {
      untracked(() => {
        resolve(wanted).then(
          (found) => {
            if (alive) {
              names.update((current) => ({ ...current, ...found }));
            }
          },
          // Only the code: the error would carry the URL, with the ids of customers or products.
          (error: unknown) =>
            console.warn(
              'Cannot read the names of the selection',
              error instanceof ApiError ? error.code : 'unexpected',
            ),
        );
      });
    }
  });
  return names.asReadonly();
}
