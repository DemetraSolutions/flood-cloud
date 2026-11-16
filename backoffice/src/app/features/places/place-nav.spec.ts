import { FEATURE_NAMES } from '../../core/groups/feature-catalog';
import {
  PLACE_TABS,
  SETTINGS_ENTRIES,
  SETTINGS_MENU_GROUPS,
  sectionLocation,
  tabSections,
} from './place-nav';
import { PLACE_SECTIONS, PlaceSection } from './place.types';

describe('PLACE_TABS', () => {
  it('starts with the exact general tab at the root of the place', () => {
    expect(PLACE_TABS[0]).toEqual({ id: 'general', path: '', key: 'GENERAL', exact: true });
    expect(PLACE_TABS.filter((tab) => tab.exact)).toHaveLength(1);
  });

  it('has unique identifiers, paths and keys, the keys in upper snake case', () => {
    for (const field of ['id', 'path', 'key'] as const) {
      const values = PLACE_TABS.map((tab) => tab[field]);
      expect(new Set(values).size).toBe(values.length);
    }
    for (const tab of PLACE_TABS) {
      expect(tab.key).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });
});

describe('SETTINGS_ENTRIES', () => {
  it('has unique ids and belongs to a known group', () => {
    const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of SETTINGS_ENTRIES) {
      expect(SETTINGS_MENU_GROUPS).toContain(entry.group);
      expect(PLACE_SECTIONS).toContain(entry.section);
    }
  });

  it('splits the cash settings in the general and the other entries', () => {
    const cash = SETTINGS_ENTRIES.filter((entry) => entry.section === 'cashSettings');
    expect(cash.map((entry) => [entry.id, entry.scope])).toEqual([
      ['general', 'main'],
      ['other', 'other'],
    ]);
  });

  it('keeps the dealer entry for the privileged users', () => {
    expect(SETTINGS_ENTRIES[0]).toMatchObject({ id: 'dealer', privileged: true });
    expect(SETTINGS_ENTRIES.filter((entry) => entry.privileged)).toHaveLength(1);
  });

  it('only asks for features of the catalog', () => {
    for (const entry of SETTINGS_ENTRIES.filter((candidate) => candidate.needs !== undefined)) {
      expect(FEATURE_NAMES as readonly string[]).toContain(entry.needs);
    }
  });
});

describe('tabSections', () => {
  it('gives the general data and the license for the general tab', () => {
    expect(tabSections('general')).toEqual(['general', 'license']);
  });

  it('gives the sections of the entries, once, for the settings tab', () => {
    const sections = tabSections('settings');
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections).toContain('cashSettings');
    expect(sections).toContain('dealerSettings');
    expect(sections).toContain('payments');
    expect(sections).not.toContain('integrations');
  });

  it('gives the tab itself for the others', () => {
    expect(tabSections('devices')).toEqual(['devices']);
    expect(tabSections('openingHours')).toEqual(['openingHours']);
    expect(tabSections('integrations')).toEqual(['integrations']);
  });

  it('covers every section of the form with some tab', () => {
    const covered = new Set<PlaceSection>(PLACE_TABS.flatMap((tab) => tabSections(tab.id)));
    for (const section of PLACE_SECTIONS) {
      expect(covered.has(section)).toBe(true);
    }
  });
});

describe('sectionLocation', () => {
  it.each([
    ['general', []],
    ['license', []],
    ['openingHours', ['hours']],
    ['devices', ['devices']],
    ['rooms', ['rooms']],
    ['storages', ['storages']],
    ['media', ['media']],
    ['integrations', ['integrations']],
    ['printStations', ['print-stations']],
    ['dealerSettings', ['settings', 'dealer']],
    ['tables', ['settings', 'rooms-settings']],
    ['selfOrdering', ['settings', 'self-ordering']],
    ['printing', ['settings', 'print']],
    ['payments', ['settings', 'payments']],
  ] as [PlaceSection, string[]][])('locates %s', (section, location) => {
    expect(sectionLocation(section)).toEqual(location);
  });

  it('locates the cash settings in the general entry, or in the other one', () => {
    expect(sectionLocation('cashSettings')).toEqual(['settings', 'general']);
    expect(sectionLocation('cashSettings', false)).toEqual(['settings', 'general']);
    expect(sectionLocation('cashSettings', true)).toEqual(['settings', 'other']);
  });

  it('keeps the only entry of a section that has no "other" one', () => {
    expect(sectionLocation('kiosk', true)).toEqual(['settings', 'kiosk']);
  });

  it('gives every section of the form a location that exists', () => {
    for (const section of PLACE_SECTIONS) {
      const [first, second] = sectionLocation(section);
      if (first === 'settings') {
        expect(SETTINGS_ENTRIES.map((entry) => entry.id)).toContain(second);
      }
    }
  });
});
