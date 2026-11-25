import { backend } from '../../../testing/api';
import {
  BASE,
  EDIT,
  ITEM,
  L,
  NEW,
  ContactView,
  renderContact,
} from '../../../testing/contacts-page';
import { ContactModel } from './contact-model';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

const count = (view: ContactView, tab: string, errors: number) =>
  expect(view.tab(tab)!.textContent, tab).toContain(`TAB_LIST.ERRORS {"count":${errors}}`);

const noErrors = (view: ContactView, tab: string) =>
  expect(view.tab(tab)!.textContent, tab).not.toContain('TAB_LIST.ERRORS');

/** A new contact with a name, so that only the change under test can make the form invalid. */
async function named() {
  const view = await renderContact(NEW);
  await view.type(L.firstName, 'Anna');
  return view;
}

const long = (length: number) => 'x'.repeat(length);

describe('ContactPage: the name of a new contact', () => {
  it('needs a first name or a company name: both fields say so, the tab opens and the focus moves to the first field', async () => {
    const view = await renderContact(NEW);
    await view.type(L.code, 'K1');
    await view.submit();
    backend().expectNone(BASE);
    expect(view.error(L.firstName)).toBe('FORM.ISSUE.NAME_OR_COMPANY');
    expect(view.error(L.companyName)).toBe('FORM.ISSUE.NAME_OR_COMPANY');
    count(view, 'person', 1);
    count(view, 'company', 1);
    expect(view.visible()).toEqual(['person']);
    expect(document.activeElement).toBe(view.control(L.firstName));
    expect(view.toasts()).toEqual([]);
  });

  it('is satisfied by a first name alone', async () => {
    const view = await named();
    await view.submit();
    expect(view.error(L.companyName)).toBe('');
    backend().expectOne(BASE).flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });

  it('is satisfied by a company name alone', async () => {
    const view = await renderContact(NEW);
    await view.type(L.companyName, 'Neri srl');
    await view.submit();
    expect(view.error(L.firstName)).toBe('');
    backend().expectOne(BASE).flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });

  it('is not satisfied by blanks', async () => {
    const view = await renderContact(NEW);
    await view.type(L.firstName, '   ');
    await view.type(L.companyName, ' ');
    await view.submit();
    backend().expectNone(BASE);
    expect(view.error(L.firstName)).toBe('FORM.ISSUE.NAME_OR_COMPANY');
  });

  it('is not asked of a contact that is saved with a name when the user keeps it', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    expect(view.error(L.firstName)).toBe('');
  });

  it('is asked again when both names are emptied on a saved contact', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.firstName, '');
    await view.type(L.companyName, '');
    await view.submit();
    backend().expectNone(ITEM);
    expect(view.error(L.firstName)).toBe('FORM.ISSUE.NAME_OR_COMPANY');
    expect(view.error(L.companyName)).toBe('FORM.ISSUE.NAME_OR_COMPANY');
  });
});

