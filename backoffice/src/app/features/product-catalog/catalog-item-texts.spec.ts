import { CATALOG_LIMITS } from './product-catalog.types';
import { textIssues } from './catalog-item-texts';

describe('textIssues', () => {
  it('accepts a name in the required language', () => {
    expect(textIssues({ it: 'Bibite', en: '' }, { it: '' }, 'it', true)).toEqual([]);
  });

  it('requires the language when the entry must have it, or when there is no name at all', () => {
    expect(textIssues({ it: ' ', en: 'Drinks' }, {}, 'it', true)).toEqual([
      { part: 'name', language: 'it', issue: 'required' },
    ]);
    expect(textIssues({ it: '', en: '' }, {}, 'it', false)).toEqual([
      { part: 'name', language: 'it', issue: 'required' },
    ]);
  });

  it('lets an old entry without the required language keep the other names', () => {
    expect(textIssues({ it: '', en: 'Drinks' }, {}, 'it', false)).toEqual([]);
  });

  it('does not require other languages', () => {
    expect(textIssues({ it: 'a', en: '' }, {}, 'it', true)).toEqual([]);
  });

  it('refuses a name that is too long or has a control character', () => {
    expect(
      textIssues({ it: 'a'.repeat(CATALOG_LIMITS.name + 1), en: 'a\tb' }, {}, 'it', true),
    ).toEqual([
      { part: 'name', language: 'it', issue: 'maxLength' },
      { part: 'name', language: 'en', issue: 'pattern' },
    ]);
    expect(textIssues({ it: 'a'.repeat(CATALOG_LIMITS.name) }, {}, 'it', true)).toEqual([]);
  });

  it('refuses a description that is too long or has a control character, allowing line breaks', () => {
    expect(
      textIssues(
        { it: 'a' },
        { it: 'a'.repeat(CATALOG_LIMITS.description + 1), en: 'a\u0001', de: 'riga\nriga' },
        'it',
        true,
      ),
    ).toEqual([
      { part: 'description', language: 'it', issue: 'maxLength' },
      { part: 'description', language: 'en', issue: 'pattern' },
    ]);
  });
});
