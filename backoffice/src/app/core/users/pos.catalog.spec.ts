import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  POS_BOOLEAN_OPTIONS,
  POS_CHOICE_NAMES,
  POS_CHOICES,
  POS_FLAGS,
  POS_GRANT_GROUPS,
  POS_OPTION_GROUPS,
  posKey,
} from './pos.catalog';

describe('posKey', () => {
  it.each([
    ['discount', 'DISCOUNT'],
    ['discountMaxPercentage', 'DISCOUNT_MAX_PERCENTAGE'],
    ['roomsGridZoomHandheld', 'ROOMS_GRID_ZOOM_HANDHELD'],
    ['cashMatic', 'CASH_MATIC'],
    ['archiveAll', 'ARCHIVE_ALL'],
  ])('%s -> %s', (name, key) => {
    expect(posKey(name)).toBe(key);
  });
});

describe('POS catalog', () => {
  it('lists the 44 grants once, in the order of the groups', () => {
    expect(POS_FLAGS).toHaveLength(44);
    expect(new Set(POS_FLAGS).size).toBe(44);
    expect(POS_FLAGS).toEqual(POS_GRANT_GROUPS.flatMap((group) => [...group.flags]));
    expect(POS_GRANT_GROUPS.map((group) => group.id)).toEqual([
      'SALE',
      'RECEIPTS',
      'TABLES',
      'PRODUCTS',
    ]);
  });

  it('lists the 31 boolean preferences once, in the order of the groups', () => {
    expect(POS_BOOLEAN_OPTIONS).toHaveLength(31);
    expect(new Set(POS_BOOLEAN_OPTIONS).size).toBe(31);
    expect(POS_BOOLEAN_OPTIONS).toEqual(POS_OPTION_GROUPS.flatMap((group) => [...group.flags]));
    expect(POS_OPTION_GROUPS.map((group) => group.id)).toEqual([
      'COUNTER',
      'PRODUCTS',
      'TABLES',
      'DELIVERY',
    ]);
  });

  it('keeps grants and preferences apart', () => {
    const grants = new Set<string>(POS_FLAGS);
    expect(POS_BOOLEAN_OPTIONS.some((name) => name === 'darkMode')).toBe(true);
    expect(grants.has('darkMode')).toBe(false);
  });

  it('lists the automatic cash devices with their flags', () => {
    expect(AUTOMATIC_CASH_DEVICES).toEqual(['glory', 'cashMatic', 'vne', 'azkoyen', 'cashSystem']);
    expect(AUTOMATIC_CASH.cashSystem).toEqual(['withdrawal']);
    for (const device of AUTOMATIC_CASH_DEVICES) {
      expect(new Set(AUTOMATIC_CASH[device]).size).toBe(AUTOMATIC_CASH[device].length);
    }
  });

  it('lists the choice preferences and their values', () => {
    expect(POS_CHOICE_NAMES).toEqual(Object.keys(POS_CHOICES));
    expect(POS_CHOICE_NAMES).toHaveLength(9);
    expect(POS_CHOICES.side).toEqual(['dx', 'sx']);
    expect(POS_CHOICES.virtualKeyboard).toContain('');
    expect(POS_CHOICES.roomsGridZoomHandheld).toContain('1.5');
  });
});