describe('ContactPage: the fields of the text', () => {
  it.each([
    ['the code', L.code, long(65), 'general', 'FORM.ISSUE.MAX_LENGTH'],
    ['the notes', L.notes, long(2001), 'general', 'FORM.ISSUE.MAX_LENGTH'],
    ['the first name', L.firstName, long(101), 'person', 'FORM.ISSUE.MAX_LENGTH'],
    ['the tax code of the person', L.personTaxCode, long(33), 'person', 'FORM.ISSUE.MAX_LENGTH'],
    ['the company name', L.companyName, long(201), 'company', 'FORM.ISSUE.MAX_LENGTH'],
    ['the VAT number', L.vatNumber, long(33), 'company', 'FORM.ISSUE.MAX_LENGTH'],
    ['the tax code of the company', L.companyTaxCode, long(33), 'company', 'FORM.ISSUE.MAX_LENGTH'],
    ['the code with a control character', L.code, 'a\u0001b', 'general', 'FORM.ISSUE.PATTERN'],
    ['the notes with a control character', L.notes, 'a\u0000b', 'general', 'FORM.ISSUE.PATTERN'],
    ['the e-mail of the account', L.accountEmail, 'luca@', 'account', 'FORM.ISSUE.FORMAT'],
    [
      'the e-mail of the account that is too long',
      L.accountEmail,
      `${long(250)}@a.it`,
      'account',
      'FORM.ISSUE.MAX_LENGTH',
    ],
    ['the phone of the account', L.accountPhone, 'call me', 'account', 'FORM.ISSUE.FORMAT'],
    [
      'the phone of the account without a digit',
      L.accountPhone,
      '+ ( )',
      'account',
      'FORM.ISSUE.FORMAT',
    ],
    [
      'the phone of the account that is too long',
      L.accountPhone,
      '1'.repeat(33),
      'account',
      'FORM.ISSUE.MAX_LENGTH',
    ],
  ])('refuses %s', async (_name, label, value, tab, message) => {
    const view = await named();
    await view.type(label, value);
    await view.blur(label);
    expect(view.error(label)).toBe(message);
    count(view, tab, 1);
    await view.submit();
    backend().expectNone(BASE);
    expect(view.visible()).toEqual([tab === 'general' ? 'general' : tab]);
  });

  it('accepts a valid e-mail, phone, notes with line breaks and a full-length code', async () => {
    const view = await named();
    await view.type(L.accountEmail, 'anna@example.com');
    await view.type(L.accountPhone, '+39 (02) 123-4567');
    await view.type(L.notes, 'prima riga\nseconda riga');
    await view.type(L.code, long(64));
    for (const tab of ['general', 'company', 'account']) {
      noErrors(view, tab);
    }
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual(
      expect.objectContaining({ notes: 'prima riga\nseconda riga' }),
    );
    req.flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });

  it('does not show the error of a field the user has not touched yet', async () => {
    const view = await named();
    await view.type(L.accountEmail, 'luca@');
    expect(view.error(L.accountEmail)).toBe('');
    noErrors(view, 'account');
    await view.blur(L.accountEmail);
    expect(view.error(L.accountEmail)).toBe('FORM.ISSUE.FORMAT');
    await view.type(L.accountEmail, '');
    expect(view.error(L.accountEmail)).toBe('');
  });
});

describe('ContactPage: the discounts', () => {
  it.each([
    ['101', 'FORM.ISSUE.MAXIMUM'],
    ['-1', 'FORM.ISSUE.MINIMUM'],
    ['abc', 'FORM.ISSUE.TYPE'],
    ['12.345', 'FORM.ISSUE.FORMAT'],
  ])('refuses the discount %s of the person and of the company', async (value, message) => {
    const view = await named();
    await view.type(L.personDiscount, value);
    await view.type(L.companyDiscount, value);
    await view.blur(L.personDiscount);
    await view.blur(L.companyDiscount);
    expect(view.error(L.personDiscount)).toBe(message);
    expect(view.error(L.companyDiscount)).toBe(message);
    count(view, 'person', 1);
    count(view, 'company', 1);
  });

  it.each(['0', '100', '12.5', '7.25', ''])('accepts the discount "%s"', async (value) => {
    const view = await named();
    await view.type(L.personDiscount, value);
    await view.blur(L.personDiscount);
    expect(view.error(L.personDiscount)).toBe('');
    noErrors(view, 'person');
  });

  it('sends the discount as a number', async () => {
    const view = await named();
    await view.type(L.personDiscount, '12.5');
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual(
      expect.objectContaining({ person: expect.objectContaining({ discountPercent: 12.5 }) }),
    );
    req.flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });
});

describe('ContactPage: the channel of the e-invoice', () => {
  const channel = (value: string) => (model: ContactModel) => ({
    ...model,
    eInvoicing: { ...model.eInvoicing, channel: value },
  });
  const invoicing = (patch: Partial<ContactModel['eInvoicing']>) => (model: ContactModel) => ({
    ...model,
    eInvoicing: { ...model.eInvoicing, ...patch },
  });

  it('asks for the PEC and not for the recipient code with the PEC channel', async () => {
    const view = await named();
    await view.setModel(channel('PEC'));
    expect(view.labels()).toContain(L.pec);
    expect(view.labels()).not.toContain(L.recipientCode);
    await view.type(L.pec, 'not an address');
    await view.blur(L.pec);
    expect(view.error(L.pec)).toBe('FORM.ISSUE.FORMAT');
    count(view, 'company', 1);
    await view.type(L.pec, 'anna@pec.example.com');
    noErrors(view, 'company');
  });

  it('does not check the recipient code that the PEC channel hides', async () => {
    const view = await named();
    await view.setModel(invoicing({ channel: 'PEC', recipientCode: 'AB' }));
    await view.submit();
    noErrors(view, 'company');
    backend().expectOne(BASE).flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });

  it('does not check the PEC that the CD channel hides', async () => {
    const view = await named();
    await view.setModel(invoicing({ channel: 'CD', pec: 'not an address' }));
    expect(view.labels()).toContain(L.recipientCode);
    expect(view.labels()).not.toContain(L.pec);
    await view.submit();
    noErrors(view, 'company');
    backend().expectOne(BASE).flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });
});

