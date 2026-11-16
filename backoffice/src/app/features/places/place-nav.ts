import { FeatureName } from '../../core/groups/feature-catalog';
import { PlaceSection } from './place.types';

/** The top tabs of the place, in the order of the legacy backoffice. */
export const PLACE_TABS = [
  { id: 'general', path: '', key: 'GENERAL', exact: true },
  { id: 'devices', path: 'devices', key: 'DEVICES', exact: false },
  { id: 'printStations', path: 'print-stations', key: 'PRINT_STATIONS', exact: false },
  { id: 'rooms', path: 'rooms', key: 'ROOMS', exact: false },
  { id: 'storages', path: 'storages', key: 'STORAGES', exact: false },
  { id: 'openingHours', path: 'hours', key: 'OPENING_HOURS', exact: false },
  { id: 'media', path: 'media', key: 'MEDIA', exact: false },
  { id: 'settings', path: 'settings', key: 'SETTINGS', exact: false },
  { id: 'integrations', path: 'integrations', key: 'INTEGRATIONS', exact: false },
] as const;

/** Identifier of a top tab. */
export type PlaceTabId = (typeof PLACE_TABS)[number]['id'];

/** A group of the side menu of the settings tab. */
export type SettingsMenuGroup = 'SETTINGS' | 'FUNCTIONALITY' | 'PRINTS' | 'OTHER';

/** The groups of the side menu, in order. */
export const SETTINGS_MENU_GROUPS: readonly SettingsMenuGroup[] = [
  'SETTINGS',
  'FUNCTIONALITY',
  'PRINTS',
  'OTHER',
];

/**
 * The part of a settings block an entry of the side menu edits: the cash settings are split in two
 * entries, the general settings and the "other settings" (only the receipts cancellation).
 */
export type EntryScope = 'all' | 'main' | 'other';

/** An entry of the side menu of the settings tab. */
export interface SettingsEntry {
  /** Path below `settings` and identifier. */
  readonly id: string;
  readonly group: SettingsMenuGroup;
  /** Key of the label (`PLACES.MENU.<key>`). */
  readonly key: string;
  /** The section of the form the entry edits. */
  readonly section: PlaceSection;
  readonly scope: EntryScope;
  /** The feature that shows the entry to the users other than platform administrators and dealers. */
  readonly needs?: FeatureName;
  /** Platform administrators and dealers only. */
  readonly privileged?: boolean;
}

/** The entries of the side menu of the settings tab, in the order of the legacy backoffice. */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  {
    id: 'dealer',
    group: 'SETTINGS',
    key: 'DEALER',
    section: 'dealerSettings',
    scope: 'all',
    privileged: true,
  },
  { id: 'general', group: 'SETTINGS', key: 'GENERAL', section: 'cashSettings', scope: 'main' },
  {
    id: 'rooms-settings',
    group: 'SETTINGS',
    key: 'ROOMS',
    section: 'tables',
    scope: 'all',
    needs: 'rooms',
  },
  {
    id: 'delivery',
    group: 'FUNCTIONALITY',
    key: 'DELIVERY',
    section: 'delivery',
    scope: 'all',
    needs: 'rooms',
  },
  {
    id: 'reservations',
    group: 'FUNCTIONALITY',
    key: 'RESERVATIONS',
    section: 'reservations',
    scope: 'all',
    needs: 'rooms',
  },
  {
    id: 'self-ordering',
    group: 'FUNCTIONALITY',
    key: 'SELF_ORDERING',
    section: 'selfOrdering',
    scope: 'all',
    needs: 'rooms',
  },
  {
    id: 'external-display',
    group: 'FUNCTIONALITY',
    key: 'EXTERNAL_DISPLAY',
    section: 'externalDisplay',
    scope: 'all',
  },
  { id: 'kiosk', group: 'FUNCTIONALITY', key: 'KIOSK', section: 'kiosk', scope: 'all' },
  {
    id: 'appointments',
    group: 'FUNCTIONALITY',
    key: 'APPOINTMENTS',
    section: 'appointments',
    scope: 'all',
    needs: 'appointments',
  },
  { id: 'fidelity', group: 'FUNCTIONALITY', key: 'FIDELITY', section: 'fidelity', scope: 'all' },
  {
    id: 'tobacco',
    group: 'FUNCTIONALITY',
    key: 'TOBACCO',
    section: 'tobacco',
    scope: 'all',
    needs: 'tobaccosGamesMonopoly',
  },
  { id: 'print', group: 'PRINTS', key: 'PRINT', section: 'printing', scope: 'all' },
  { id: 'other', group: 'OTHER', key: 'OTHER', section: 'cashSettings', scope: 'other' },
  { id: 'payments', group: 'OTHER', key: 'PAYMENTS', section: 'payments', scope: 'all' },
];

/** The sections each top tab edits (its unsaved changes and errors are those of these sections). */
export function tabSections(tab: PlaceTabId): readonly PlaceSection[] {
  switch (tab) {
    case 'general':
      return ['general', 'license'];
    case 'settings':
      return [...new Set(SETTINGS_ENTRIES.map((entry) => entry.section))];
    default:
      return [tab];
  }
}

/**
 * The route, below the place, where a section is edited: the tab and, in the settings, the entry of
 * the side menu (the "other settings" entry for the receipts cancellation of the cash settings).
 *
 * @param section The section.
 * @param other Whether the error is on the key of the "other settings" entry.
 */
export function sectionLocation(section: PlaceSection, other = false): string[] {
  switch (section) {
    case 'general':
    case 'license':
      return [];
    case 'openingHours':
      return ['hours'];
    case 'devices':
    case 'rooms':
    case 'storages':
    case 'media':
    case 'integrations':
      return [section];
    case 'printStations':
      return ['print-stations'];
    default: {
      const entries = SETTINGS_ENTRIES.filter((entry) => entry.section === section);
      const entry = other ? entries.find((candidate) => candidate.scope === 'other') : entries[0];
      return ['settings', (entry ?? entries[0]).id];
    }
  }
}
