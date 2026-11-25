import { formPath, sectionOf } from './contact-page';

describe('sectionOf', () => {
  it.each([
    ['code', 'general'],
    ['notes', 'general'],
    ['contactGroupId', 'general'],
    ['priceListId', 'general'],
    ['customer', 'general'],
    ['person', 'person'],
    ['person.firstName', 'person'],
    ['person.address.city', 'person'],
    ['company', 'company'],
    ['company.vatNumber', 'company'],
    ['company.supplierPriceLists.0.name', 'company'],
    ['eInvoicing.recipientCode', 'company'],
    ['products.665f1c2e9b1d4a0012ab3701', 'company'],
    ['fidelityCards.0.code', 'fidelity'],
    ['fidelityCards', 'fidelity'],
    ['services.0.duration', 'services'],
    ['account.email', 'account'],
    ['account', 'general'],
    ['unknown.field', 'general'],
  ])('puts %s in the tab %s', (field, section) => {
    expect(sectionOf(field)).toBe(section);
  });
});

describe('formPath', () => {
  it.each([
    ['person.phones.2', 'person.phones'],
    ['person.emails', 'person.emails'],
    ['company.phones.0', 'company.phones'],
    ['company.emails.1', 'company.emails'],
    ['company.faxes.0', 'company.faxes'],
    ['company.supplierPriceLists.1.name', 'company.supplierPriceLists'],
    ['fidelityCards.0.code', 'cards'],
    ['fidelityCards', 'cards'],
    ['services.3.duration', 'services'],
    ['products.665f1c2e9b1d4a0012ab3701', 'company.supplierPriceLists'],
    ['code', 'code'],
    ['person.firstName', 'person.firstName'],
    ['account.email', 'account.email'],
  ])('maps the field %s of the server to %s in the form', (field, path) => {
    expect(formPath(field)).toBe(path);
  });
});