describe('ContactPage: the birth date and the recipient code', () => {
  it.each(['2026-02-30', '2026-13-01', '01/01/1980', 'ieri'])(
    'refuses the birth date %s',
    async (value) => {
      const view = await named();
      await view.setModel((model) => ({ ...model, person: { ...model.person, birthDate: value } }));
      await view.submit();
      backend().expectNone(BASE);
      expect(view.error(L.birthDate)).toBe('FORM.ISSUE.INCORRECT');
      count(view, 'person', 1);
      expect(view.visible()).toEqual(['person']);
    },
  );

  it('accepts a birth date that exists, a leap day included', async () => {
    const view = await named();
    await view.type(L.birthDate, '2024-02-29');
    await view.blur(L.birthDate);
    expect(view.error(L.birthDate)).toBe('');
    noErrors(view, 'person');
  });

  it.each([
    ['AB', 'FORM.ISSUE.FORMAT'],
    ['ABCDEFGH', 'FORM.ISSUE.FORMAT'],
    ['AB-123', 'FORM.ISSUE.FORMAT'],
  ])('refuses the recipient code %s', async (value, message) => {
    const view = await named();
    await view.type(L.recipientCode, value);
    await view.blur(L.recipientCode);
    expect(view.error(L.recipientCode)).toBe(message);
    count(view, 'company', 1);
  });

  it.each(['ABC123', 'ABC1234', 'abc123', ''])('accepts the recipient code "%s"', async (value) => {
    const view = await named();
    await view.type(L.recipientCode, value);
    await view.blur(L.recipientCode);
    expect(view.error(L.recipientCode)).toBe('');
  });

  it('refuses a reference of the administration that is too long', async () => {
    const view = await named();
    await view.type('CONTACTS.E_INVOICING.ADMINISTRATION_REFERENCE', long(21));
    await view.blur('CONTACTS.E_INVOICING.ADMINISTRATION_REFERENCE');
    expect(view.error('CONTACTS.E_INVOICING.ADMINISTRATION_REFERENCE')).toBe(
      'FORM.ISSUE.MAX_LENGTH',
    );
    count(view, 'company', 1);
  });
});

type Change = (model: ContactModel) => ContactModel;

