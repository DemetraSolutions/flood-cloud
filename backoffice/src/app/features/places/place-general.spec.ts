import { TestBed } from '@angular/core/testing';
import { backend } from '../../../testing/api';
import { COMPANY_2, GROUP, LIST_1, LIST_2, LIST_3, fakePlace } from '../../../testing/places';
import {
  ETAG,
  drainSeries,
  expectPlace,
  fail,
  flushPlace,
  optionsOf,
  renderPlacePage,
} from '../../../testing/places-page';

const NAME = 'PLACES.GENERAL.NAME';
const COMPANY = 'PLACES.GENERAL.COMPANY';
const STREET = 'PLACES.GENERAL.STREET';
const POSTCODE = 'PLACES.GENERAL.POSTCODE';
const CITY = 'PLACES.GENERAL.CITY';
const COUNTRY = 'PLACES.GENERAL.COUNTRY';
const PROVINCE = 'PLACES.GENERAL.PROVINCE';
const CONTACT = 'PLACES.GENERAL.CONTACT_NAME';
const EMAIL = 'PLACES.GENERAL.EMAIL';
const PHONE = 'PLACES.GENERAL.PHONE';
const PRICE_LIST = 'PLACES.GENERAL.PRICE_LIST';
const ECOMMERCE = 'PLACES.GENERAL.ECOMMERCE_PRICE_LIST';
const SERIES = 'PLACES.GENERAL.INVOICE_SERIES';
const SAVE = 'COMMON.SAVE';

const isChecked = (field: HTMLInputElement | HTMLSelectElement) =>
  (field as HTMLInputElement).checked;

afterEach(() => {
  sessionStorage.clear();
  try {
    drainSeries();
    backend().verify();
  } finally {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
  }
});

const address = (overrides: Record<string, string> = {}) => ({
  street: 'Via Roma 1',
  postcode: '20100',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
  ...overrides,
});

