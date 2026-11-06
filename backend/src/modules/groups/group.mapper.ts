import { ObjectId } from 'mongodb';
import type { Catalog } from './catalogs/catalog.ts';
import { FEATURES, FEATURE_PROJECTION, isFeature } from './features.ts';
import { currencies } from './catalogs/currencies.ts';
import { fidelityCardRules } from './catalogs/fidelity-card-rules.ts';
import { newElementId } from './catalogs/kit.ts';
import type { CatalogAnomaly } from './catalogs/kit.ts';
import { measureUnits } from './catalogs/measure-units.ts';
import { priceLists } from './catalogs/price-lists.ts';
import { taxes } from './catalogs/taxes.ts';
import { warehouseRules } from './catalogs/warehouse-rules.ts';
import { DETAIL_CATALOG_PATHS } from './catalogs/registry.ts';
import { isLanguageCode } from './languages.ts';
import { PROVIDERS } from './group.types.ts';
import type {
  Group,
  IntegrationState,
  GroupAnomaly,
  GroupCatalogs,
  GroupChanges,
  GroupResponse,
  IntegrationFlags,
  LegacyGroupDocument,
  LegacyGroupUpdate,
  MappedGroup,
  Provider,
  StatsSettings,
  StatsTimeSlot,
} from './group.types.ts';

/** Separator of the languages in the legacy `settings.languages` (`it;en`). */
const LANGUAGE_SEPARATOR = ';';

/** The time of day in `HH:mm`. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The start of a statistics slot: a whole hour from `00:00` to `23:00`. */
export const SLOT_START = /^([01]\d|2[0-3]):00$/;

/** The end of a statistics slot: a whole hour from `01:00` to `24:00`. */
export const SLOT_END = /^(0[1-9]|1\d|2[0-4]):00$/;

/**
 * The fields read from `common.groups`: the ones the domain maps and nothing else. The apiKey, the hosts,
 * the type and plan, the places and every integration key are not listed, so they are never loaded.
 */
export const GROUP_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  name: 1,
  description: 1,
  dealerId: 1,
  status: 1,
  trash: 1,
  demo: 1,
  dataCluster: 1,
  insertDate: 1,
  updateDate: 1,
  ...FEATURE_PROJECTION,
  'settings.languages': 1,
  'settings.stats': 1,
  ...Object.fromEntries(PROVIDERS.map((provider) => [`settings.integrations.${provider}.status`, 1 as const])),
  // The capitalized variant of the legacy: read only when `easyappear` is missing.
  'settings.integrations.easyAppear.status': 1,
  ...Object.fromEntries(DETAIL_CATALOG_PATHS.map((path) => [path, 1 as const])),
});

/**
 * The stage of the aggregation that computes, in the database, whether each integration key is set (`apiKeySet.<provider>`): a key is set when it is a
 * non-empty string. Only the boolean leaves the database, so a key is never loaded, held in memory or logged.
 */
export const API_KEY_SET_PROJECTION: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(
    PROVIDERS.map((provider) => [
      `apiKeySet.${provider}`,
      { $and: [{ $eq: [{ $type: `$settings.integrations.${provider}.apiKey` }, 'string'] }, { $ne: [`$settings.integrations.${provider}.apiKey`, ''] }] },
    ]),
  ),
);

/** The keys of an integration: printable ASCII without spaces, 16 to 256 characters. */
export const API_KEY_PATTERN = /^[\x21-\x7E]{16,256}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An optional boolean flag: on only when `true`; absent, `null` and `false` are off, any other value is off and reported. */
function readFlag(raw: unknown, field: string, anomalies: GroupAnomaly[]): boolean {
  if (raw !== undefined && raw !== null && typeof raw !== 'boolean') {
    anomalies.push({ kind: 'invalidType', field });
  }
  return raw === true;
}

/** A `settings` container (`settings`, `settings.stats`, `settings.integrations`): an object, or nothing when absent; anything else is reported. */
function readContainer(raw: unknown, field: string, anomalies: GroupAnomaly[]): Readonly<Record<string, unknown>> {
  if (isRecord(raw)) {
    return raw;
  }
  if (raw !== undefined && raw !== null) {
    anomalies.push({ kind: 'invalidType', field });
  }
  return {};
}

