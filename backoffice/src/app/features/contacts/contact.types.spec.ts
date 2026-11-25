import {
  CONTACT_KINDS,
  contactLabel,
  contactRoute,
  DEFAULT_KIND,
  PAYMENT_METHODS,
  TAX_REGIMES,
} from './contact.types';

describe('contact types', () => {
  it('lists the kinds of the tabs, the customers first', () => {
    expect(CONTACT_KINDS).toEqual(['customers', 'suppliers', 'others', 'all']);
    expect(DEFAULT_KIND).toBe('customers');
  });

  it('has the 23 payment methods MP01 to MP23', () => {
    expect(PAYMENT_METHODS).toHaveLength(23);
    expect(PAYMENT_METHODS[0]).toBe('MP01');
    expect(PAYMENT_METHODS[8]).toBe('MP09');
    expect(PAYMENT_METHODS[22]).toBe('MP23');
  });

  it('has the tax regimes without the repealed RF03', () => {
    expect(TAX_REGIMES).toHaveLength(18);
    expect(TAX_REGIMES).not.toContain('RF03');
    expect(TAX_REGIMES.slice(0, 3)).toEqual(['RF01', 'RF02', 'RF04']);
    expect(TAX_REGIMES[17]).toBe('RF19');
  });

  describe('contactRoute', () => {
    it('is the list without a contact', () => {
      expect(contactRoute('g1')).toEqual(['/groups', 'g1', 'contacts']);
    });

    it('is the page of a new contact for null', () => {
      expect(contactRoute('g1', null)).toEqual(['/groups', 'g1', 'contacts', 'new']);
    });

    it('is the page of a contact for an id', () => {
      expect(contactRoute('g1', 'c1')).toEqual(['/groups', 'g1', 'contacts', 'c1']);
    });
  });

  describe('contactLabel', () => {
    it('prefers the display name, then the code, then a short id', () => {
      expect(contactLabel({ id: 'abcdef123456', displayName: 'Anna Verdi', code: 'C1' })).toBe(
        'Anna Verdi',
      );
      expect(contactLabel({ id: 'abcdef123456', displayName: null, code: 'C1' })).toBe('C1');
      expect(contactLabel({ id: 'abcdef123456', displayName: null, code: '' })).toBe('…123456');
    });
  });
});
