import { readdirSync, readFileSync } from 'node:fs';
import { API_ERROR_CODES, CLIENT_ERROR_CODES } from '../api/api.types';
import { FIELD_ISSUES, issueMessageKey } from '../api/field-issues';
import { FEATURE_NAMES, featureTextKey } from '../groups/feature-catalog';
import { GROUP_SECTIONS } from '../../features/groups/group-settings';
import { PROMOTION_SECTIONS } from '../../features/groups/catalogs/promotion-model';
import { INTEGRATION_PROVIDERS } from '../../features/groups/group.types';
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
} from '../users/pos.catalog';
import { SHIFT_DAY_KEYS } from '../users/shift-time';
import { PERMISSION_MODULES } from '../../features/users/user.types';
import { flattenDictionary } from './dictionary';
import { SUPPORTED_LANGUAGES } from './language';

const ROOT = `${process.cwd()}`;

function files(dir: string, extension: string): { path: string; content: string }[] {
  return readdirSync(`${ROOT}/${dir}`, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith('.spec.ts'),
    )
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      return { path, content: readFileSync(path, 'utf8') };
    });
}

function dictionary(language: string): ReadonlyMap<string, string> {
  return flattenDictionary(
    JSON.parse(readFileSync(`${ROOT}/public/i18n/${language}.json`, 'utf8')),
  );
}

const sources = [...files('src/app', '.ts'), ...files('src/app', '.html')];

