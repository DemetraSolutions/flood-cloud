import { XLSX_TOOL_KEYS, XLSX_TOOLS, xlsxToolRoute } from './xlsx-tools';

describe('xlsx tools', () => {
  it('describes the three workbooks', () => {
    expect([...XLSX_TOOL_KEYS]).toEqual(['catalog', 'contacts', 'cards']);
    expect(XLSX_TOOLS.contacts).toMatchObject({
      prefix: 'CONTACTS_XLSX',
      exportPath: 'contacts-export',
      importPath: 'contacts-import',
      importPermission: 'contacts:import',
      sheets: ['contacts'],
    });
    expect(XLSX_TOOLS.cards).toMatchObject({
      prefix: 'CARDS_XLSX',
      exportPath: 'fidelity-cards-export',
      importPath: 'fidelity-cards-import',
      importPermission: 'fidelityCards:import',
      sheets: ['cards'],
      showsRemoved: false,
    });
    expect(XLSX_TOOLS.catalog.sheets).toEqual(['products', 'variants', 'categories']);
  });

  it('makes the link of the page of a tool of a group', () => {
    expect(xlsxToolRoute('catalog', 'g1')).toEqual(['/groups', 'g1', 'tools', 'catalog-import-export']);
    expect(xlsxToolRoute('contacts', 'g1')).toEqual(['/groups', 'g1', 'tools', 'contacts-import-export']);
    expect(xlsxToolRoute('cards', 'g1')).toEqual([
      '/groups',
      'g1',
      'tools',
      'fidelity-cards-import-export',
    ]);
  });
});
