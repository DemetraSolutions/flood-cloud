import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import { REFERENCE_KINDS } from './category-errors';

/** Keys the pages build at runtime, which the key scan cannot see. */
const dictionary = flattenDictionary(
  JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
);

describe('category texts', () => {
  it.each(REFERENCE_KINDS)('has the reference text of %s', (kind) => {
    expect(dictionary.get(`PRODUCT_CATEGORIES.REFERENCE.${kind}`)).toBeTruthy();
  });

  it.each(['GENERAL', 'VARIANTS', 'STATIONS', 'AVAILABILITY', 'MEDIA'])('has the section %s', (section) => {
    expect(dictionary.get(`PRODUCT_CATEGORIES.SECTION.${section}`)).toBeTruthy();
  });

  it.each(['YES', 'NO'])('has the common answer %s of the "available at the till" column', (answer) => {
    expect(dictionary.get(`COMMON.${answer}`)).toBeTruthy();
  });

  it.each(['OTHER', 'FOOD', 'BEVERAGE'])('has the dining type %s', (type) => {
    expect(dictionary.get(`PRODUCT_CATEGORIES.DINING.TYPE_${type}`)).toBeTruthy();
  });
});
