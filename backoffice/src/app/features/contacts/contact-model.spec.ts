import {
  birthDateIssue,
  cardCodeIssue,
  BodyContext,
  cardsIssue,
  ContactModel,
  createBody,
  discountIssue,
  durationIssue,
  emailIssue,
  lineIssue,
  listIssue,
  modelChanged,
  notesIssue,
  patchBody,
  phoneIssue,
  recipientCodeIssue,
  servicesIssue,
  supplierListsIssue,
  toModel,
} from './contact-model';
import { Contact } from './contact.types';

const ADDRESS = {
  street: 'Via Roma 1',
  postcode: '20100',
  city: 'Milano',
  countryCode: 'IT',
  areaCode: 'MI',
};

const CONTACT: Contact = {
  id: 'c1',
  code: 'C-1',
  customer: true,
  supplier: false,
  contactGroupId: 'cg1',
  priceListId: 'pl1',
  notes: 'Note',
  person: {
    firstName: 'Anna',
    lastName: 'Verdi',
    taxCode: 'VRDNNA80A41F205X',
    birthDate: '1980-01-01',
    address: ADDRESS,
    phones: ['+39 02 1234567'],
    emails: ['anna@example.com'],
    discountPercent: 5,
    associatedCompanyId: 'co1',
  },
  company: {
    name: 'Verdi Srl',
    vatNumber: '12345678901',
    taxCode: '12345678901',
    address: ADDRESS,
    phones: ['02 7654321'],
    emails: ['info@example.com'],
    faxes: ['02 1111111'],
    discountPercent: 10.5,
    supplierPriceLists: [{ id: 'l1', name: 'Listino', favorite: true }],
  },
  eInvoicing: {
    transmissionFormat: 'FPA12',
    channel: 'PEC',
    recipientCode: 'ABC1234',
    pec: 'pec@example.com',
    paymentTerms: 'TP02',
    paymentMethod: 'MP05',
    taxRegime: 'RF01',
    administrationReference: 'REF',
    splitPayment: true,
    requirePurchaseOrderData: true,
  },
  fidelityCards: [
    { code: 'K1', points: 10, advanced: null },
    {
      code: 'K2',
      points: 0,
      advanced: { cardId: 'ac1', cardType: null, enabled: true, balance: 3, totalPoints: 9 },
    },
  ],
  services: [{ productId: 's1', duration: '01:30' }],
  account: { email: 'acc@example.com', phone: '+39 333 1234567' },
  displayName: 'Verdi Srl',
  trashed: false,
  trashedAt: null,
  createdAt: null,
  updatedAt: null,
};

const NO_SERVICES: BodyContext = { services: false };
const SERVICES: BodyContext = { services: true };

describe('toModel', () => {
  it('starts a new contact empty, with the defaults of the e-invoice', () => {
    const model = toModel(null);
    expect(model).toMatchObject({
      code: '',
      customer: true,
      supplier: false,
      notes: '',
      cards: [],
      services: [],
      account: { email: '', phone: '' },
    });
    expect(model.person).toMatchObject({
      firstName: '',
      birthDate: '',
      discountPercent: '',
      phones: [],
    });
    expect(model.person.address).toEqual({
      street: '',
      postcode: '',
      city: '',
      countryCode: '',
      areaCode: '',
    });
    expect(model.company.supplierPriceLists).toEqual([]);
    expect(model.eInvoicing).toMatchObject({
      transmissionFormat: 'FPR12',
      channel: 'CD',
      recipientCode: '',
      splitPayment: false,
      requirePurchaseOrderData: false,
    });
  });

  it('decides the role of a new contact from the tab it was opened from', () => {
    expect(toModel(null, 'customers')).toMatchObject({ customer: true, supplier: false });
    expect(toModel(null, 'all')).toMatchObject({ customer: true, supplier: false });
    expect(toModel(null, 'suppliers')).toMatchObject({ customer: false, supplier: true });
    expect(toModel(null, 'others')).toMatchObject({ customer: false, supplier: false });
  });

  it('copies a contact into texts, with the codes of the cards and the durations', () => {
    const model = toModel(CONTACT, 'suppliers');
    expect(model.customer).toBe(true);
    expect(model.supplier).toBe(false);
    expect(model.code).toBe('C-1');
    expect(model.contactGroupId).toBe('cg1');
    expect(model.person.discountPercent).toBe('5');
    expect(model.person.address.areaCode).toBe('MI');
    expect(model.company.discountPercent).toBe('10.5');
    expect(model.company.supplierPriceLists).toEqual([
      { id: 'l1', name: 'Listino', favorite: true },
    ]);
    expect(model.company.supplierPriceLists[0]).not.toBe(CONTACT.company.supplierPriceLists[0]);
    expect(model.eInvoicing.channel).toBe('PEC');
    expect(model.cards).toEqual(['K1', 'K2']);
    expect(model.services).toEqual([{ productId: 's1', duration: '01:30' }]);
    expect(model.account).toEqual({ email: 'acc@example.com', phone: '+39 333 1234567' });
  });

  it('turns the nulls of a contact into empty texts', () => {
    const bare: Contact = {
      ...CONTACT,
      contactGroupId: null,
      priceListId: null,
      notes: null,
      person: {
        ...CONTACT.person,
        birthDate: null,
        discountPercent: null,
        associatedCompanyId: null,
        address: { ...ADDRESS, countryCode: null, areaCode: null },
      },
      eInvoicing: {
        ...CONTACT.eInvoicing,
        recipientCode: null,
        pec: null,
        paymentTerms: null,
        paymentMethod: null,
        taxRegime: null,
        administrationReference: null,
      },
      services: [{ productId: 's1', duration: null }],
      account: { email: null, phone: null },
    };
    const model = toModel(bare);
    expect(model.contactGroupId).toBe('');
    expect(model.person.address.countryCode).toBe('');
    expect(model.eInvoicing.taxRegime).toBe('');
    expect(model.services).toEqual([{ productId: 's1', duration: '' }]);
    expect(model.account).toEqual({ email: '', phone: '' });
  });

  it('reads a contact without the services of a group that does not have them', () => {
    const { services: _services, ...without } = CONTACT;
    expect(toModel(without as Contact).services).toEqual([]);
  });
});