function usedKeys(): { path: string; key: string }[] {
  const patterns = [/'([A-Z][A-Z0-9_.]*)'\s*\|\s*t\b/g, /\bt\(\s*'([A-Z][A-Z0-9_.]*)'/g];
  return sources.flatMap(({ path, content }) =>
    patterns.flatMap((pattern) => [...content.matchAll(pattern)].map((m) => ({ path, key: m[1] }))),
  );
}

describe('dictionaries', () => {
  it('scans some sources (guards against a broken scan)', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(usedKeys().length).toBeGreaterThan(0);
  });

  it.each([...SUPPORTED_LANGUAGES])(
    '%s defines every key used in templates and code',
    (language) => {
      const keys = dictionary(language);
      const missing = usedKeys().filter(({ key }) => !keys.has(key));
      expect(missing).toEqual([]);
    },
  );

  it('all supported dictionaries have the same set of keys', () => {
    const [first, ...others] = SUPPORTED_LANGUAGES;
    const reference = [...dictionary(first).keys()].sort();
    for (const language of others) {
      expect([...dictionary(language).keys()].sort()).toEqual(reference);
    }
  });

  it('defines a user message for every API and client error code', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const keys = dictionary(language);
      for (const code of [...API_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
        expect(keys.has(`ERRORS.API.${code}`)).toBe(true);
      }
    }
  });

  it('defines a message for every field issue and for the generic one', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const keys = dictionary(language);
      for (const issue of [...FIELD_ISSUES, 'not-an-issue']) {
        expect(keys.has(issueMessageKey(issue))).toBe(true);
      }
    }
  });

  it('defines the texts whose keys are built at run time (features, integrations, catalogs, group actions)', () => {
    const keys = dictionary('it');
    const expected: string[] = [];
    for (const name of FEATURE_NAMES) {
      expected.push(featureTextKey(name, 'LABEL'), featureTextKey(name, 'DESCRIPTION'));
    }
    for (const provider of INTEGRATION_PROVIDERS) {
      expected.push(`INTEGRATION.${provider.toUpperCase()}`);
    }
    for (const section of GROUP_SECTIONS) {
      expected.push(`GROUP_SETTINGS.SECTION.${section.key}`);
      if (section.path.match(/-|^taxes|^currencies/) !== null) {
        for (const part of [
          'TITLE',
          'HINT',
          'NEW',
          'NEW_TITLE',
          'EDIT_TITLE',
          'DELETE_CONFIRM',
          'EMPTY',
          'EMPTY_MESSAGE',
        ]) {
          expected.push(`CATALOG.${section.key}.${part}`);
        }
      }
    }
    for (const action of ['SUSPEND', 'REACTIVATE', 'TRASH', 'RESTORE']) {
      for (const part of ['TITLE', 'CONFIRM', 'LABEL', 'DONE', 'ALREADY']) {
        expected.push(`GROUP_ACTIONS.${part}.${action}`);
      }
    }
    for (const key of ['CARDTYPES', 'POINTSCOLLECTIONS', 'OTHER']) {
      expected.push(`CATALOG.REFERENCED.${key}`);
    }
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the texts of the point of sale, the permission modules and the form sections', () => {
    const keys = dictionary('it');
    const expected: string[] = [];
    for (const flag of POS_FLAGS) {
      expected.push(`USERS.POS.GRANT.${posKey(flag)}`);
    }
    for (const group of POS_GRANT_GROUPS) {
      expected.push(`USERS.POS.GRANT_GROUP.${group.id}`);
    }
    for (const group of POS_OPTION_GROUPS) {
      expected.push(`USERS.POS.OPTION_GROUP.${group.id}`);
    }
    for (const option of POS_BOOLEAN_OPTIONS) {
      expected.push(`USERS.POS.OPTION.${posKey(option)}`);
    }
    for (const device of AUTOMATIC_CASH_DEVICES) {
      expected.push(`USERS.POS.DEVICE.${posKey(device)}`);
      for (const flag of AUTOMATIC_CASH[device]) {
        expected.push(`USERS.POS.AUTOMATIC_FLAG.${posKey(flag)}`);
      }
    }
    for (const name of POS_CHOICE_NAMES) {
      expected.push(`USERS.POS.CHOICE.${posKey(name)}`);
      const numeric = name.startsWith('rooms');
      for (const value of POS_CHOICES[name].filter((item) => item !== '' && !numeric)) {
        expected.push(
          `USERS.POS.CHOICE_VALUE.${posKey(name)}.${value.toUpperCase().replace(/-/g, '_')}`,
        );
      }
    }
    for (const module of PERMISSION_MODULES) {
      expected.push(`USERS.MODULE.${module.toUpperCase()}`);
    }
    for (const section of ['PROFILE', 'ACCESS', 'SCOPE', 'PERMISSIONS', 'POS', 'SHIFTS']) {
      expected.push(`USERS.SECTION.${section}`);
    }
    for (const day of SHIFT_DAY_KEYS) {
      expected.push(`USERS.SHIFTS.DAY.${day}`);
    }
    for (const problem of ['TYPE', 'READ', 'SIZE']) {
      expected.push(`AVATAR.PROBLEM.${problem}`);
    }
    for (const part of ['START', 'END']) {
      expected.push(`USERS.SHIFTS.SLOT_${part}`);
    }
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the texts of the fidelity, favorites and promotion pages, whose keys are built at run time', () => {
    const keys = dictionary('it');
    const expected: string[] = [];
    for (const kind of [
      'CARD_TYPES',
      'POINTS_COLLECTIONS',
      'PRIZE_CATALOGUES',
      'PRODUCT_FAVORITES',
      'PROMOTIONS',
    ]) {
      for (const part of [
        'TITLE',
        'HINT',
        'NEW',
        'NEW_TITLE',
        'EDIT_TITLE',
        'DELETE_CONFIRM',
        'EMPTY',
        'EMPTY_MESSAGE',
      ]) {
        expected.push(`CATALOG.${kind}.${part}`);
      }
    }
    for (const value of ['TAX_INCLUDED', 'TAX_EXCLUDED']) {
      expected.push(`CATALOG.PROMOTIONS.AMOUNT_TAX.${value}`);
    }
    for (const value of ['ONLY_N', 'ALL']) {
      expected.push(`CATALOG.PROMOTIONS.SELECTION.${value}`);
    }
    for (const value of ['ON_TOTAL', 'ON_PRODUCTS', 'ON_CATEGORIES']) {
      expected.push(`CATALOG.PROMOTIONS.DISCOUNT_TYPE.${value}`);
    }
    for (const value of ['PERCENTAGE', 'AMOUNT']) {
      expected.push(`CATALOG.PROMOTIONS.DISCOUNT_VALUE_TYPE.${value}`);
    }
    for (const section of PROMOTION_SECTIONS) {
      expected.push(`CATALOG.PROMOTIONS.SECTION.${section.toUpperCase()}`);
    }
    for (const value of ['MULTI', 'MONO']) {
      expected.push(`CATALOG.CARD_TYPES.PREPAID.${value}`);
    }
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the role names, whose keys are built at run time', () => {
    for (const role of ['PSA', 'D', 'SA', 'CA', 'PA', 'E']) {
      expect(dictionary('it').has(`ROLE.${role}`)).toBe(true);
    }
  });
});

/**
 * Visible text in templates must come from the dictionary. Text outside interpolations is only
 * allowed for the listed (path, text) exceptions, each with its justification.
 */
const HARD_WIRED_TEXT_EXCEPTIONS: { path: string; text: string; reason: string }[] = [];

describe('templates', () => {
  it('contain no hard-wired visible text outside interpolations', () => {
    const offenders: string[] = [];
    for (const { path, content } of sources.filter((s) => s.path.endsWith('.html'))) {
      const stripped = content
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{\{[\s\S]*?\}\}/g, '')
        .replace(
          /@(if|else if|for|switch|case|default|empty|defer|placeholder|loading|error)\b[^{]*\{/g,
          '',
        )
        .replace(/@else\s*\{/g, '')
        .replace(/@let\s[^;]*;/g, '');
      for (const [, text] of stripped.matchAll(/>([^<>]+)</g)) {
        const trimmed = text.replace(/[{}]/g, '').trim();
        const allowed = HARD_WIRED_TEXT_EXCEPTIONS.some(
          (e) => path.endsWith(e.path) && e.text === trimmed,
        );
        if (trimmed !== '' && !allowed) {
          offenders.push(`${path}: ${trimmed}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
