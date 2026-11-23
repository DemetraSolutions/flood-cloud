import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';

/** Keys the pages build at runtime (`PRODUCT_CATALOG.<text>.<part>`), which the key scan cannot see. */
const dictionary = flattenDictionary(
  JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
);

const KIND_PARTS = [
  'TITLE',
  'HINT',
  'NEW',
  'EMPTY',
  'DELETE.TITLE',
  'DELETE.LABEL',
  'DELETE.CONFIRM',
  'DELETE.DONE',
  'DELETE.BLOCKED_TITLE',
  'DELETE.BLOCKED_MESSAGE',
  'FORM.NEW_TITLE',
  'FORM.EDIT_TITLE',
  'FORM.BACK',
  'FORM.CREATE',
  'FORM.CREATED',
  'FORM.SAVED',
];

describe('product catalog texts', () => {
  it.each(['DEPARTMENTS', 'BRANDS'])('%s has every text the pages build at runtime', (text) => {
    for (const part of KIND_PARTS) {
      expect(dictionary.get(`PRODUCT_CATALOG.${text}.${part}`), `${text}.${part}`).toBeTruthy();
    }
  });

  it('has the section and field texts built from a name', () => {
    for (const section of ['GENERAL', 'AVAILABILITY', 'MEDIA']) {
      expect(dictionary.get(`PRODUCT_CATALOG.SECTION.${section}`), section).toBeTruthy();
    }
    expect(dictionary.get('PRODUCT_CATALOG.FIELD.NAME_IN')).toContain('{language}');
    expect(dictionary.get('PRODUCT_CATALOG.FIELD.DESCRIPTION_IN')).toContain('{language}');
  });

  it('names the entry in the delete texts', () => {
    for (const text of ['DEPARTMENTS', 'BRANDS']) {
      for (const part of ['LABEL', 'CONFIRM', 'DONE', 'BLOCKED_TITLE']) {
        expect(dictionary.get(`PRODUCT_CATALOG.${text}.DELETE.${part}`)).toContain('{name}');
      }
    }
  });
});
