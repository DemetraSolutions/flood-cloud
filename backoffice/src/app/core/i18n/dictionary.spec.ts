import { flattenDictionary, interpolate } from './dictionary';

describe('flattenDictionary', () => {
  it('flattens nested objects into dotted keys', () => {
    const flat = flattenDictionary({ A: { B: 'x', C: { D: 'y' } }, E: 'z' });
    expect(Object.fromEntries(flat)).toEqual({ 'A.B': 'x', 'A.C.D': 'y', E: 'z' });
  });

  it.each([
    ['a non-object root', 'x'],
    ['a null root', null],
    ['an array root', []],
    ['a numeric leaf', { A: 1 }],
    ['a null leaf', { A: { B: null } }],
    ['an array leaf', { A: ['x'] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => flattenDictionary(raw)).toThrow(/Invalid dictionary/);
  });
});

describe('interpolate', () => {
  it('replaces placeholders with the given values', () => {
    expect(interpolate('Ciao {name}, {count} nuovi', { name: 'Anna', count: 3 })).toBe(
      'Ciao Anna, 3 nuovi',
    );
  });

  it('keeps placeholders without a parameter', () => {
    expect(interpolate('Ciao {name}', {})).toBe('Ciao {name}');
  });

  it('does not interpret inherited properties as parameters', () => {
    expect(interpolate('{toString}', {})).toBe('{toString}');
  });
});
