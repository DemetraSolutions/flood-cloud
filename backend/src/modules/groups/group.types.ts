import type { ObjectId } from 'mongodb';
import type { Currency } from './catalogs/currencies.ts';
import type { FidelityCardRule } from './catalogs/fidelity-card-rules.ts';
import type { MeasureUnit } from './catalogs/measure-units.ts';
import type { PriceList } from './catalogs/price-lists.ts';
import type { Tax } from './catalogs/taxes.ts';
import type { WarehouseRule } from './catalogs/warehouse-rules.ts';
import type { FeatureFlags } from './features.ts';

/** The integration providers a group can switch on. A provider found in a document and not in this list is kept in the database and never shown. */
export const PROVIDERS = Object.freeze(['easyappear', 'yellgo', 'leggimenu', 'plateform', 'cooperto', 'qodeup', 'statmanager'] as const);

/** An integration provider of a group. */
export type Provider = (typeof PROVIDERS)[number];

/** The state of one integration: whether it is on and whether a key is set. The key itself is set-only: it is never read into the model. */
export interface IntegrationState {
  readonly enabled: boolean;
  readonly apiKeySet: boolean;
}

/** The catalogs of the group form (price lists, taxes, currencies, measure units, warehouse rules and loyalty rules), as the detail shows them. */
export interface GroupCatalogs {
  readonly priceLists: readonly PriceList[];
  readonly taxes: readonly Tax[];
  readonly currencies: readonly Currency[];
  readonly measureUnits: readonly MeasureUnit[];
  readonly warehouseRules: readonly WarehouseRule[];
  readonly fidelityCardRules: readonly FidelityCardRule[];
}

/** The integrations of a group, every provider present. */
export type IntegrationFlags = Readonly<Record<Provider, IntegrationState>>;

/** A time slot of the statistics, whole hours from `00:00` to `24:00`. */
export interface StatsTimeSlot {
  /** Start, `HH:00`, from `00:00` to `23:00`. */
  readonly from: string;
  /** End, `HH:00`, from `01:00` to `24:00`. */
  readonly to: string;
}

/** The settings of the statistics of a group. */
export interface StatsSettings {
  /** Opening time of the business day, `HH:mm`, or `null` when not set. */
  readonly openingTime: string | null;
  /** Whether the statistics group products into their categories. */
  readonly compressProductsCategories: boolean;
  readonly timeSlots: readonly StatsTimeSlot[];
}

/** Whether a group is in service: a suspended group is refused to everybody but the PSA. */
export type GroupStatus = 'active' | 'suspended';

/** A group (a client of the platform) as the domain sees it, translated from the legacy document. */
export interface Group {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Id of the dealer's `D` user, `null` when the group has no dealer. */
  readonly dealerId: string | null;
  readonly status: GroupStatus;
  readonly trashed: boolean;
  readonly demo: boolean;
  readonly features: FeatureFlags;
  /** ISO 639-1 codes. */
  readonly languages: readonly string[];
  readonly statsSettings: StatsSettings;
  readonly integrations: IntegrationFlags;
  readonly catalogs: GroupCatalogs;
  /** The cluster that holds the data of the group (only its id); `null` means the default cluster. */
  readonly dataCluster: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

/** What `/v1/groups/{groupId}` returns. `dataCluster` is present only for a PSA. */
export interface GroupResponse extends GroupCatalogs {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly dealerId: string | null;
  readonly status: GroupStatus;
  readonly trashed: boolean;
  readonly demo: boolean;
  readonly features: FeatureFlags;
  readonly languages: readonly string[];
  readonly statsSettings: StatsSettings;
  readonly integrations: IntegrationFlags;
  readonly dataCluster?: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** What is wrong with a legacy group document, found while reading it (the read itself never fails). */
export type GroupAnomalyKind = 'invalidType' | 'invalidReference' | 'invalidLanguage' | 'invalidTimeSlot' | 'invalidTime' | 'invalidElement' | 'invalidValue' | 'overLimit';

/** One anomaly of a legacy group document. */
export interface GroupAnomaly {
  readonly kind: GroupAnomalyKind;
  /** Legacy field concerned. */
  readonly field: string;
}

/** A group with the problems of its stored document, to be logged by the caller. */
export interface MappedGroup {
  readonly group: Group;
  readonly anomalies: readonly GroupAnomaly[];
}

/**
 * A document of `<env>_common.groups` as the legacy platform writes it. Every field except `_id` is optional
 * and of unknown type because production data is irregular. Only the fields the domain maps are listed; the
 * others (`apiKey`, `databaseHost`, `filesHost`, `type`, `plan`, `expirationDate`, `places`, the data of the loyalty and
 * product catalogs…) are in the documents and are never read. The catalogs of the group form are read by their own
 * mappers; `apiKeySet` is computed by the database (whether each integration key is set), so no key is ever loaded.
 */
export type LegacyGroupDocument = {
  readonly _id: ObjectId;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly dealerId?: unknown;
  readonly status?: unknown;
  readonly trash?: unknown;
  readonly demo?: unknown;
  readonly settings?: unknown;
  readonly apiKeySet?: unknown;
  readonly priceLists?: unknown;
  readonly taxes?: unknown;
  readonly currencies?: unknown;
  readonly measureUnits?: unknown;
  readonly warehouseRules?: unknown;
  readonly fidelityCardRules?: unknown;
  readonly dataCluster?: unknown;
  readonly insertDate?: unknown;
  readonly updateDate?: unknown;
};

/** The changes of a group the backend can write; an absent field is left alone. */
export interface GroupChanges {
  readonly name?: string;
  readonly description?: string | null;
  readonly features?: Readonly<Partial<Record<keyof FeatureFlags, boolean>>>;
  /** `enabled` to turn the integration on or off; `apiKey` to set its key (`null` removes it). The key is never read back. */
  readonly integrations?: Readonly<Partial<Record<Provider, { readonly enabled?: boolean; readonly apiKey?: string | null }>>>;
  readonly languages?: readonly string[];
  readonly statsSettings?: {
    readonly openingTime?: string | null;
    readonly compressProductsCategories?: boolean;
    readonly timeSlots?: readonly StatsTimeSlot[];
  };
  readonly demo?: boolean;
  readonly status?: GroupStatus;
  readonly trashed?: boolean;
}

/** An update of a legacy group document: `$set` of owned fields only. */
export interface LegacyGroupUpdate {
  readonly $set: Readonly<Record<string, unknown>>;
}
