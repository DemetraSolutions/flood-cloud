import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  POS_BOOLEAN_OPTIONS,
  POS_CHOICE_DEFAULTS,
  POS_CHOICE_NAMES,
  POS_GENERAL_CHOICES,
  POS_HANDHELD_CHOICES,
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
  it('lists the 47 grants once, in the order of the groups', () => {
    expect(POS_FLAGS).toHaveLength(47);
    expect(new Set(POS_FLAGS).size).toBe(47);
    expect(POS_FLAGS).toEqual(POS_GRANT_GROUPS.flatMap((group) => [...group.flags]));
    expect(POS_GRANT_GROUPS.map((group) => group.id)).toEqual([
      'APPS',
      'SALE',
      'RECEIPTS',
      'TABLES',
      'PRODUCTS',
    ]);
  });

  it('lists the 34 boolean preferences once, in the order of the groups', () => {
    expect(POS_BOOLEAN_OPTIONS).toHaveLength(34);
    expect(new Set(POS_BOOLEAN_OPTIONS).size).toBe(34);
    expect(POS_BOOLEAN_OPTIONS).toEqual(POS_OPTION_GROUPS.flatMap((group) => [...group.flags]));
    expect(POS_OPTION_GROUPS.map((group) => group.id)).toEqual([
      'COUNTER',
      'PRODUCTS',
      'TABLES',
      'RESTAURANT',
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
    expect(POS_CHOICE_NAMES).toHaveLength(15);
    expect(POS_CHOICES.handheldTextZoom).toEqual([
      '85',
      '90',
      '95',
      '100',
      '105',
      '110',
      '115',
      '120',
      '125',
    ]);
    expect(POS_CHOICES.handheldProductsColumns).toEqual(['1', '2', '3', '4']);
    expect(POS_GENERAL_CHOICES).toHaveLength(9);
    expect(POS_HANDHELD_CHOICES).toHaveLength(5);
    expect(POS_CHOICE_DEFAULTS.handheldTextZoom).toBe('100');
    // Every choice with a default is a valid value of its list.
    for (const [name, value] of Object.entries(POS_CHOICE_DEFAULTS)) {
      expect((POS_CHOICES as Record<string, readonly string[]>)[name]).toContain(value);
    }
    expect(POS_CHOICES.side).toEqual(['dx', 'sx']);
    expect(POS_CHOICES.virtualKeyboard).toContain('');
    expect(POS_CHOICES.roomsGridZoomHandheld).toContain('1.5');
  });
});