/** The languages of `settings.languages` (`it;en`): the valid ISO 639-1 codes in order, without repetitions; the others are reported. */
function readLanguages(raw: unknown, anomalies: GroupAnomaly[]): string[] {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  if (typeof raw !== 'string') {
    anomalies.push({ kind: 'invalidType', field: 'settings.languages' });
    return [];
  }
  const languages = new Set<string>();
  for (const part of raw.split(LANGUAGE_SEPARATOR)) {
    const code = part.trim().toLowerCase();
    if (isLanguageCode(code)) {
      languages.add(code);
    } else if (code !== '') {
      anomalies.push({ kind: 'invalidLanguage', field: 'settings.languages' });
    }
  }
  return [...languages];
}

const hour = (value: number): string => `${String(value).padStart(2, '0')}:00`;

/** A legacy slot is `{ start, end }` in whole hours, the end counted as the hour that closes it (`end: 0` is `01:00`). */
function readTimeSlot(raw: unknown): StatsTimeSlot | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { start, end } = raw;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) {
    return null;
  }
  return { from: hour(start), to: hour(end + 1) };
}

function readStats(raw: unknown, anomalies: GroupAnomaly[]): StatsSettings {
  const stats = readContainer(raw, 'settings.stats', anomalies);
  const openingTime = stats['openingTime'];
  const slots = stats['timeSlots'];
  let timeSlots: StatsTimeSlot[] = [];
  if (Array.isArray(slots)) {
    timeSlots = slots.flatMap((slot: unknown) => {
      const read = readTimeSlot(slot);
      if (read === null) {
        anomalies.push({ kind: 'invalidTimeSlot', field: 'settings.stats.timeSlots' });
      }
      return read === null ? [] : [read];
    });
  } else if (slots !== undefined && slots !== null) {
    anomalies.push({ kind: 'invalidType', field: 'settings.stats.timeSlots' });
  }
  if (openingTime !== undefined && openingTime !== null && (typeof openingTime !== 'string' || !TIME_OF_DAY.test(openingTime))) {
    anomalies.push({ kind: 'invalidTime', field: 'settings.stats.openingTime' });
  }
  return {
    openingTime: typeof openingTime === 'string' && TIME_OF_DAY.test(openingTime) ? openingTime : null,
    compressProductsCategories: readFlag(stats['compressProductsCategories'], 'settings.stats.compressProductsCategories', anomalies),
    timeSlots,
  };
}

function readIntegrations(raw: unknown, keysSet: unknown, anomalies: GroupAnomaly[]): IntegrationFlags {
  const stored = readContainer(raw, 'settings.integrations', anomalies);
  const keys = isRecord(keysSet) ? keysSet : {};
  const flags = {} as Record<Provider, IntegrationState>;
  for (const provider of PROVIDERS) {
    // The legacy has some groups with `easyAppear` (capital A) instead of `easyappear`: read when the right one is missing, never written back.
    const variant = provider === 'easyappear' && (stored[provider] === undefined || stored[provider] === null) ? stored['easyAppear'] : stored[provider];
    const entry = readContainer(variant, `settings.integrations.${provider}`, anomalies);
    flags[provider] = { enabled: readFlag(entry['status'], `settings.integrations.${provider}.status`, anomalies), apiKeySet: keys[provider] === true };
  }
  return flags;
}

function readReference(raw: unknown, field: string, anomalies: GroupAnomaly[]): string | null {
  if (raw instanceof ObjectId) {
    return raw.toHexString();
  }
  if (raw !== null && raw !== undefined) {
    anomalies.push({ kind: 'invalidReference', field });
  }
  return null;
}

/** A text that is a string, or `null` when absent; anything else is reported. */
function readText(raw: unknown, field: string, anomalies: GroupAnomaly[]): string | null {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw !== undefined && raw !== null) {
    anomalies.push({ kind: 'invalidType', field });
  }
  return null;
}

function readDate(raw: unknown): Date | null {
  return raw instanceof Date ? raw : null;
}

/** The catalogs of the group form, each read by its own mapper; their anomalies join the ones of the group. */
function readCatalogs(document: LegacyGroupDocument, anomalies: GroupAnomaly[]): GroupCatalogs {
  const stored = document as unknown as Readonly<Record<string, unknown>>;
  const state = { raw: (path: string): unknown => stored[path], newId: newElementId };
  const found: CatalogAnomaly[] = [];
  const read = <E extends object>(catalog: Catalog<E>): E[] => catalog.list(state, found);
  const catalogs = {
    priceLists: read(priceLists),
    taxes: read(taxes),
    currencies: read(currencies),
    measureUnits: read(measureUnits),
    warehouseRules: read(warehouseRules),
    fidelityCardRules: read(fidelityCardRules),
  };
  anomalies.push(...found);
  return catalogs;
}