describe('createBody', () => {
  it('sends everything the user filled in, trimmed, with only the codes of the cards', () => {
    const model = toModel(CONTACT);
    model.code = '  C-2  ';
    model.person.phones = ['  ', ' 02 111 ', ''];
    model.cards = ['K1', ' ', ' K3 '];
    model.company.supplierPriceLists = [
      { id: '', name: ' Nuovo ', favorite: false },
      { id: 'l1', name: 'Listino', favorite: true },
    ];
    const body = createBody(model, NO_SERVICES);
    expect(body['code']).toBe('C-2');
    expect(body['person']).toMatchObject({
      phones: ['02 111'],
      discountPercent: 5,
      birthDate: '1980-01-01',
    });
    expect(body['fidelityCards']).toEqual([{ code: 'K1' }, { code: 'K3' }]);
    expect(body['company']).toMatchObject({
      supplierPriceLists: [
        { name: 'Nuovo', favorite: false },
        { id: 'l1', name: 'Listino', favorite: true },
      ],
    });
    expect(
      (body['company'] as { supplierPriceLists: object[] }).supplierPriceLists[0],
    ).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('services');
  });

  it('turns empty texts into nulls', () => {
    const body = createBody(toModel(null), NO_SERVICES);
    expect(body).toMatchObject({
      contactGroupId: null,
      priceListId: null,
      notes: null,
      account: { email: null, phone: null },
    });
    expect(body['person']).toMatchObject({
      birthDate: null,
      discountPercent: null,
      address: { street: '', countryCode: null, areaCode: null },
    });
    expect(body['eInvoicing']).toMatchObject({ recipientCode: null, taxRegime: null });
  });

  it('has the services only in a group that has them', () => {
    const model = toModel(CONTACT);
    expect(createBody(model, SERVICES)['services']).toEqual([
      { productId: 's1', duration: '01:30' },
    ]);
  });
});

describe('patchBody', () => {
  const edit = (change: (model: ContactModel) => void, ctx: BodyContext = NO_SERVICES) => {
    const before = toModel(CONTACT);
    const model = toModel(CONTACT);
    change(model);
    return patchBody(model, before, ctx);
  };

  it('is empty when nothing changed', () => {
    expect(edit(() => undefined, SERVICES)).toEqual({});
  });

  it('has only the leaves that changed, nested objects included', () => {
    expect(
      edit((model) => {
        model.notes = 'Altro';
        model.person.address.city = 'Roma';
        model.eInvoicing.splitPayment = false;
        model.account.email = '';
      }),
    ).toEqual({
      notes: 'Altro',
      person: { address: { city: 'Roma' } },
      eInvoicing: { splitPayment: false },
      account: { email: null },
    });
  });

  it('takes a list that changed whole', () => {
    expect(
      edit((model) => {
        model.person.emails = ['anna@example.com', 'b@example.com'];
        model.company.supplierPriceLists = [{ id: 'l1', name: 'Listino', favorite: false }];
      }),
    ).toEqual({
      person: { emails: ['anna@example.com', 'b@example.com'] },
      company: { supplierPriceLists: [{ id: 'l1', name: 'Listino', favorite: false }] },
    });
  });

  it('sends the cards as codes only, when the codes changed', () => {
    expect(edit((model) => model.cards.push('K9'))).toEqual({
      fidelityCards: [{ code: 'K1' }, { code: 'K2' }, { code: 'K9' }],
    });
    expect(edit((model) => (model.cards = ['K1', 'K2']))).toEqual({});
  });

  it('has the services only when the group has them', () => {
    const change = (model: ContactModel) =>
      (model.services = [{ productId: 's1', duration: '02:00' }]);
    expect(edit(change, NO_SERVICES)).toEqual({});
    expect(edit(change, SERVICES)).toEqual({ services: [{ productId: 's1', duration: '02:00' }] });
  });
});

