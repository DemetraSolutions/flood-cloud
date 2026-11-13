import { FeatureFlags, FeatureName } from '../../core/groups/feature-catalog';

/** Status of a group: a suspended group is refused to everyone but the platform administrators. */
export type GroupStatus = 'active' | 'suspended';

/** Providers whose integration a group may switch on. */
export const INTEGRATION_PROVIDERS = [
  'easyappear',
  'yellgo',
  'leggimenu',
  'plateform',
  'cooperto',
  'qodeup',
  'statmanager',
] as const;

/** Name of an integration provider. */
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** State of one integration: the key is never returned, only whether one is set. */
export interface Integration {
  readonly enabled: boolean;
  readonly apiKeySet: boolean;
}

/** A time slot of the statistics (whole hours, `to` up to `24:00`). */
export interface TimeSlot {
  from: string;
  to: string;
}

/** Statistics settings of a group. */
export interface StatsSettings {
  readonly openingTime: string | null;
  readonly compressProductsCategories: boolean;
  readonly timeSlots: readonly TimeSlot[];
}

/** A group as returned by `GET /v1/groups/{groupId}` (the six catalogs are read from their routes). */
export interface Group {
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
  readonly integrations: Readonly<Record<IntegrationProvider, Integration>>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** Active and trashed elements of one kind. */
export interface ElementCount {
  readonly active: number;
  readonly trashed: number;
}

/** Counts of the companies, places and users of a group (from the common database). */
export interface GroupCounts {
  readonly companies: ElementCount;
  readonly places: ElementCount;
  readonly users: ElementCount;
}

/** A group as listed by `GET /v1/groups`. */
export interface GroupListItem {
  readonly id: string;
  readonly name: string;
  readonly status: GroupStatus;
  readonly trashed: boolean;
  readonly dealerId: string | null;
  readonly demo: boolean;
  readonly counts: GroupCounts;
}

/** Body of `PATCH /v1/groups/{groupId}` (JSON Merge Patch: only what changed). */
export interface GroupPatch {
  name?: string;
  description?: string | null;
  languages?: string[];
  statsSettings?: {
    openingTime?: string | null;
    compressProductsCategories?: boolean;
    timeSlots?: TimeSlot[];
  };
  features?: Partial<Record<FeatureName, boolean>>;
  integrations?: Partial<
    Record<IntegrationProvider, { enabled?: boolean; apiKey?: string | null }>
  >;
  demo?: boolean;
}

/** The "general" part of a group as the form edits it (text fields are `''` when empty). */
export interface GeneralModel {
  name: string;
  description: string;
  languages: string[];
  openingTime: string;
  compressProductsCategories: boolean;
  timeSlots: TimeSlot[];
  demo: boolean;
}

/** Most languages a group may have. */
export const MAX_LANGUAGES = 10;
/** Most time slots a group may have. */
export const MAX_TIME_SLOTS = 48;
/** Length limits of the key of an integration (printable ASCII, no spaces). */
export const API_KEY_MIN = 16;
export const API_KEY_MAX = 256;

/** `HH:mm`. */
export const OPENING_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Hours the slots may start at (`00:00`…`23:00`) and end at (`01:00`…`24:00`). */
export const SLOT_STARTS = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
export const SLOT_ENDS = Array.from({ length: 24 }, (_, hour) => hourLabel(hour + 1));
/** Printable ASCII without spaces, as the backend accepts for a provider key. */
export const API_KEY_CHARACTERS = /^[\x21-\x7e]*$/;

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** Trimmed text, or `null` when blank. */
export function textOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

/** Form model for a stored group, or the empty one while it is not loaded. */
export function toGeneralModel(group: Group | null): GeneralModel {
  return {
    name: group?.name ?? '',
    description: group?.description ?? '',
    languages: [...(group?.languages ?? [])],
    openingTime: group?.statsSettings.openingTime ?? '',
    compressProductsCategories: group?.statsSettings.compressProductsCategories ?? false,
    timeSlots: (group?.statsSettings.timeSlots ?? []).map((slot) => ({ ...slot })),
    demo: group?.demo ?? false,
  };
}

function sameSlots(a: readonly TimeSlot[], b: readonly TimeSlot[]): boolean {
  return (
    a.length === b.length && a.every((slot, i) => slot.from === b[i].from && slot.to === b[i].to)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Modification body of the general part: only what differs from the stored group. An emptied
 * description or opening time is `null`; `demo` is included only when the user may change it.
 *
 * @param model Current form values.
 * @param group Stored group.
 * @param canDemo Whether the user may change `demo` (platform administrators only).
 */
export function buildGeneralPatch(model: GeneralModel, group: Group, canDemo: boolean): GroupPatch {
  const patch: GroupPatch = {};
  if (model.name.trim() !== group.name) {
    patch.name = model.name.trim();
  }
  if (textOrNull(model.description) !== group.description) {
    patch.description = textOrNull(model.description);
  }
  if (!sameList(model.languages, group.languages)) {
    patch.languages = [...model.languages];
  }
  const stats: NonNullable<GroupPatch['statsSettings']> = {};
  if (textOrNull(model.openingTime) !== group.statsSettings.openingTime) {
    stats.openingTime = textOrNull(model.openingTime);
  }
  if (model.compressProductsCategories !== group.statsSettings.compressProductsCategories) {
    stats.compressProductsCategories = model.compressProductsCategories;
  }
  if (!sameSlots(model.timeSlots, group.statsSettings.timeSlots)) {
    stats.timeSlots = model.timeSlots.map((slot) => ({ from: slot.from, to: slot.to }));
  }
  if (Object.keys(stats).length > 0) {
    patch.statsSettings = stats;
  }
  if (canDemo && model.demo !== group.demo) {
    patch.demo = model.demo;
  }
  return patch;
}

/**
 * Form field a backend `details[].field` of the general part belongs to
 * (`statsSettings.openingTime` becomes `openingTime`, `languages.2` becomes `languages`,
 * `statsSettings.timeSlots.1.to` becomes `timeSlots`).
 */
export function generalFieldOf(field: string): string {
  const name = field.replace(/^statsSettings\./, '');
  return name.split('.')[0];
}
