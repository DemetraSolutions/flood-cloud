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
  optionLabelKey,
  setAt,
  snake,
  toBodyValue,
  toFieldValue,
  valueAt,
} from './place-fields';
import { MEDIA_SLOTS, PLACE_SECTIONS, PLANS, SETTINGS_BLOCKS } from './place.types';
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
    expect(groupsOf('payments')).toEqual(['DEFAULTS']);
    expect(groupsOf('cashSettings').slice(0, 3)).toEqual(['LOGIN', 'CART', 'SHIFTS']);
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
    expect(isVisible(gated, { privileged: true, feature: feature([]) })).toBe(false);
  });

  it('shows a key marked for privileged users to them without the feature', () => {
    const gated = def('flag', { needs: 'warehouse', orPrivileged: true });
    expect(isVisible(gated, { privileged: true, feature: feature([]) })).toBe(true);
    expect(isVisible(gated, { privileged: false, feature: feature([]) })).toBe(false);
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
  ] as const)('reads a %s as the string or empty', (type) => {
    expect(toFieldValue(def(type), 'abc')).toBe('abc');
    expect(toFieldValue(def(type), 4)).toBe('');
    expect(toFieldValue(def(type), null)).toBe('');
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
        ...PLACE_SECTIONS.map((section) => `PLACES.SECTION.${section.key}`),
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