describe('modelChanged', () => {
  it('compares the form with the original', () => {
    const original = toModel(null);
    expect(modelChanged(toModel(null), original)).toBe(false);
    const edited = toModel(null);
    edited.code = 'X';
    expect(modelChanged(edited, original)).toBe(true);
  });
});

describe('lineIssue', () => {
  it('accepts a line up to the maximum and an empty one', () => {
    expect(lineIssue('abc', 3)).toBeUndefined();
    expect(lineIssue('  ', 3)).toBeUndefined();
  });

  it('refuses a line that is too long, measured after trimming', () => {
    expect(lineIssue(' abcd ', 3)).toBe('maxLength');
    expect(lineIssue(' abc ', 3)).toBeUndefined();
  });

  it('refuses control characters', () => {
    expect(lineIssue('a\u0000b', 10)).toBe('pattern');
    expect(lineIssue('a\nb', 10)).toBe('pattern');
    expect(lineIssue('a\tb', 10)).toBe('pattern');
  });
});

describe('notesIssue', () => {
  it('accepts line breaks and tabs', () => {
    expect(notesIssue('uno\r\ndue\ttre')).toBeUndefined();
  });

  it('refuses a text that is too long or has other control characters', () => {
    expect(notesIssue('a'.repeat(2001))).toBe('maxLength');
    expect(notesIssue('a'.repeat(2000))).toBeUndefined();
    expect(notesIssue('a\u0007b')).toBe('pattern');
  });
});

describe('emailIssue', () => {
  it('accepts an empty text and a good address', () => {
    expect(emailIssue(' ')).toBeUndefined();
    expect(emailIssue('anna.verdi@example.com')).toBeUndefined();
  });

  it('refuses a malformed address and one that is too long', () => {
    expect(emailIssue('anna')).toBe('format');
    expect(emailIssue('anna@example')).toBe('format');
    expect(emailIssue(`${'a'.repeat(250)}@e.it`)).toBe('maxLength');
  });
});

describe('phoneIssue', () => {
  it('accepts an empty text and a number', () => {
    expect(phoneIssue('')).toBeUndefined();
    expect(phoneIssue('+39 (02) 123-4567')).toBeUndefined();
  });

  it('refuses letters, a text without digits and one that is too long', () => {
    expect(phoneIssue('02 abc')).toBe('format');
    expect(phoneIssue('+-()')).toBe('format');
    expect(phoneIssue('1'.repeat(33))).toBe('maxLength');
  });
});

describe('discountIssue', () => {
  it('accepts empty and values from 0 to 100 with up to two decimals', () => {
    expect(discountIssue('')).toBeUndefined();
    expect(discountIssue('0')).toBeUndefined();
    expect(discountIssue('12.34')).toBeUndefined();
    expect(discountIssue('100')).toBeUndefined();
  });

  it('refuses what is not a number, out of range or with more decimals', () => {
    expect(discountIssue('abc')).toBe('type');
    expect(discountIssue('-1')).toBe('minimum');
    expect(discountIssue('101')).toBe('maximum');
    expect(discountIssue('1.234')).toBe('format');
  });
});

describe('birthDateIssue', () => {
  it('accepts empty and a day that exists', () => {
    expect(birthDateIssue('')).toBeUndefined();
    expect(birthDateIssue('2024-02-29')).toBeUndefined();
  });

  it('refuses another format and a day that does not exist', () => {
    expect(birthDateIssue('01/02/2000')).toBe('incorrect');
    expect(birthDateIssue('2023-02-29')).toBe('incorrect');
    expect(birthDateIssue('2023-13-01')).toBe('incorrect');
  });
});

describe('recipientCodeIssue', () => {
  it('accepts empty and six or seven letters or digits, in any case', () => {
    expect(recipientCodeIssue('')).toBeUndefined();
    expect(recipientCodeIssue('abc123')).toBeUndefined();
    expect(recipientCodeIssue('ABC1234')).toBeUndefined();
  });

  it('refuses the wrong length or characters', () => {
    expect(recipientCodeIssue('ABC12')).toBe('format');
    expect(recipientCodeIssue('ABC12345')).toBe('format');
    expect(recipientCodeIssue('ABC-123')).toBe('format');
  });
});

