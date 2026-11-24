/** The reasons a synchronization cannot start, as `GET /v1/groups/{groupId}/tobacco-sync` names them: each has its own text, with what to do about it. */
export const UNAVAILABLE_REASONS = [
  'featureDisabled',
  'noTobaccoPlace',
  'noZeroTaxRate',
  'noPriceList',
  'emptyList',
] as const;

/** A reason a synchronization cannot start. */
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** The figures of a synchronization that are written on the products and the categories. */
export const SYNC_PRODUCT_COUNTS = [
  'inserted',
  'updated',
  'disabled',
  'reactivated',
  'unchanged',
  'skipped',
] as const;

/** A figure of the products. */
export type SyncProductCount = (typeof SYNC_PRODUCT_COUNTS)[number];

/** Router link of the page of the group.
 *
 * @param groupId The group.
 */
export function tobaccoSyncRoute(groupId: string): string[] {
  return ['/groups', groupId, 'tools', 'tobacco-sync'];
}

/** A point of sale with the tobaccos on. */
export interface TobaccoPlace {
  readonly id: string;
  readonly name: string;
}

/** What `GET /v1/groups/{groupId}/tobacco-sync` answers. */
export interface SyncStatus {
  /** Whether a synchronization can start now. */
  readonly available: boolean;
  /** Why not, empty when it can (names the server may extend: see {@link reasonKey}). */
  readonly reasons: readonly string[];
  /** Whether the option "move the warehouse" is accepted for the group. */
  readonly warehouseAllowed: boolean;
  /** The points of sale of the group with the tobaccos on. */
  readonly tobaccoPlaces: readonly TobaccoPlace[];
  /** The national price list. */
  readonly list: { readonly entries: number; readonly importedAt: string | null };
  /** The newest synchronization that wrote (the activity log keeps its entries for a limited time), `null` when there is none. */
  readonly lastSync: {
    readonly at: string;
    readonly counts: Readonly<Record<string, string | number | boolean | null>>;
  } | null;
}

/**
 * The safeguard against a synchronization that would turn off many tobaccos (more than 20% of the active ones): every answer carries `massDisable: { active, exceeded }`; when `exceeded` the synchronization is refused with a `409`
 * (`group`/`massDisable`) unless it is sent with `confirmMassDisable: true`. The names the backend uses for it are read only here.
 */
export interface MassDisable {
  /** How many tobaccos of the group are active now. */
  readonly active: number;
  /** Whether the tobaccos to deactivate are more than the threshold. */
  readonly exceeded: boolean;
}

/** What a mass deactivation is shown with. */
export interface MassDisableFigures {
  /** How many tobaccos the synchronization would deactivate. */
  readonly disable: number;
  /** How many tobaccos of the group are active now. */
  readonly active: number;
}

/**
 * The figures of the mass deactivation a check reports.
 *
 * @param outcome What the check answered.
 * @returns The figures when the threshold is exceeded, `null` otherwise.
 */
export function massDisableOf(outcome: SyncOutcome): MassDisableFigures | null {
  const mass = outcome.massDisable;
  return mass?.exceeded === true
    ? { disable: outcome.products.disabled, active: mass.active }
    : null;
}

/** The body of `POST /v1/groups/{groupId}/tobacco-sync`. */
export interface SyncOptions {
  readonly warehouse: boolean;
  readonly noDiscount: boolean;
  /** Points of sale of the availability; empty means every point of sale. */
  readonly placeIds: readonly string[];
  /** Set only after the explicit confirmation of a mass deactivation: sent as `confirmMassDisable: true`. */
  readonly confirmMassDisable?: true;
}

/** What a synchronization answers (or, on a check, would do). */
export interface SyncOutcome {
  /** `true` when nothing was written. */
  readonly dryRun: boolean;
  readonly products: Readonly<Record<SyncProductCount, number>>;
  readonly categories: { readonly inserted: number; readonly duplicateNames: number };
  readonly duplicateCodes: number;
  /** The safeguard against a mass deactivation. */
  readonly massDisable?: MassDisable;
}

/**
 * Dictionary key of the text of a reason; a name the backoffice does not know gets the generic text.
 *
 * @param reason The reason as the server named it.
 */
export function reasonKey(reason: string): string {
  return (UNAVAILABLE_REASONS as readonly string[]).includes(reason)
    ? `TOBACCO_SYNC.REASON.${reason}`
    : 'TOBACCO_SYNC.REASON.unknown';
}

/**
 * A figure of the last synchronization, `0` when the log entry does not have it as a number.
 *
 * @param counts The `counts` of the last synchronization.
 * @param name Name of the figure.
 */
export function countOf(counts: Readonly<Record<string, unknown>>, name: string): number {
  const value = counts[name];
  return typeof value === 'number' ? value : 0;
}
