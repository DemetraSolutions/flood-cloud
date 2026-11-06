import { isDeepStrictEqual } from 'node:util';
import type { Feature } from './features.ts';
import type { Group, GroupChanges, Provider } from './group.types.ts';
import type { PatchGroupBody } from './groups.schemas.ts';

/** The fields of the modification body, in the order they are reported. */
export const PATCH_FIELDS = Object.freeze(['name', 'description', 'languages', 'statsSettings', 'features', 'integrations', 'demo'] as const);

/** A field of the modification body. */
export type PatchField = (typeof PATCH_FIELDS)[number];

/**
 * The fields of the modification each role may send (D-13): name, description, languages and statistics settings are for the PSA,
 * the dealer and the group administrator; features and integrations for the PSA and the dealer; `demo` for the PSA only.
 * `status` and `trash` are not here at all: they have their own actions. A role that is not listed may send nothing.
 */
export const EDITABLE_FIELDS: Readonly<Record<string, readonly PatchField[]>> = Object.freeze({
  PSA: PATCH_FIELDS,
  D: PATCH_FIELDS.filter((field) => field !== 'demo'),
  SA: PATCH_FIELDS.filter((field) => field !== 'demo' && field !== 'features' && field !== 'integrations'),
});

/**
 * The fields of a request a role may not send.
 *
 * @param role Role of the caller.
 * @param patch The validated body.
 * @returns The names of the refused fields, in a stable order; empty when the request is allowed.
 */
export function forbiddenFields(role: string, patch: PatchGroupBody): PatchField[] {
  const allowed = EDITABLE_FIELDS[role] ?? [];
  return PATCH_FIELDS.filter((field) => patch[field] !== undefined && !allowed.includes(field));
}

/**
 * What a request really changes: the fields whose new value differs from the stored one. A request that
 * repeats the current values gives an empty result, so nothing is written and nothing is logged.
 *
 * @param before The group as it is.
 * @param patch The validated body.
 * @returns The differences, in the shape the legacy update is built from.
 */
export function changesOf(before: Group, patch: PatchGroupBody): GroupChanges {
  const features = (Object.entries(patch.features ?? {}) as Array<[Feature, boolean]>).filter(([feature, on]) => before.features[feature] !== on);
  const integrations = (Object.entries(patch.integrations ?? {}) as Array<[Provider, { enabled?: boolean; apiKey?: string | null }]>).flatMap(([provider, state]) => {
    const stored = before.integrations[provider];
    // The key is never read, so a new one is always a change; removing one is a change only if there is one.
    const apiKey = state.apiKey !== undefined && (state.apiKey !== null || stored.apiKeySet) ? { apiKey: state.apiKey } : {};
    const enabled = state.enabled !== undefined && state.enabled !== stored.enabled ? { enabled: state.enabled } : {};
    return Object.keys({ ...apiKey, ...enabled }).length === 0 ? [] : [[provider, { ...enabled, ...apiKey }] as const];
  });
  const stats = patch.statsSettings;
  const statsChanges = {
    ...(stats?.openingTime !== undefined && stats.openingTime !== before.statsSettings.openingTime ? { openingTime: stats.openingTime } : {}),
    ...(stats?.compressProductsCategories !== undefined && stats.compressProductsCategories !== before.statsSettings.compressProductsCategories
      ? { compressProductsCategories: stats.compressProductsCategories }
      : {}),
    ...(stats?.timeSlots !== undefined && !isDeepStrictEqual(stats.timeSlots, before.statsSettings.timeSlots) ? { timeSlots: stats.timeSlots } : {}),
  };
  return {
    ...(patch.name !== undefined && patch.name !== before.name ? { name: patch.name } : {}),
    ...(patch.description !== undefined && patch.description !== before.description ? { description: patch.description } : {}),
    ...(patch.languages !== undefined && !isDeepStrictEqual(patch.languages, before.languages) ? { languages: patch.languages } : {}),
    ...(Object.keys(statsChanges).length > 0 ? { statsSettings: statsChanges } : {}),
    ...(features.length > 0 ? { features: Object.fromEntries(features) } : {}),
    ...(integrations.length > 0 ? { integrations: Object.fromEntries(integrations) } : {}),
    ...(patch.demo !== undefined && patch.demo !== before.demo ? { demo: patch.demo } : {}),
  };
}
