import {
  allLanguages,
  attributeLanguages,
  attributesBody,
  attributesChanged,
  filledTexts,
  toAttributesModel,
} from './attribute-model';
import { AttributeGroup } from './product-catalog.types';

const GROUP: AttributeGroup = {
  id: 'g1',
  name: { it: 'Taglia' },
  attributes: [
    { id: 'a1', name: { it: 'S', en: 'Small' } },
    { id: 'a2', name: { it: 'M', de: 'Mittel' } },
  ],
  createdAt: null,
  updatedAt: null,
};

describe('attribute model', () => {
  it('keeps the filled texts, trimmed', () => {
    expect(filledTexts({ it: ' a ', en: '  ', de: '' })).toEqual({ it: 'a' });
  });

  it('gives every language a text', () => {
    expect(allLanguages({ it: 'a' }, ['it', 'en'])).toEqual({ it: 'a', en: '' });
  });

  it('adds to the languages of the group the ones the attributes use, once', () => {
    expect(attributeLanguages(GROUP, ['it', 'fr'])).toEqual(['it', 'fr', 'en', 'de']);
  });

  it('builds the form model', () => {
    expect(toAttributesModel(GROUP, ['it', 'en'])).toEqual({
      attributes: [
        { id: 'a1', name: { it: 'S', en: 'Small' } },
        { id: 'a2', name: { it: 'M', en: '' } },
      ],
    });
  });

  describe('attributesChanged', () => {
    const saved = GROUP.attributes;
    const model = () => toAttributesModel(GROUP, ['it', 'en', 'de']);

    it('is false for the saved attributes, even with empty extra languages', () => {
      expect(attributesChanged(model(), saved)).toBe(false);
    });

    it('detects an addition and a removal', () => {
      const added = model();
      added.attributes.push({ id: '', name: { it: 'L' } });
      expect(attributesChanged(added, saved)).toBe(true);
      const removed = model();
      removed.attributes.pop();
      expect(attributesChanged(removed, saved)).toBe(true);
    });

    it('detects a reorder', () => {
      const reordered = model();
      reordered.attributes.reverse();
      expect(attributesChanged(reordered, saved)).toBe(true);
    });

    it('detects a rename, a new language and a removed language', () => {
      const renamed = model();
      renamed.attributes[0].name['it'] = 'XS';
      expect(attributesChanged(renamed, saved)).toBe(true);
      const translated = model();
      translated.attributes[0].name['de'] = 'Klein';
      expect(attributesChanged(translated, saved)).toBe(true);
      const emptied = model();
      emptied.attributes[0].name['en'] = '';
      expect(attributesChanged(emptied, saved)).toBe(true);
    });

    it('detects a text replaced by another language of the same count', () => {
      const swapped = model();
      swapped.attributes[0].name = { it: '', en: 'Small', de: 'S' };
      expect(attributesChanged(swapped, saved)).toBe(true);
    });
  });

  it('builds the body, leaving the id out of the new attributes', () => {
    expect(
      attributesBody({
        attributes: [
          { id: 'a1', name: { it: ' S ', en: '' } },
          { id: '', name: { it: 'L' } },
        ],
      }),
    ).toEqual({ attributes: [{ id: 'a1', name: { it: 'S' } }, { name: { it: 'L' } }] });
  });
});
