import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import { FeatureName } from '../../core/groups/feature-catalog';
import {
  FIELDS,
  FieldDef,
  FieldType,
  FONT_SIZES,
  fieldLabelKey,
  groupLabelKey,
  groupsOf,
  isVisible,
  partOf,
  optionLabelKey,
  setAt,
  snake,
  toBodyValue,
  toFieldValue,
  valueAt,
} from './place-fields';
import { MEDIA_SLOTS, PLANS, SETTINGS_BLOCKS } from './place.types';
import { PLACE_TABS, SETTINGS_ENTRIES, SETTINGS_MENU_GROUPS } from './place-nav';
import { KIOSK_TEXTS } from './place-model';

const def = (type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({
  key: 'k',
  type,
  group: 'G',
  ...extra,
});

describe('keys of the dictionary', () => {
  it('turns camelCase into UPPER_SNAKE_CASE', () => {
    expect(snake('cashSettings')).toBe('CASH_SETTINGS');
    expect(snake('cols-4')).toBe('COLS-4');
    expect(snake('titleFontSize2')).toBe('TITLE_FONT_SIZE2');
  });

  it('builds the label keys', () => {
    expect(fieldLabelKey('printing', 'receipt.subtotalFontSize')).toBe(
      'PLACES.F.PRINTING.RECEIPT.SUBTOTAL_FONT_SIZE',
    );
    expect(fieldLabelKey('cashSettings', 'fastLogin')).toBe('PLACES.F.CASH_SETTINGS.FAST_LOGIN');
    expect(groupLabelKey('selfOrdering', 'GENERAL')).toBe('PLACES.G.SELF_ORDERING.GENERAL');
    expect(optionLabelKey('takeAway.sendOrderOnSave', 'ask')).toBe(
      'PLACES.OPTION.SEND_ORDER_ON_SAVE.ASK',
    );
    expect(optionLabelKey('catalogLayout', 'cols-4')).toBe('PLACES.OPTION.CATALOG_LAYOUT.COLS_4');
    expect(optionLabelKey('receiptsCancellation', 'notSync')).toBe(
      'PLACES.OPTION.RECEIPTS_CANCELLATION.NOT_SYNC',
    );
  });

  it('lists the groups of a block in order, without repeats', () => {
    expect(groupsOf('cashSettings')).toEqual(['GENERAL', 'OTHER']);
    expect(groupsOf('dealerSettings')).toEqual(['TRACKING', 'SERVER', 'CONNECTOR']);
    expect(new Set(groupsOf('printing')).size).toBe(groupsOf('printing').length);
  });

  it('has the font sizes rows by columns', () => {
    expect(FONT_SIZES).toHaveLength(9);
    expect(FONT_SIZES[0]).toBe('1-1');
    expect(FONT_SIZES[8]).toBe('3-3');
  });
});

describe('isVisible', () => {
  const feature = (enabled: string[]) => (name: FeatureName) => enabled.includes(name);

  it('shows a key that needs no feature', () => {
    expect(isVisible(def('flag'), { privileged: false, feature: feature([]) })).toBe(true);
  });

  it('shows a gated key only when the group has the feature', () => {
    const gated = def('flag', { needs: 'rooms' });
    expect(isVisible(gated, { privileged: false, feature: feature(['rooms']) })).toBe(true);
    expect(isVisible(gated, { privileged: false, feature: feature([]) })).toBe(false);
  });

  it('always shows a gated key to platform administrators and dealers', () => {
    const gated = def('flag', { needs: 'warehouse' });
    expect(isVisible(gated, { privileged: true, feature: feature([]) })).toBe(true);
    expect(isVisible(gated, { privileged: false, feature: feature([]) })).toBe(false);
  });
});

describe('partOf', () => {
  it('gives the title of the part of a printing group', () => {
    expect(partOf('printing', 'RECEIPT_GENERAL')).toBe('PLACES.PART.PRINT_RECEIPT');
    expect(partOf('printing', 'PREBILLING_LAYOUT')).toBe('PLACES.PART.PRINT_PREBILLING');
    expect(partOf('printing', 'ORDERING_TEXTS')).toBe('PLACES.PART.PRINT_ORDERING');
  });

  it('gives none for the other blocks', () => {
    expect(partOf('cashSettings', 'GENERAL')).toBeNull();
  });
});

describe('FIELDS', () => {
  const all = SETTINGS_BLOCKS.flatMap((block) => FIELDS[block]);

  it('has unique keys in every block', () => {
    for (const block of SETTINGS_BLOCKS) {
      const keys = FIELDS[block].map((definition) => definition.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('marks the payment credentials that only privileged users change', () => {
    const only = all.filter((definition) => definition.privilegedOnly);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((definition) => definition.type === 'secret')).toBe(true);
  });

  it('has the dictionary text of every empty choice that has its own', () => {
    for (const definition of all.filter((candidate) => candidate.noneKey)) {
      expect(definition.type).toBe('select');
    }
  });
});

describe('valueAt and setAt', () => {
  it('reads a dotted path, undefined where it does not exist', () => {
    const block = { a: { b: { c: 1 } }, d: null, e: 'x' };
    expect(valueAt(block, 'a.b.c')).toBe(1);
    expect(valueAt(block, 'a.x.c')).toBeUndefined();
    expect(valueAt(block, 'd.c')).toBeUndefined();
    expect(valueAt(block, 'e.length')).toBeUndefined();
    expect(valueAt(undefined, 'a')).toBeUndefined();
  });

  it('sets a dotted path creating the objects on the way', () => {
    const target: Record<string, unknown> = { keep: 1 };
    setAt(target, 'a.b.c', 5);
    setAt(target, 'a.b.d', 6);
    setAt(target, 'top', 7);
    expect(target).toEqual({ keep: 1, a: { b: { c: 5, d: 6 } }, top: 7 });
  });
});

describe('toFieldValue', () => {
  it('reads a flag only when it is true', () => {
    expect(toFieldValue(def('flag'), true)).toBe(true);
    expect(toFieldValue(def('flag'), 'true')).toBe(false);
    expect(toFieldValue(def('flag'), null)).toBe(false);
  });

  it.each(['number', 'int'] as const)('reads a %s as text', (type) => {
    expect(toFieldValue(def(type), 3.5)).toBe('3.5');
    expect(toFieldValue(def(type), 0)).toBe('0');
    expect(toFieldValue(def(type), '3')).toBe('');
    expect(toFieldValue(def(type), null)).toBe('');
  });

  it('reads a duration in minutes', () => {
    expect(toFieldValue(def('duration'), 900000)).toBe('15');
    expect(toFieldValue(def('duration'), 90000)).toBe('1.5');
    expect(toFieldValue(def('duration'), 'x')).toBe('');
    expect(toFieldValue(def('duration'), null)).toBe('');
  });

  it.each([
    'text',
    'long',
    'plain',
    'select',
    'font',
    'color',
    'time',
    'priceList',
    'category',
    'template',
    'company',
    'place',
    'secret',
  ] as const)('reads a %s as the string or empty', (type) => {
    expect(toFieldValue(def(type), 'abc')).toBe('abc');
    expect(toFieldValue(def(type), 4)).toBe('');
    expect(toFieldValue(def(type), null)).toBe('');
  });
});

describe('numeric selects', () => {
  const idle = def('select', { values: ['15', '20', '30'], numeric: true });

  it('read a number as text, and anything else as empty', () => {
    expect(toFieldValue(idle, 20)).toBe('20');
    expect(toFieldValue(idle, '20')).toBe('');
    expect(toFieldValue(idle, null)).toBe('');
    expect(toFieldValue(def('select', { values: ['a'] }), 'a')).toBe('a');
    expect(toFieldValue(def('select', { values: ['a'] }), 3)).toBe('');
  });

  it('send a number, an empty choice as null', () => {
    expect(toBodyValue(idle, '30')).toBe(30);
    expect(toBodyValue(idle, '')).toBeNull();
    expect(toBodyValue(def('select', { values: ['a'] }), 'a')).toBe('a');
  });

  it('are in the registry: the idle time of the tables and the MultiSafepay card', () => {
    const idleKey = FIELDS.tables.find((definition) => definition.key === 'tableIdleMinutes');
    expect(idleKey).toMatchObject({ type: 'select', numeric: true, values: ['15', '20', '30'] });
    const card = FIELDS.integrations.filter((definition) => definition.group === 'MULTISAFEPAY');
    expect(card.map((definition) => definition.key)).toEqual([
      'multisafepay.status',
      'multisafepay.terminalGroupId',
      'multisafepay.terminalGroupApiKey',
      'multisafepay.websiteApiKey',
      'multisafepay.qrStatus',
      'multisafepay.qrSecondsActive',
    ]);
    // The switches and the keys are for platform administrators and dealers.
    expect(card.filter((definition) => definition.reserved).map((d) => d.key)).toEqual([
      'multisafepay.status',
      'multisafepay.qrStatus',
    ]);
    expect(card.filter((definition) => definition.privilegedOnly).map((d) => d.key)).toEqual([
      'multisafepay.terminalGroupApiKey',
      'multisafepay.websiteApiKey',
    ]);
  });
});

describe('toBodyValue', () => {
  it('sends a flag as it is', () => {
    expect(toBodyValue(def('flag'), true)).toBe(true);
    expect(toBodyValue(def('flag'), false)).toBe(false);
  });

  it.each(['plain', 'font', 'color'] as const)('sends a %s as text, even empty', (type) => {
    expect(toBodyValue(def(type), 'x')).toBe('x');
    expect(toBodyValue(def(type), '')).toBe('');
  });

  it('sends a number or null', () => {
    expect(toBodyValue(def('number'), '2.5')).toBe(2.5);
    expect(toBodyValue(def('number'), '0')).toBe(0);
    expect(toBodyValue(def('number'), '')).toBeNull();
  });

  it('sends an int, an empty one as its default or null', () => {
    expect(toBodyValue(def('int'), '7')).toBe(7);
    expect(toBodyValue(def('int', { def: 5 }), '')).toBe(5);
    expect(toBodyValue(def('int', { def: 0 }), '')).toBe(0);
    expect(toBodyValue(def('int'), '')).toBeNull();
  });

  it('sends a duration in milliseconds, an empty one as its default or null', () => {
    expect(toBodyValue(def('duration'), '15')).toBe(900000);
    expect(toBodyValue(def('duration'), '0.5')).toBe(30000);
    expect(toBodyValue(def('duration', { def: 1800000 }), '')).toBe(1800000);
    expect(toBodyValue(def('duration'), '')).toBeNull();
  });

  it.each([
    'text',
    'long',
    'select',
    'time',
    'priceList',
    'category',
    'template',
    'company',
    'place',
    'secret',
  ] as const)('sends a %s as text or null when empty', (type) => {
    expect(toBodyValue(def(type), 'abc')).toBe('abc');
    expect(toBodyValue(def(type), '')).toBeNull();
  });
});

describe('the dictionary', () => {
  const keys = flattenDictionary(
    JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
  );
  const missing = (wanted: string[]): string[] =>
    [...new Set(wanted)].filter((key) => !keys.has(key));

  it('has a label for every settings key', () => {
    expect(
      missing(
        SETTINGS_BLOCKS.flatMap((block) =>
          FIELDS[block].map((definition) => fieldLabelKey(block, definition.key)),
        ),
      ),
    ).toEqual([]);
  });

  it('has a legend for every group', () => {
    expect(
      missing(
        SETTINGS_BLOCKS.flatMap((block) =>
          groupsOf(block).map((group) => groupLabelKey(block, group)),
        ),
      ),
    ).toEqual([]);
  });

  it('has a label for every value of every choice', () => {
    expect(
      missing(
        SETTINGS_BLOCKS.flatMap((block) =>
          FIELDS[block].flatMap((definition) =>
            (definition.values ?? []).map((value) => optionLabelKey(definition.key, value)),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('has the names of the sections, plans, days, kiosk texts and image slots', () => {
    expect(
      missing([
        ...PLACE_TABS.map((tab) => `PLACES.SECTION.${tab.key}`),
        ...SETTINGS_ENTRIES.map((entry) => `PLACES.MENU.${entry.key}`),
        ...SETTINGS_MENU_GROUPS.map((group) => `PLACES.MENU_GROUP.${group}`),
        ...PLANS.map((plan) => `PLACES.PLAN.${plan.toUpperCase().replace('-', '_')}`),
        ...[0, 1, 2, 3, 4, 5, 6].map((day) => `PLACES.DAY.${day}`),
        ...KIOSK_TEXTS.map((name) => `PLACES.KIOSK.TEXT.${snake(name)}`),
        ...MEDIA_SLOTS.map((slot) => `PLACES.MEDIA.SLOT.${snake(slot)}`),
      ]),
    ).toEqual([]);
  });

  it('has the texts of the opening hours', () => {
    expect(
      missing(
        [
          'TIMEZONE',
          'OPENING',
          'DELIVERY',
          'OPEN',
          'START',
          'END',
          'SLOTS',
          'ADD_SLOT',
          'SPECIAL',
          'SPECIAL_HINT',
          'SPECIAL_DAY',
          'DATE',
          'CLOSED',
          'ADD_SPECIAL',
          'REMOVE_SPECIAL',
        ].map((name) => `PLACES.HOURS.${name}`),
      ),
    ).toEqual([]);
  });
});
