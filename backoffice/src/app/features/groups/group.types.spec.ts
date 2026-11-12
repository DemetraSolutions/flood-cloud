import { fakeGroup } from '../../../testing/groups';
import {
  buildGeneralPatch,
  GeneralModel,
  generalFieldOf,
  textOrNull,
  toGeneralModel,
} from './group.types';

describe('group types', () => {
  describe('textOrNull', () => {
    it('trims text and turns blank text into null', () => {
      expect(textOrNull('  abc ')).toBe('abc');
      expect(textOrNull('   ')).toBeNull();
      expect(textOrNull('')).toBeNull();
    });
  });

  describe('toGeneralModel', () => {
    it('copies a stored group into an editable model', () => {
      const group = fakeGroup({ demo: true });
      const model = toGeneralModel(group);
      expect(model).toEqual({
        name: 'Gruppo Esempio',
        description: 'Descrizione di esempio',
        languages: ['it', 'en'],
        openingTime: '06:00',
        compressProductsCategories: false,
        timeSlots: [{ from: '06:00', to: '12:00' }],
        demo: true,
      });
      model.languages.push('fr');
      model.timeSlots[0].to = '13:00';
      expect(group.languages).toEqual(['it', 'en']);
      expect(group.statsSettings.timeSlots[0].to).toBe('12:00');
    });

    it('uses empty values for null fields and while the group is not loaded', () => {
      const empty: GeneralModel = {
        name: '',
        description: '',
        languages: [],
        openingTime: '',
        compressProductsCategories: false,
        timeSlots: [],
        demo: false,
      };
      expect(toGeneralModel(null)).toEqual(empty);
      const group = fakeGroup({
        description: null,
        statsSettings: { openingTime: null, compressProductsCategories: true, timeSlots: [] },
      });
      expect(toGeneralModel(group)).toEqual({
        ...empty,
        name: 'Gruppo Esempio',
        languages: ['it', 'en'],
        compressProductsCategories: true,
      });
    });
  });

  describe('buildGeneralPatch', () => {
    const group = fakeGroup();

    it('is empty when nothing changed', () => {
      expect(buildGeneralPatch(toGeneralModel(group), group, true)).toEqual({});
    });

    it('contains only what changed', () => {
      const model = {
        ...toGeneralModel(group),
        name: '  Nuovo ',
        description: '',
        languages: ['it'],
        openingTime: '',
        compressProductsCategories: true,
        timeSlots: [{ from: '06:00', to: '13:00' }],
        demo: true,
      };
      expect(buildGeneralPatch(model, group, true)).toEqual({
        name: 'Nuovo',
        description: null,
        languages: ['it'],
        statsSettings: {
          openingTime: null,
          compressProductsCategories: true,
          timeSlots: [{ from: '06:00', to: '13:00' }],
        },
        demo: true,
      });
    });

    it('detects a different number of slots, of languages or a different order', () => {
      const base = toGeneralModel(group);
      expect(
        buildGeneralPatch(
          { ...base, timeSlots: [...base.timeSlots, { from: '13:00', to: '14:00' }] },
          group,
          false,
        ).statsSettings?.timeSlots,
      ).toHaveLength(2);
      expect(
        buildGeneralPatch({ ...base, timeSlots: [{ from: '07:00', to: '12:00' }] }, group, false)
          .statsSettings?.timeSlots,
      ).toEqual([{ from: '07:00', to: '12:00' }]);
      expect(
        buildGeneralPatch({ ...base, languages: ['en', 'it'] }, group, false).languages,
      ).toEqual(['en', 'it']);
      expect(
        buildGeneralPatch({ ...base, languages: ['it', 'en', 'fr'] }, group, false).languages,
      ).toEqual(['it', 'en', 'fr']);
    });

    it('leaves demo out when the user may not change it', () => {
      const model = { ...toGeneralModel(group), demo: true };
      expect(buildGeneralPatch(model, group, false)).toEqual({});
    });
  });

  describe('generalFieldOf', () => {
    it.each([
      ['name', 'name'],
      ['statsSettings.openingTime', 'openingTime'],
      ['languages.2', 'languages'],
      ['statsSettings.timeSlots.1.to', 'timeSlots'],
    ])('maps %s to %s', (field, expected) => {
      expect(generalFieldOf(field)).toBe(expected);
    });
  });
});