/**
 * Reads a legacy `groups` document into the domain model, tolerantly (`doc/Tasks.md` 0.2 rule 5): an irregular
 * document is read with its sound fields and every problem is returned as an anomaly, never thrown.
 *
 * - `status` is `active` only when it is exactly `true`; `trash` and `demo` are on only when `true`.
 * - Every feature of the catalog is present: off unless its flag is exactly `true` (a non-boolean is off and reported).
 * - `settings.languages` (`it;en`) gives the valid ISO 639-1 codes; `settings.stats` gives the statistics settings, with
 *   the legacy hour slots (`{ start, end }`) as `HH:00` times.
 * - Every known integration is present with its enabled state and whether a key is set (the key is never read; `easyAppear` is read only when `easyappear` is missing); an unknown provider is never read.
 * - The catalogs of the group form (price lists, taxes, currencies, measure units, warehouse rules, loyalty rules) are read tolerantly by their own mappers.
 * - `apiKey`, `databaseHost`, `filesHost`, `type`, `plan`, `expirationDate`, `places` and the data of later domains are never mapped.
 *
 * @param document The stored document (projected with {@link GROUP_PROJECTION}).
 * @returns The group and the anomalies found.
 */
export function fromLegacy(document: LegacyGroupDocument): MappedGroup {
  const anomalies: GroupAnomaly[] = [];
  const status = document.status;
  if (typeof status !== 'boolean') {
    anomalies.push({ kind: 'invalidType', field: 'status' });
  }
  const settings = readContainer(document.settings, 'settings', anomalies);
  const features = Object.fromEntries(FEATURES.map((feature) => [feature, readFlag(settings[feature], `settings.${feature}`, anomalies)])) as Record<(typeof FEATURES)[number], boolean>;
  const name = readText(document.name, 'name', anomalies);
  const group: Group = {
    id: document._id.toHexString(),
    name: name ?? '',
    description: readText(document.description, 'description', anomalies),
    dealerId: readReference(document.dealerId, 'dealerId', anomalies),
    status: status === true ? 'active' : 'suspended',
    trashed: readFlag(document.trash, 'trash', anomalies),
    demo: readFlag(document.demo, 'demo', anomalies),
    features,
    languages: readLanguages(settings['languages'], anomalies),
    statsSettings: readStats(settings['stats'], anomalies),
    integrations: readIntegrations(settings['integrations'], document.apiKeySet, anomalies),
    catalogs: readCatalogs(document, anomalies),
    dataCluster: readText(document.dataCluster, 'dataCluster', anomalies),
    createdAt: readDate(document.insertDate),
    updatedAt: readDate(document.updateDate),
  };
  return { group, anomalies };
}

/**
 * Translates domain changes into a legacy update (`doc/Tasks.md` 4.1). Only `$set` of fields the backend owns
 * ({@link GROUPS_OWNED_FIELDS}) is produced, never a replacement document, and `updateDate` is always set. The
 * languages are written as `a;b` (or `null` when none), the hour slots as `{ start, end }`, `status` and `trash` as booleans.
 *
 * @param changes What to change; absent fields are left alone.
 * @param now Value of `updateDate`.
 * @returns The update document.
 * @throws {Error} For a feature, provider or language outside the catalogs, or a time that is not a whole hour: callers validate input first, so these are bugs.
 */
