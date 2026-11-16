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
  it('starts with the general data, the license and the opening hours', () => {
    expect(PLACE_SECTIONS.slice(0, 3)).toEqual(['general', 'license', 'openingHours']);
  });

  it('has one section per settings block and the lists of the place', () => {
    for (const block of SETTINGS_BLOCKS) {
      expect(PLACE_SECTIONS).toContain(block);
    }
    expect(PLACE_SECTIONS.slice(-4)).toEqual(['devices', 'printStations', 'rooms', 'storages']);
    expect(PLACE_SECTIONS).toHaveLength(SETTINGS_BLOCKS.length + 7);
  });

  it('has no repeats', () => {
    expect(new Set(PLACE_SECTIONS).size).toBe(PLACE_SECTIONS.length);
  });

  it('has the integrations and the dealer settings among the blocks', () => {
    expect(SETTINGS_BLOCKS.slice(-2)).toEqual(['integrations', 'dealerSettings']);
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