describe('ContactPage: the lists', () => {
  const emails =
    (list: string[]): Change =>
    (model) => ({ ...model, person: { ...model.person, emails: list } });
  const phones =
    (list: string[]): Change =>
    (model) => ({ ...model, person: { ...model.person, phones: list } });
  const companyEmails =
    (list: string[]): Change =>
    (model) => ({ ...model, company: { ...model.company, emails: list } });
  const companyPhones =
    (list: string[]): Change =>
    (model) => ({ ...model, company: { ...model.company, phones: list } });
  const faxes =
    (list: string[]): Change =>
    (model) => ({ ...model, company: { ...model.company, faxes: list } });
  const lists =
    (rows: { id: string; name: string; favorite: boolean }[]): Change =>
    (model) => ({
      ...model,
      company: { ...model.company, supplierPriceLists: rows },
    });
  const cards =
    (codes: string[]): Change =>
    (model) => ({ ...model, cards: codes });
  const services =
    (rows: { productId: string; duration: string }[]): Change =>
    (model) => ({ ...model, services: rows });
  const row = (name: string, favorite = false) => ({ id: '', name, favorite });
  const product = (n: number) => `665f1c2e9b1d4a0012ab${String(4000 + n)}`;

  it.each([
    ['an invalid e-mail of the person', emails(['not an address']), 'person'],
    [
      'two e-mails of the person that differ only in case',
      emails(['a@example.com', 'A@Example.com']),
      'person',
    ],
    [
      'more than ten e-mails of the person',
      emails(Array.from({ length: 11 }, (_, n) => `a${n}@example.com`)),
      'person',
    ],
    ['an invalid phone of the person', phones(['a\u0001']), 'person'],
    ['the same phone of the person twice', phones(['0612345', '0612345']), 'person'],
    [
      'more than ten phones of the person',
      phones(Array.from({ length: 11 }, (_, n) => `06${n}`)),
      'person',
    ],
    ['an invalid e-mail of the company', companyEmails(['x@']), 'company'],
    ['an invalid phone of the company', companyPhones([long(65)]), 'company'],
    ['an invalid fax of the company', faxes(['a\u0007']), 'company'],
    ['a price list of the supplier without a name', lists([row('  ')]), 'company'],
    [
      'a price list of the supplier with a name that is too long',
      lists([row(long(101))]),
      'company',
    ],
    [
      'two favorite price lists of the supplier',
      lists([row('A', true), row('B', true)]),
      'company',
    ],
    [
      'more than fifty price lists of the supplier',
      lists(Array.from({ length: 51 }, (_, n) => row(`L${n}`))),
      'company',
    ],
    ['a card code twice', cards(['C1', 'C1']), 'fidelity'],
    ['a card code that is too long', cards([long(65)]), 'fidelity'],
    ['more than twenty cards', cards(Array.from({ length: 21 }, (_, n) => `C${n}`)), 'fidelity'],
    [
      'a service twice',
      services([
        { productId: product(1), duration: '01:00' },
        { productId: product(1), duration: '01:00' },
      ]),
      'services',
    ],
    ['a service with no duration', services([{ productId: product(1), duration: '' }]), 'services'],
    [
      'a service with a duration of zero',
      services([{ productId: product(1), duration: '00:00' }]),
      'services',
    ],
    [
      'a service with an impossible duration',
      services([{ productId: product(1), duration: '24:00' }]),
      'services',
    ],
    [
      'more than two hundred services',
      services(
        Array.from({ length: 201 }, (_, n) => ({ productId: product(n), duration: '01:00' })),
      ),
      'services',
    ],
  ])('refuses %s', async (_name, change, tab) => {
    const view = await named();
    await view.setModel(change);
    await view.submit();
    backend().expectNone(BASE);
    count(view, tab, 1);
    expect(view.visible()).toEqual([tab]);
    expect(view.el().querySelector(`#contact-panel-${tab} .problem`)).not.toBeNull();
  });

  it.each([
    [
      'too many entries',
      emails(Array.from({ length: 11 }, (_, n) => `a${n}@example.com`)),
      'FORM.ISSUE.TOO_MANY',
    ],
    ['an entry twice', emails(['a@example.com', 'a@example.com']), 'FORM.ISSUE.INCORRECT'],
  ])('says %s on the list', async (_name, change, message) => {
    const view = await named();
    await view.setModel(change);
    await view.submit();
    expect(view.el().querySelector('#contact-panel-person .problem')?.textContent).toContain(
      message,
    );
  });

  it('accepts the lists with their blank entries (they are not sent)', async () => {
    const view = await named();
    await view.setModel((model) => ({
      ...model,
      cards: ['', ' '],
      person: { ...model.person, emails: ['', 'anna@example.com'], phones: [' '] },
    }));
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual(
      expect.objectContaining({
        fidelityCards: [],
        person: expect.objectContaining({ emails: ['anna@example.com'], phones: [] }),
      }),
    );
    req.flush({ message: 'x' }, { status: 500, statusText: 'x' });
    await view.view();
  });
});

describe('ContactPage: the marks of the tabs', () => {
  it('counts the invalid fields in each tab and clears the marks when they are fixed', async () => {
    const view = await named();
    await view.type(L.code, long(65));
    await view.type(L.accountEmail, 'bad');
    await view.type(L.accountPhone, 'bad');
    await view.type(L.vatNumber, long(33));
    await view.submit();
    backend().expectNone(BASE);
    count(view, 'general', 1);
    count(view, 'company', 1);
    count(view, 'account', 2);
    noErrors(view, 'person');
    noErrors(view, 'fidelity');
    expect(view.visible()).toEqual(['general']);

    await view.type(L.code, 'K1');
    await view.type(L.accountEmail, 'ok@example.com');
    await view.type(L.accountPhone, '0612345');
    await view.type(L.vatNumber, 'IT1');
    for (const tab of ['general', 'company', 'account']) {
      noErrors(view, tab);
    }
  });

  it('counts each field of the address, the lists and the e-invoicing of both parts', async () => {
    const view = await named();
    await view.setModel((model) => ({
      ...model,
      person: {
        ...model.person,
        address: {
          ...model.person.address,
          street: long(151),
          postcode: long(21),
          city: long(101),
        },
      },
      company: {
        ...model.company,
        address: {
          ...model.company.address,
          street: long(151),
          postcode: long(21),
          city: long(101),
        },
      },
    }));
    await view.submit();
    count(view, 'person', 3);
    count(view, 'company', 3);
    expect(view.visible()).toEqual(['person']);
  });
});
