import { readdirSync, readFileSync } from 'node:fs';
import { API_ERROR_CODES, CLIENT_ERROR_CODES } from '../api/api.types';
import { FIELD_ISSUES, issueMessageKey } from '../api/field-issues';
import { SOURCE_KEYS } from '../../features/security-policy/security-policy-page';
import { WAIT_KEYS } from '../../shared/forms/form-errors';
import { FEATURE_NAMES, featureTextKey } from '../groups/feature-catalog';
import { GROUP_SECTIONS } from '../../features/groups/group-settings';
import { PROMOTION_SECTIONS } from '../../features/groups/catalogs/promotion-model';
import { INTEGRATION_PROVIDERS } from '../../features/groups/group.types';
import {
  permissionTextKey,
  PUBLIC_PERMISSIONS,
} from '../../features/groups/public-api/api-key.types';
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
import { COMPANY_SECTIONS, ECOMMERCE_FLAGS } from '../../features/companies/company.types';
import {
  PLACE_TABS,
  SETTINGS_ENTRIES,
  SETTINGS_MENU_GROUPS,
} from '../../features/places/place-nav';
import { TEMPLATE_MODELS } from '../../features/email-templates/template-models';
import { importProblems } from '../../features/tobaccos/tobaccos.types';
import { RULE_KEYS } from '../../features/catalog-xlsx/catalog-xlsx-page';
import { ROW_ERROR_CODES, rowErrorKey } from '../../features/catalog-xlsx/catalog-xlsx.types';
import { COUNT_KEYS } from '../../features/tobacco-sync/tobacco-sync-counts';
import { CONFLICT_REASONS } from '../../features/tobacco-sync/tobacco-sync-errors';
import { reasonKey, UNAVAILABLE_REASONS } from '../../features/tobacco-sync/tobacco-sync.types';
import {
  ACTION_TEXTS,
  CONFLICT_KEYS,
  FLAG_KEYS,
  PROVIDER_KEYS,
  STATEMENT_SECTIONS,
} from '../../features/activations/activations.types';
import { SERVICE_LABEL_KEYS } from '../../features/price-list/price-list.types';
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
      if (section.path !== 'public-api' && section.path.match(/-|^taxes|^currencies/) !== null) {
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

  it('defines the texts of the public API keys, whose keys are built at run time', () => {
    const keys = dictionary('it');
    const expected: string[] = [];
    for (const permission of PUBLIC_PERMISSIONS) {
      expected.push(permissionTextKey(permission, 'LABEL'), permissionTextKey(permission, 'HINT'));
    }
    for (const status of ['ACTIVE', 'REVOKED', 'EXPIRED']) {
      expected.push(`PUBLIC_API.STATUS.${status}`);
    }
    for (const kind of ['SYSTEM', 'ANONYMOUS', 'USER', 'STORE', 'API_KEY']) {
      expected.push(`ACTIVITY.ACTOR.${kind}`);
    }
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the texts of the security alerts, whose keys are chosen at run time', () => {
    const keys = dictionary('it');
    const expected = [
      'LAYOUT.ALERTS_ONE',
      'LAYOUT.ALERTS_OTHER',
      ...['NOTICE_ONE', 'NOTICE_OTHER', 'DETAIL', 'WINDOW_HOUR', 'WINDOW_DAY'].map(
        (part) => `ACTIVITY.ALERTS.${part}`,
      ),
      ...[
        'CODE_FOR_ACTIVE',
        'KEY_REPLACED',
        'MODE_REPORT',
        'MODE_ENFORCE',
        'SHOW',
        'MARK_SEEN',
        'SEEN_DONE',
        'REGION',
      ].map((part) => `ACTIVITY.ALERTS.${part}`),
    ];
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the texts of the tobacco synchronization chosen at run time: reasons, conflicts and counts', () => {
    const keys = dictionary('it');
    const expected = [
      ...[...UNAVAILABLE_REASONS, 'unknown'].map(reasonKey),
      ...CONFLICT_REASONS.map((reason) => `TOBACCO_SYNC.ERROR.CONFLICT.${reason}`),
      'TOBACCO_SYNC.ERROR.CONFLICT.other',
      ...COUNT_KEYS.map((key) => `TOBACCO_SYNC.COUNT.${key}`),
    ];
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the text of every problem code of the catalog import and nothing else under ROW_ERROR, and the rules of the file', () => {
    const keys = dictionary('it');
    expect(ROW_ERROR_CODES.map(rowErrorKey).filter((key) => !keys.has(key))).toEqual([]);
    const defined = [...keys.keys()].filter((key) => key.startsWith('CATALOG_XLSX.ROW_ERROR.'));
    expect(defined.sort()).toEqual(ROW_ERROR_CODES.map(rowErrorKey).sort());
    expect(RULE_KEYS.map((rule) => `CATALOG_XLSX.RULES.${rule}`).filter((key) => !keys.has(key))).toEqual([]);
    for (const sheet of ['PRODUCTS', 'VARIANTS', 'CATEGORIES']) {
      expect(keys.has(`CATALOG_XLSX.SHEET.${sheet}`)).toBe(true);
    }
    for (const field of ['INSERTED', 'UPDATED', 'REMOVED', 'UNCHANGED']) {
      expect(keys.has(`CATALOG_XLSX.COUNTS.${field}`)).toBe(true);
    }
  });

  it('defines the names of the e-mail template models, whose keys are built at run time', () => {
    const keys = dictionary('it');
    expect(TEMPLATE_MODELS.filter((model) => !keys.has(model.labelKey))).toEqual([]);
  });

  it('defines the names of the columns of the tobacco price list a refused import points at, whose keys are built at run time', () => {
    const keys = dictionary('it');
    const columns = [
      'category',
      'code',
      'name',
      'shortName',
      'priceKg',
      'price',
      'unitWeight',
      'numPieces',
      'description',
    ];
    const problems = importProblems([
      ...columns.map((field) => ({ field: `rows[2].${field}`, issue: 'type' })),
      { field: 'rows[2].barcodes[0].barcode', issue: 'type' },
      { field: 'rows[2].barcodes[0].quantity', issue: 'type' },
    ]);
    expect(problems).toHaveLength(columns.length + 2);
    expect(problems.filter((problem) => !keys.has(problem.columnKey))).toEqual([]);
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
      const numeric =
        name.startsWith('rooms') ||
        name === 'handheldTextZoom' ||
        name === 'handheldCategoriesRows';
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

  it('defines the texts of the company pages, whose keys are built at run time', () => {
    const keys = dictionary('it');
    const expected: string[] = [];
    for (const section of COMPANY_SECTIONS) {
      expected.push(`COMPANIES.SECTION.${section.key}`);
    }
    for (const flag of ECOMMERCE_FLAGS) {
      expected.push(
        `COMPANIES.CUSTOMER_APP.FLAG.${flag.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`,
      );
    }
    for (const action of ['TRASH', 'RESTORE', 'DELETE']) {
      for (const part of ['TITLE', 'CONFIRM', 'LABEL', 'DONE']) {
        expected.push(`COMPANIES.ACTION.${part}.${action}`);
      }
    }
    for (const code of ['SU', 'SM']) {
      expected.push(`COMPANIES.E_INVOICING.SHAREHOLDERS.${code}`);
    }
    for (const code of ['LS', 'LN']) {
      expected.push(`COMPANIES.E_INVOICING.LIQUIDATION.${code}`);
    }
    for (const key of [
      'COMPANIES.NUMBERING.CERVED_HINT',
      'COMPANIES.RESERVED_NOTE',
      'COMPANIES.NUMBERING.PREFIX',
      'COMPANIES.NUMBERING.SUFFIX',
      'COMPANIES.STATUS.ACTIVE',
      'COMPANIES.STATUS.DISABLED',
      'COMPANIES.NEW_TITLE',
      'COMPANIES.CREATE',
      'COMPANIES.MEDIA.FILE_TYPE',
      'COMPANIES.MEDIA.FILE_SIZE',
    ]) {
      expected.push(key);
    }
    for (const part of [
      'TOO_LARGE',
      'UNSUPPORTED',
      'INVALID',
      'RATE_LIMITED',
      'RATE_LIMITED_WAIT',
      'UNAVAILABLE',
    ]) {
      expected.push(`COMPANIES.MEDIA.UPLOAD_ERROR.${part}`);
    }
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the texts of the place page, whose keys are built at run time', () => {
    const keys = dictionary('it');
    const expected = [
      ...PLACE_TABS.map((tab) => `PLACES.SECTION.${tab.key}`),
      ...SETTINGS_ENTRIES.map((entry) => `PLACES.MENU.${entry.key}`),
      ...SETTINGS_MENU_GROUPS.map((group) => `PLACES.MENU_GROUP.${group}`),
    ];
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('defines the texts of the activations, whose keys are built at run time', () => {
    const keys = dictionary('it');
    const expected = [
      ...Object.values(SERVICE_LABEL_KEYS),
      ...Object.values(FLAG_KEYS),
      ...Object.values(PROVIDER_KEYS),
      ...['MONTH', 'ORDER'].map((part) => `ACTIVATIONS.DETAIL.ERROR.${part}`),
      ...['INVOICES', 'DETAIL'].map((part) => `ACTIVATIONS.TAB.${part}`),
      ...Object.values(CONFLICT_KEYS),
      ...Object.values(ACTION_TEXTS).flatMap((texts) => Object.values(texts)),
      ...STATEMENT_SECTIONS.map((id) => `ACTIVATIONS.STATEMENT.TAB.${id.toUpperCase()}`),
    ];
    expect(expected.length).toBeGreaterThan(20);
    expect(expected.filter((key) => !keys.has(key))).toEqual([]);
  });
});