describe('PlaceGeneral', () => {
  describe('display', () => {
    it('shows the stored data with save disabled until something changes', async () => {
      const { control, button, text } = await renderPlacePage();
      expect(control(NAME).value).toBe('Bar Roma');
      expect(control(COMPANY).value).toBe('665f1c2e9b1d4a0012ab34b2');
      expect(control(STREET).value).toBe('Via Roma 1');
      expect(control(POSTCODE).value).toBe('20100');
      expect(control(CITY).value).toBe('Milano');
      expect(control(COUNTRY).value).toBe('IT');
      expect(control(PROVINCE).value).toBe('MI');
      expect(control(CONTACT).value).toBe('Mario Rossi');
      expect(control(EMAIL).value).toBe('bar@esempio.it');
      expect(control(PHONE).value).toBe('+39 02 1234567');
      expect(control(PRICE_LIST).value).toBe(LIST_1);
      expect(control(ECOMMERCE).value).toBe('');
      expect(control(SERIES).value).toBe('FE');
      expect(button(SAVE)?.disabled).toBe(true);
      expect(text()).not.toContain('PLACES.LICENSE.PLAN');
    });

    it('offers the companies, the countries, the areas, the price lists and the series', async () => {
      const { control } = await renderPlacePage();
      expect(optionsOf(control(COMPANY) as HTMLSelectElement)).toEqual([
        '',
        '665f1c2e9b1d4a0012ab34b2',
        COMPANY_2,
      ]);
      expect(optionsOf(control(COUNTRY) as HTMLSelectElement)).toEqual(['IT', 'FR']);
      expect(optionsOf(control(PROVINCE) as HTMLSelectElement)).toEqual(['', 'MI', 'RM']);
      expect(optionsOf(control(PRICE_LIST) as HTMLSelectElement)).toEqual(['', LIST_1, LIST_2]);
      expect(optionsOf(control(ECOMMERCE) as HTMLSelectElement)).toEqual(['', LIST_1, LIST_2]);
      expect(optionsOf(control(SERIES) as HTMLSelectElement)).toEqual(['', 'FE', 'NC']);
    });

    it('keeps a stored company, country, province, price lists and series the lists do not have', async () => {
      const { control } = await renderPlacePage({
        place: fakePlace({
          companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          address: address({ province: 'ZZ', country: 'XX' }),
          priceListId: LIST_3,
          ecommercePriceListId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          invoiceSeries: 'OLD',
        }),
      });
      expect(optionsOf(control(COMPANY) as HTMLSelectElement)).toContain(
        'aaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(control(COMPANY).value).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(control(COUNTRY).value).toBe('XX');
      // A country without areas asks for the province as text.
      expect(control(PROVINCE).tagName).toBe('INPUT');
      expect(control(PROVINCE).value).toBe('ZZ');
      expect(control(PRICE_LIST).value).toBe(LIST_3);
      expect(control(ECOMMERCE).value).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
      expect(control(SERIES).value).toBe('OLD');
    });

    it('keeps a stored province the country does not list', async () => {
      const { control } = await renderPlacePage({
        place: fakePlace({ address: address({ province: 'ZZ' }) }),
      });
      expect(control(PROVINCE).tagName).toBe('SELECT');
      expect(optionsOf(control(PROVINCE) as HTMLSelectElement)).toContain('ZZ');
      expect(control(PROVINCE).value).toBe('ZZ');
    });

    it('shows a stored series of false as none', async () => {
      const { control } = await renderPlacePage({ place: fakePlace({ invoiceSeries: false }) });
      expect(control(SERIES).value).toBe('');
    });

    it('shows the price lists the server returns without a name by their id', async () => {
      const { text, control } = await renderPlacePage({
        place: fakePlace({
          priceLists: [
            { id: LIST_1, allYouCanEat: false, ayceCode1: null, ayceCode2: null },
            {
              id: 'cccccccccccccccccccccccc',
              allYouCanEat: false,
              ayceCode1: null,
              ayceCode2: null,
            },
          ],
        }),
      });
      expect(text()).toContain('cccccccccccccccccccccccc');
      expect(isChecked(control('cccccccccccccccccccccccc'))).toBe(true);
      expect(isChecked(control('Listino 1'))).toBe(true);
      expect(isChecked(control('Listino 2'))).toBe(false);
    });

    it('does not offer the e-commerce price list without the customers app', async () => {
      const { text } = await renderPlacePage({ features: [] });
      expect(text()).not.toContain(ECOMMERCE);
      expect(text()).toContain(PRICE_LIST);
    });

    it('says when the group has no price list', async () => {
      const { text } = await renderPlacePage({
        place: fakePlace({ priceLists: [] }),
        lookupData: { priceLists: { data: [] } },
      });
      expect(text()).toContain('PLACES.GENERAL.NO_PRICE_LISTS');
    });

    it('is read-only without the permission to update', async () => {
      const { control, button } = await renderPlacePage({
        permissions: ['places:read', 'companies:read', 'groups:read', 'profile:read'],
      });
      expect(control(NAME).disabled).toBe(true);
      expect(control('Listino 1').disabled).toBe(true);
      expect(button(SAVE)).toBeUndefined();
    });

    it('does not let a store administrator change the company', async () => {
      const { control } = await renderPlacePage({ profile: { role: 'PA', groupId: GROUP } });
      expect(control(COMPANY).disabled).toBe(true);
      expect(control(NAME).disabled).toBe(false);
    });
  });

  it('never submits the form natively', async () => {
    const { root } = await renderPlacePage();
    const submit = new Event('submit', { cancelable: true });
    root.querySelector('form')!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  describe('new place', () => {
    it('lets a platform administrator choose the plan and shows the empty required fields as errors once left', async () => {
      const { control, blurAll, error } = await renderPlacePage({ path: 'new' });
      expect(control('PLACES.LICENSE.PLAN').value).toBe('basic');
      await blurAll();
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(STREET)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(COUNTRY)).toBe('');
    });
  });

  describe('address', () => {
    it('uses a text field for the province of a country without areas and clears it', async () => {
      const { control, type } = await renderPlacePage();
      await type(COUNTRY, 'FR');
      expect(control(PROVINCE).tagName).toBe('INPUT');
      expect(control(PROVINCE).value).toBe('');
      await type(PROVINCE, 'Paris');
      expect(control(PROVINCE).value).toBe('Paris');
      await type(COUNTRY, 'IT');
      expect(control(PROVINCE).tagName).toBe('SELECT');
      expect(control(PROVINCE).value).toBe('');
    });

    it('keeps the province when the new country has it, clears it otherwise', async () => {
      const { control, type } = await renderPlacePage({
        lookupData: {
          countries: {
            data: [
              { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }] },
              { code: 'SM', name: 'San Marino', areas: [{ code: 'MI', name: 'Milano' }] },
              { code: 'CH', name: 'Svizzera', areas: [{ code: 'ZH', name: 'Zurigo' }] },
            ],
            page: { limit: 3, next: null },
          },
        },
      });
      await type(COUNTRY, 'SM');
      expect(control(PROVINCE).value).toBe('MI');
      await type(COUNTRY, 'CH');
      expect(control(PROVINCE).value).toBe('');
    });
  });

  describe('contacts and validation', () => {
    it('shows the required error of the name only after the field was left', async () => {
      const { type, error, blurAll } = await renderPlacePage();
      await type(NAME, '');
      expect(error(NAME)).toBe('');
      await blurAll();
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('shows the error of every field after it was left', async () => {
      const { type, error, blurAll, control } = await renderPlacePage({
        features: ['rooms', 'customersApp'],
      });
      await type(NAME, 'x'.repeat(151));
      await type(PHONE, '1'.repeat(31));
      await type(CONTACT, 'c'.repeat(101));
      await type(CITY, 'c'.repeat(101));
      await type(STREET, 's'.repeat(151));
      await type(POSTCODE, '1'.repeat(21));
      await type(COUNTRY, 'FR');
      await type(PROVINCE, 'p'.repeat(11));
      await blurAll();
      for (const label of [NAME, PHONE, CONTACT, CITY, STREET, POSTCODE, PROVINCE]) {
        expect(error(label)).toBe('FORM.ISSUE.MAX_LENGTH');
      }
      expect(control(EMAIL).value).toBe('bar@esempio.it');
    });

    it('marks the selects as touched when they are left', async () => {
      const { type, error, blurAll } = await renderPlacePage();
      await type(COMPANY, '');
      await blurAll();
      expect(error(COMPANY)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('sends the contact fields that changed', async () => {
      const { type, click, view } = await renderPlacePage();
      await type(CONTACT, 'Luigi');
      await type(EMAIL, 'nuovo@esempio.it');
      await type(PHONE, '333');
      await click(SAVE);
      const req = expectPlace();
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({
        contactName: 'Luigi',
        email: 'nuovo@esempio.it',
        phone: '333',
      });
      flushPlace(req, fakePlace({ contactName: 'Luigi', email: 'nuovo@esempio.it', phone: '333' }));
      await view();
    });
  });

  describe('price lists', () => {
    it('adds a row when a list is enabled and removes it when disabled', async () => {
      const { toggle, click, text, control, view } = await renderPlacePage();
      expect(text()).toContain('PLACES.GENERAL.AYCE');
      await toggle('Listino 2', true);
      expect(isChecked(control('Listino 2'))).toBe(true);
      await click(SAVE);
      const req = expectPlace();
      expect(req.request.body).toEqual({
        priceLists: [
          { id: LIST_1, allYouCanEat: true, ayceCode1: '12', ayceCode2: null },
          { id: LIST_2, allYouCanEat: false, ayceCode1: null, ayceCode2: null },
        ],
      });
      flushPlace(
        req,
        fakePlace({
          priceLists: [
            { id: LIST_1, allYouCanEat: true, ayceCode1: '12', ayceCode2: null },
            { id: LIST_2, allYouCanEat: false, ayceCode1: null, ayceCode2: null },
          ],
        }),
      );
      await view();
      await toggle('Listino 1', false);
      await click(SAVE);
      const next = expectPlace();
      expect(next.request.body).toEqual({
        priceLists: [{ id: LIST_2, allYouCanEat: false, ayceCode1: null, ayceCode2: null }],
      });
      flushPlace(next, fakePlace({ priceLists: [] }), '"v3"');
      await view();
    });

    it('edits the all-you-can-eat settings of a list the place uses', async () => {
      const { toggle, type, click, view, control } = await renderPlacePage();
      expect(isChecked(control('PLACES.GENERAL.AYCE'))).toBe(true);
      expect(control('PLACES.GENERAL.AYCE_CODE_1').value).toBe('12');
      await toggle('PLACES.GENERAL.AYCE', false);
      await type('PLACES.GENERAL.AYCE_CODE_1', '99');
      await type('PLACES.GENERAL.AYCE_CODE_2', '7');
      await click(SAVE);
      const req = expectPlace();
      expect(req.request.body).toEqual({
        priceLists: [{ id: LIST_1, allYouCanEat: false, ayceCode1: '99', ayceCode2: '7' }],
      });
      req.flush(
        { error: { code: 'INTERNAL_ERROR', message: 'x' } },
        { status: 500, statusText: 'x' },
      );
      await view();
    });

    it('hides the all-you-can-eat settings without the restaurant module', async () => {
      const { text } = await renderPlacePage({ features: [] });
      expect(text()).not.toContain('PLACES.GENERAL.AYCE');
      expect(text()).toContain('Listino 1');
    });

    it('shows the error of the server on the price lists', async () => {
      const { toggle, click, view, root } = await renderPlacePage();
      await toggle('Listino 2', true);
      await click(SAVE);
      fail(expectPlace(), 422, 'VALIDATION_ERROR', [{ field: 'priceLists', issue: 'invalid' }]);
      await view();
      expect(root.querySelector('p.problem')?.textContent?.trim()).toBe('FORM.ISSUE.INVALID');
    });
  });

  describe('series', () => {
    it('offers the series of the company the user chose', async () => {
      const { control, type, view } = await renderPlacePage();
      expect(optionsOf(control(SERIES) as HTMLSelectElement)).toEqual(['', 'FE', 'NC']);
      await type(COMPANY, COMPANY_2);
      drainSeries();
      await view();
      expect(optionsOf(control(SERIES) as HTMLSelectElement)).toEqual(['', 'FE', 'NC']);
    });
  });
});
