import { createBody, patchBody, toModel } from './contact-group-model';
import { ContactGroup } from './contact-group.types';

const GROUP: ContactGroup = {
  id: 'cg1',
  name: 'Regulars',
  priceListId: 'pl1',
  discountPercent: 7.5,
  contactsCount: 3,
  createdAt: null,
  updatedAt: null,
};

describe('toModel', () => {
  it('is the empty form for a new group', () => {
    expect(toModel(null)).toEqual({ name: '', priceListId: '', discountPercent: '' });
  });

  it('takes the fields of the group as text', () => {
    expect(toModel(GROUP)).toEqual({
      name: 'Regulars',
      priceListId: 'pl1',
      discountPercent: '7.5',
    });
  });

  it('shows no price list and no discount as empty', () => {
    expect(toModel({ ...GROUP, priceListId: null, discountPercent: null })).toEqual({
      name: 'Regulars',
      priceListId: '',
      discountPercent: '',
    });
  });
});

describe('createBody', () => {
  it('sends the three fields, trimmed, with null for the empty ones', () => {
    expect(createBody({ name: '  Regulars ', priceListId: '', discountPercent: ' ' })).toEqual({
      name: 'Regulars',
      priceListId: null,
      discountPercent: null,
    });
    expect(createBody({ name: 'A', priceListId: 'pl1', discountPercent: '10' })).toEqual({
      name: 'A',
      priceListId: 'pl1',
      discountPercent: 10,
    });
  });
});

describe('patchBody', () => {
  const before = toModel(GROUP);

  it('is empty when nothing changed', () => {
    expect(patchBody({ ...before, name: ' Regulars ' }, before)).toEqual({});
  });

  it('has only the fields that changed', () => {
    expect(patchBody({ ...before, name: 'VIP' }, before)).toEqual({ name: 'VIP' });
    expect(patchBody({ ...before, priceListId: '' }, before)).toEqual({ priceListId: null });
    expect(patchBody({ ...before, discountPercent: '' }, before)).toEqual({
      discountPercent: null,
    });
    expect(patchBody({ name: 'VIP', priceListId: 'pl2', discountPercent: '0' }, before)).toEqual({
      name: 'VIP',
      priceListId: 'pl2',
      discountPercent: 0,
    });
  });
});
