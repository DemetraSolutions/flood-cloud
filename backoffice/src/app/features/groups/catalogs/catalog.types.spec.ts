import { VAT_NATURES, vatNatureDescription } from './catalog.types';

describe('vatNatureDescription', () => {
  it('returns the official description of a known nature', () => {
    expect(vatNatureDescription('N4')).toBe('Operazioni esenti');
  });

  it('returns null for an unknown code', () => {
    expect(vatNatureDescription('X9')).toBeNull();
  });

  it('knows every listed nature', () => {
    for (const nature of VAT_NATURES) {
      expect(vatNatureDescription(nature.code)).toBe(nature.description);
    }
  });
});