describe('durationIssue', () => {
  it('needs a duration from 00:01 to 23:59', () => {
    expect(durationIssue(' ')).toBe('required');
    expect(durationIssue('00:00')).toBe('incorrect');
    expect(durationIssue('24:00')).toBe('incorrect');
    expect(durationIssue('1:30')).toBe('incorrect');
    expect(durationIssue('00:01')).toBeUndefined();
    expect(durationIssue('23:59')).toBeUndefined();
  });
});

describe('listIssue', () => {
  const none = () => undefined;

  it('ignores the empty entries when it counts', () => {
    expect(listIssue(['a', ' ', 'b'], 2, none)).toBeUndefined();
    expect(listIssue(['a', 'b', 'c'], 2, none)).toBe('tooMany');
  });

  it('refuses an entry that is not valid', () => {
    expect(listIssue(['a', 'x'], 5, (entry) => (entry === 'x' ? 'bad' : undefined))).toBe(
      'incorrect',
    );
  });

  it('folds the case by default and keeps it on request', () => {
    expect(listIssue(['A@x.it', 'a@x.it'], 5, none)).toBe('incorrect');
    expect(listIssue(['A', 'a'], 5, none, false)).toBeUndefined();
    expect(listIssue(['A', ' A '], 5, none, false)).toBe('incorrect');
  });
});

describe('supplierListsIssue', () => {
  const row = (name: string, favorite = false) => ({ id: '', name, favorite });

  it('accepts none and well formed lists', () => {
    expect(supplierListsIssue([])).toBeUndefined();
    expect(supplierListsIssue([row('A', true), row('B')])).toBeUndefined();
  });

  it('refuses too many, a missing or wrong name and more than one favorite', () => {
    expect(supplierListsIssue(Array.from({ length: 51 }, (_, i) => row(`L${i}`)))).toBe('tooMany');
    expect(supplierListsIssue([row(' ')])).toBe('incorrect');
    expect(supplierListsIssue([row('x'.repeat(101))])).toBe('incorrect');
    expect(supplierListsIssue([row('A', true), row('B', true)])).toBe('incorrect');
  });
});

describe('servicesIssue', () => {
  const row = (productId: string, duration = '01:00') => ({ productId, duration });

  it('accepts none and valid services', () => {
    expect(servicesIssue([])).toBeUndefined();
    expect(servicesIssue([row('a'), row('b', '00:30')])).toBeUndefined();
  });

  it('refuses too many, a product twice and a wrong duration', () => {
    expect(servicesIssue(Array.from({ length: 201 }, (_, i) => row(`p${i}`)))).toBe('tooMany');
    expect(servicesIssue([row('a'), row('a')])).toBe('incorrect');
    expect(servicesIssue([row('a', '')])).toBe('incorrect');
    expect(servicesIssue([row('a', '00:00')])).toBe('incorrect');
  });
});

describe('cardsIssue', () => {
  it('accepts up to 20 distinct codes', () => {
    expect(cardsIssue(['A', 'a'])).toBeUndefined();
    expect(cardsIssue([])).toBeUndefined();
  });

  it('refuses too many, a code that is too long and a repeated one', () => {
    expect(cardsIssue(Array.from({ length: 21 }, (_, i) => `K${i}`))).toBe('tooMany');
    expect(cardsIssue(['x'.repeat(65)])).toBe('incorrect');
    expect(cardsIssue(['A', 'A'])).toBe('incorrect');
  });
});

describe('cardCodeIssue', () => {
  it('refuses a code made only of dots, and checks the rest as a line', () => {
    expect(cardCodeIssue('..')).toBe('format');
    expect(cardCodeIssue(' . ')).toBe('format');
    expect(cardCodeIssue('A.1')).toBeUndefined();
    expect(cardCodeIssue('x'.repeat(65))).toBe('maxLength');
    expect(cardCodeIssue('a\nb')).toBe('pattern');
  });

  it('refuses a | in a new code but leaves a saved one alone', () => {
    expect(cardCodeIssue('A|B')).toBe('pipe');
    expect(cardCodeIssue('A|B', true)).toBeUndefined();
    expect(cardsIssue(['A|B'])).toBe('incorrect');
    expect(cardsIssue(['A|B'], ['A|B'])).toBeUndefined();
  });

  it('makes a list of cards that has such a code incorrect', () => {
    expect(cardsIssue(['K1', '...'])).toBe('incorrect');
  });
});
