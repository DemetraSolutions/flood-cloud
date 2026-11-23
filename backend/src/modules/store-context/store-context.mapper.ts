import { PROVIDERS } from '../groups/group.types.ts';
import { toResponse } from '../users/user.mapper.ts';
import type { StoreUserRecord } from '../users/users.repository.ts';
import type { GroupResponse, Provider } from '../groups/group.types.ts';
import type { ExtraGroupCatalogs, GroupCredentials, StoreGroup, StoreIntegrationState, StoreUser } from './store-context.types.ts';

/** The stored paths of the credentials of a group: the legacy key and the key of every provider (and the capitalized variant of `easyappear` the legacy has on some groups). */
export const GROUP_CREDENTIAL_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  apiKey: 1,
  ...Object.fromEntries(PROVIDERS.map((provider) => [`settings.integrations.${provider}.apiKey`, 1 as const])),
  'settings.integrations.easyAppear.apiKey': 1,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored key: a non-empty text; anything else (absent, empty, a number, an object) is `null`. */
const keyOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Reads the credentials of a stored group document (projected with {@link GROUP_CREDENTIAL_PROJECTION}), tolerantly: a container that is not an object, a key that is not a text and a
 * provider the backend does not know are `null` or left out, never an error. The key of `easyappear` is read from the capitalized variant when the right one is missing, as the group detail does.
 *
 * @param document The projected document.
 */
export function toGroupCredentials(document: Readonly<Record<string, unknown>>): GroupCredentials {
  const settings = document['settings'];
  const stored = isRecord(settings) && isRecord(settings['integrations']) ? settings['integrations'] : {};
  const keys = Object.fromEntries(
    PROVIDERS.map((provider) => {
      const variant = provider === 'easyappear' && (stored[provider] === undefined || stored[provider] === null) ? stored['easyAppear'] : stored[provider];
      return [provider, isRecord(variant) ? keyOrNull(variant['apiKey']) : null];
    }),
  ) as Record<Provider, string | null>;
  return { legacyApiKey: keyOrNull(document['apiKey']), integrationKeys: keys };
}

/**
 * Builds the representation of the group for the server of a store: an explicit allowlist, field by field. Whatever the detail of the backoffice has as `apiKeySet` is here the key itself;
 * the reference to the dealer, the public API settings and the cluster are not part of it, and nothing of the stored document that is not modelled can get in.
 *
 * @param group The group as the backoffice detail shows it to a role that is neither the PSA nor a dealer.
 * @param credentials The credentials read from the stored document.
 * @param catalogs The catalogs the detail does not carry.
 */
export function toStoreGroup(group: GroupResponse, credentials: GroupCredentials, catalogs: ExtraGroupCatalogs): StoreGroup {
  const integrations = Object.fromEntries(
    PROVIDERS.map((provider): [Provider, StoreIntegrationState] => [provider, { enabled: group.integrations[provider].enabled, apiKey: credentials.integrationKeys[provider] }]),
  ) as Record<Provider, StoreIntegrationState>;
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    status: group.status,
    trashed: group.trashed,
    trashedAt: group.trashedAt,
    demo: group.demo,
    features: group.features,
    languages: group.languages,
    statsSettings: group.statsSettings,
    integrations,
    legacyApiKey: credentials.legacyApiKey,
    priceLists: group.priceLists,
    taxes: group.taxes,
    currencies: group.currencies,
    measureUnits: group.measureUnits,
    warehouseRules: group.warehouseRules,
    fidelityCardRules: group.fidelityCardRules,
    cardTypes: catalogs.cardTypes,
    pointsCollections: catalogs.pointsCollections,
    prizeCatalogues: catalogs.prizeCatalogues,
    productFavorites: catalogs.productFavorites,
    promotions: catalogs.promotions,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

/**
 * Builds the representation of a user for the server of a store, field by field (an allowlist: a field later added to the backoffice user is not here until someone decides it should be):
 * the one of the backoffice (`toResponse`, which has no password, hash, token or credential state) without the reference to the dealer, without the picture (`hasAvatar` stays) and with the
 * stored PIN in clear instead of `pinSet`.
 *
 * @param record The user as read for the store, with his PIN.
 */
export function toStoreUser(record: StoreUserRecord): StoreUser {
  const user = toResponse(record.mapped.user);
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    groupId: user.groupId,
    companyIds: user.companyIds,
    placeIds: user.placeIds,
    status: user.status,
    trashed: user.trashed,
    trashedAt: user.trashedAt,
    language: user.language,
    theme: user.theme,
    hiddenInStats: user.hiddenInStats,
    description: user.description,
    hasAvatar: user.hasAvatar,
    pin: record.pin,
    serviceIds: user.serviceIds,
    permissions: user.permissions,
    pos: user.pos,
    shiftTime: user.shiftTime,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
