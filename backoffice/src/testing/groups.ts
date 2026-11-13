import { FEATURE_NAMES, FeatureFlags } from '../app/core/groups/feature-catalog';
import {
  Group,
  GroupListItem,
  INTEGRATION_PROVIDERS,
  Integration,
  IntegrationProvider,
} from '../app/features/groups/group.types';

/** All the features of the catalog, every one set to `value`. */
export function fakeFeatureFlags(
  value = false,
  overrides: Partial<FeatureFlags> = {},
): FeatureFlags {
  const flags = Object.fromEntries(FEATURE_NAMES.map((name) => [name, value])) as {
    -readonly [K in keyof FeatureFlags]: boolean;
  };
  return { ...flags, ...overrides };
}

/** The seven integrations, all off and without a key. */
export function fakeIntegrations(
  overrides: Partial<Record<IntegrationProvider, Integration>> = {},
): Record<IntegrationProvider, Integration> {
  const all = Object.fromEntries(
    INTEGRATION_PROVIDERS.map((provider) => [provider, { enabled: false, apiKeySet: false }]),
  ) as Record<IntegrationProvider, Integration>;
  return { ...all, ...overrides };
}

/** A complete group for tests; override what the test cares about. */
export function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: '665f1c2e9b1d4a0012ab34a1',
    name: 'Gruppo Esempio',
    description: 'Descrizione di esempio',
    dealerId: null,
    status: 'active',
    trashed: false,
    demo: false,
    features: fakeFeatureFlags(false, { cash: true }),
    languages: ['it', 'en'],
    statsSettings: {
      openingTime: '06:00',
      compressProductsCategories: false,
      timeSlots: [{ from: '06:00', to: '12:00' }],
    },
    integrations: fakeIntegrations(),
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
    ...overrides,
  };
}

/** A group row of the list for tests. */
export function fakeGroupListItem(overrides: Partial<GroupListItem> = {}): GroupListItem {
  return {
    id: '665f1c2e9b1d4a0012ab34a1',
    name: 'Gruppo Esempio',
    status: 'active',
    trashed: false,
    dealerId: null,
    demo: false,
    counts: {
      companies: { active: 0, trashed: 0 },
      places: { active: 0, trashed: 0 },
      users: { active: 0, trashed: 0 },
    },
    ...overrides,
  };
}
