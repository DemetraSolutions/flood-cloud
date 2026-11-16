import {
  DEALER_PLANS,
  MEDIA_SLOTS,
  PLACE_SECTIONS,
  PLANS,
  SETTINGS_BLOCKS,
  placeRoute,
} from './place.types';

describe('placeRoute', () => {
  it('builds the URL segments of the detail of a place', () => {
    expect(placeRoute('g1', 'p1')).toEqual(['/groups', 'g1', 'places', 'p1']);
  });
});

describe('plans', () => {
  it('lists the plans a place may have', () => {
    expect(PLANS).toEqual(['basic', 'advanced', 'enterprice', 'tgm-secondary', 'desk-secondary']);
  });

  it('offers dealers every plan but the platform one', () => {
    expect(DEALER_PLANS).toEqual(['basic', 'advanced', 'enterprice', 'tgm-secondary']);
    for (const plan of DEALER_PLANS) {
      expect(PLANS).toContain(plan);
    }
    expect(DEALER_PLANS).not.toContain('desk-secondary');
  });
});

describe('PLACE_SECTIONS', () => {
  it('starts with the exact general tab at the root of the place', () => {
    expect(PLACE_SECTIONS[0]).toEqual({ id: 'general', path: '', key: 'GENERAL', exact: true });
    expect(PLACE_SECTIONS.filter((section) => section.exact)).toHaveLength(1);
  });

  it('has unique identifiers, paths and keys', () => {
    for (const field of ['id', 'path', 'key'] as const) {
      const values = PLACE_SECTIONS.map((section) => section[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('has the license, the opening hours and one tab per settings block', () => {
    const ids: readonly string[] = PLACE_SECTIONS.map((section) => section.id);
    expect(ids.slice(0, 3)).toEqual(['general', 'license', 'openingHours']);
    for (const block of SETTINGS_BLOCKS) {
      expect(ids).toContain(block);
    }
    expect(ids).toHaveLength(SETTINGS_BLOCKS.length + 3);
  });

  it('names the keys in upper snake case', () => {
    for (const section of PLACE_SECTIONS) {
      expect(section.key).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });
});

describe('MEDIA_SLOTS', () => {
  it('lists the five image slots of the media block', () => {
    expect(MEDIA_SLOTS).toEqual([
      'logoLight',
      'coverLight',
      'logoKiosk',
      'coverKiosk',
      'productPlaceholderKiosk',
    ]);
  });
});
