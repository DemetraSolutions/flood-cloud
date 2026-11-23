import {
  attributesRoute,
  catalogRoute,
  hasDescriptionControl,
  hasNameControl,
  isEditable,
  KINDS,
  requiredLanguage,
  taxLabel,
  textOf,
} from './product-catalog.types';

describe('product catalog types', () => {
  it('describes the two kinds', () => {
    expect(KINDS.departments).toMatchObject({ segment: 'product-departments', sortKeys: ['name', 'code'] });
    expect(KINDS.brands).toMatchObject({ segment: 'product-brands', sortKeys: ['name'] });
  });

  it('builds the router links of the list, of the new page and of one entry', () => {
    expect(catalogRoute('g1', 'departments')).toEqual(['/groups', 'g1', 'product-departments']);
    expect(catalogRoute('g1', 'brands', null)).toEqual(['/groups', 'g1', 'product-brands', 'new']);
    expect(catalogRoute('g1', 'brands', 'b1')).toEqual(['/groups', 'g1', 'product-brands', 'b1']);
    expect(attributesRoute('g1')).toEqual(['/groups', 'g1', 'product-attribute-groups']);
  });

  it('writes the tax rate with every part it has', () => {
    expect(taxLabel({ rate: 22, department: 1, vatNature: 'N1', description: 'Ordinaria' })).toBe(
      '22% - Rep.1 - N1 | Ordinaria',
    );
  });

  it('leaves out the parts the tax rate does not have', () => {
    expect(taxLabel({ rate: 10, department: null, vatNature: null, description: null })).toBe('10%');
    expect(taxLabel({ rate: null, department: 2, vatNature: null, description: null })).toBe('Rep.2');
    expect(taxLabel({ rate: null, department: null, vatNature: 'N2', description: 'x' })).toBe('N2 | x');
    expect(taxLabel({ rate: null, department: null, vatNature: null, description: null })).toBe('');
  });

  it('picks the text in the preferred language, then the first one, then nothing', () => {
    expect(textOf({ it: 'Bibite', en: 'Drinks' }, 'en')).toBe('Drinks');
    expect(textOf({ it: 'Bibite', en: 'Drinks' }, 'de')).toBe('Bibite');
    expect(textOf({}, 'it')).toBe('');
  });

  it('requires the language of the user when the group has it, otherwise the first of the group', () => {
    expect(requiredLanguage(['it', 'en'], 'en')).toBe('en');
    expect(requiredLanguage(['it', 'en'], 'de')).toBe('it');
  });

  it('finds the control characters the server refuses', () => {
    expect(hasNameControl('a\tb')).toBe(true);
    expect(hasNameControl('a\nb')).toBe(true);
    expect(hasNameControl('abc')).toBe(false);
    expect(hasDescriptionControl('a\tb\r\nc')).toBe(false);
    expect(hasDescriptionControl('a\u0001b')).toBe(true);
    expect(hasDescriptionControl('a\u007Fb')).toBe(true);
  });

  it('treats an entry as editable unless the server says otherwise', () => {
    expect(isEditable({})).toBe(true);
    expect(isEditable({ editable: true })).toBe(true);
    expect(isEditable({ editable: false })).toBe(false);
  });
});
