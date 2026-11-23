import type { Provider, GroupResponse } from '../groups/group.types.ts';
import type { CardType } from '../groups/catalogs/card-types.ts';
import type { PointsCollection } from '../groups/catalogs/points-collections.ts';
import type { PrizeCatalogue } from '../groups/catalogs/prize-catalogues.ts';
import type { ProductFavorite } from '../groups/catalogs/product-favorites.ts';
import type { Promotion } from '../groups/catalogs/promotions.ts';

/** The credentials of a group that live in its document and that the backoffice never receives: the keys of its integrations and the legacy group key. */
export interface GroupCredentials {
  /** The legacy key of the group (`apiKey` of the stored document), `null` when absent or not a text. */
  readonly legacyApiKey: string | null;
  /** The key of every integration, `null` when absent, empty or not a text. */
  readonly integrationKeys: Readonly<Record<Provider, string | null>>;
}

/** The catalogs of the group document that the group detail of the backoffice does not carry (they are sub-resources there), by the names of those sub-resources. */
export interface ExtraGroupCatalogs {
  readonly cardTypes: readonly CardType[];
  readonly pointsCollections: readonly PointsCollection[];
  readonly prizeCatalogues: readonly PrizeCatalogue[];
  readonly productFavorites: readonly ProductFavorite[];
  readonly promotions: readonly Promotion[];
}

/** An integration of the group as the server of a store reads it: its switch and its key in clear (`null` when it has none). */
export interface StoreIntegrationState {
  readonly enabled: boolean;
  readonly apiKey: string | null;
}

/**
 * The group as the server of a store reads it (`GET /v1/store-context/group`): the representation of the backoffice detail without the reference to the dealer, the public API settings
 * and the cluster, with the keys of the integrations in clear, the temporary legacy key and the catalogs the detail leaves to its sub-resources.
 */
export interface StoreGroup
  extends Omit<GroupResponse, 'dealerId' | 'integrations' | 'publicApi' | 'dataCluster'>,
    ExtraGroupCatalogs {
  readonly integrations: Readonly<Record<Provider, StoreIntegrationState>>;
  /** The legacy group key, still needed to call the old services; it will be removed when those calls are migrated. */
  readonly legacyApiKey: string | null;
}