export function toLegacyUpdate(changes: GroupChanges, now: Date): LegacyGroupUpdate {
  const set: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    set['name'] = changes.name;
  }
  if (changes.description !== undefined) {
    set['description'] = changes.description;
  }
  if (changes.demo !== undefined) {
    set['demo'] = changes.demo;
  }
  if (changes.status !== undefined) {
    set['status'] = changes.status === 'active';
  }
  if (changes.trashed !== undefined) {
    set['trash'] = changes.trashed;
  }
  for (const [feature, on] of Object.entries(changes.features ?? {})) {
    if (!isFeature(feature)) {
      throw new Error(`Refusing to write the feature "${feature}": not in the catalog`);
    }
    set[`settings.${feature}`] = on;
  }
  for (const [provider, state] of Object.entries(changes.integrations ?? {})) {
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`Refusing to write the integration "${provider}": not in the list of providers`);
    }
    if (state.enabled !== undefined) {
      set[`settings.integrations.${provider}.status`] = state.enabled;
    }
    if (state.apiKey !== undefined) {
      if (state.apiKey !== null && !API_KEY_PATTERN.test(state.apiKey)) {
        throw new Error('Refusing to write an integration key that is not 16 to 256 printable ASCII characters');
      }
      set[`settings.integrations.${provider}.apiKey`] = state.apiKey;
    }
  }
  if (changes.languages !== undefined) {
    if (!changes.languages.every(isLanguageCode)) {
      throw new Error('Refusing to write a language that is not an ISO 639-1 code');
    }
    set['settings.languages'] = changes.languages.length === 0 ? null : changes.languages.join(LANGUAGE_SEPARATOR);
  }
  const stats = changes.statsSettings;
  if (stats?.openingTime !== undefined) {
    set['settings.stats.openingTime'] = stats.openingTime;
  }
  if (stats?.compressProductsCategories !== undefined) {
    set['settings.stats.compressProductsCategories'] = stats.compressProductsCategories;
  }
  if (stats?.timeSlots !== undefined) {
    set['settings.stats.timeSlots'] = stats.timeSlots.map((slot) => {
      if (!SLOT_START.test(slot.from) || !SLOT_END.test(slot.to)) {
        throw new Error('Refusing to write a time slot that is not made of whole hours');
      }
      return { start: Number(slot.from.slice(0, 2)), end: Number(slot.to.slice(0, 2)) - 1 };
    });
  }
  set['updateDate'] = now;
  return { $set: set };
}

/**
 * The representation of a group on `/v1`: an explicit allowlist of fields. Nothing of the legacy document (API
 * key, hosts, type, plan, integration keys, places…) can appear, because the {@link Group} does not hold it.
 * Dates are ISO 8601 strings. The cluster is shown only to a PSA.
 *
 * @param group The group.
 * @param includeCluster Whether to show `dataCluster` (a PSA only).
 */
export function toResponse(group: Group, includeCluster: boolean): GroupResponse {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    dealerId: group.dealerId,
    status: group.status,
    trashed: group.trashed,
    demo: group.demo,
    features: { ...group.features },
    languages: [...group.languages],
    statsSettings: {
      openingTime: group.statsSettings.openingTime,
      compressProductsCategories: group.statsSettings.compressProductsCategories,
      timeSlots: group.statsSettings.timeSlots.map((slot) => ({ from: slot.from, to: slot.to })),
    },
    integrations: Object.fromEntries(PROVIDERS.map((provider) => [provider, { enabled: group.integrations[provider].enabled, apiKeySet: group.integrations[provider].apiKeySet }])) as IntegrationFlags,
    priceLists: [...group.catalogs.priceLists],
    taxes: [...group.catalogs.taxes],
    currencies: [...group.catalogs.currencies],
    measureUnits: [...group.catalogs.measureUnits],
    warehouseRules: [...group.catalogs.warehouseRules],
    fidelityCardRules: [...group.catalogs.fidelityCardRules],
    ...(includeCluster ? { dataCluster: group.dataCluster } : {}),
    createdAt: group.createdAt === null ? null : group.createdAt.toISOString(),
    updatedAt: group.updatedAt === null ? null : group.updatedAt.toISOString(),
  };
}

/**
 * The fields of a group the activity log records on an update, as plain values: nothing sensitive (the
 * integrations are reduced to the enabled flags and to whether a key is set, and named so that the log's redaction of `integrations` does not hide them).
 * The catalogs have their own events.
 *
 * @param group The group.
 */
export function changeSnapshot(group: Group): Record<string, unknown> {
  return {
    name: group.name,
    description: group.description,
    demo: group.demo,
    features: { ...group.features },
    languages: [...group.languages],
    statsSettings: toResponse(group, false).statsSettings,
    enabledIntegrations: Object.fromEntries(PROVIDERS.map((provider) => [provider, group.integrations[provider].enabled])),
    // Named so that the redaction of keys (`apikey`) does not hide it: only whether a key is set, never the key.
    integrationKeysConfigured: Object.fromEntries(PROVIDERS.map((provider) => [provider, group.integrations[provider].apiKeySet])),
  };
}
