import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { API, backend, errorBody, settle } from '../../../testing/api';
import {
  COMPANY,
  COMPANY_URL,
  COUNTRIES,
  ETAG,
  GROUP,
  fakeCompany,
  renderCompany,
} from '../../../testing/companies';

const NAME = 'COMPANIES.GENERAL.NAME';
const VAT = 'COMPANIES.GENERAL.VAT_NUMBER';
const STREET = 'COMPANIES.GENERAL.STREET';
const COUNTRY = 'COMPANIES.GENERAL.COUNTRY';
const PROVINCE = 'COMPANIES.GENERAL.PROVINCE';
const CURRENCY = 'COMPANIES.GENERAL.CURRENCY';
const STATUS = 'COMPANIES.GENERAL.STATUS';
const EXPIRATION = 'COMPANIES.GENERAL.EXPIRATION_DATE';
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function optionsOf(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

describe('CompanyGeneral', () => {
  describe('display', () => {
    it('shows the stored data with save disabled until something changes', async () => {
      const { control, button, text } = await renderCompany();
      expect(control(NAME).value).toBe('Azienda Esempio Srl');
      expect(control(VAT).value).toBe('01114601006');
      expect(control(STREET).value).toBe('Via Roma 1');
      expect(control(COUNTRY).value).toBe('IT');
      expect(control(PROVINCE).value).toBe('MI');
      expect(control(CURRENCY).value).toBe('EUR');
      expect(control(STATUS).value).toBe('active');
      expect(button(SAVE)?.disabled).toBe(true);
      expect(text()).not.toContain('COMPANIES.RESERVED_NOTE');
    });

    it('offers the countries, the areas of the country and the currencies of the group', async () => {
      const { control } = await renderCompany();
      expect(optionsOf(control(COUNTRY) as HTMLSelectElement)).toEqual(['IT', 'FR']);
      expect(optionsOf(control(PROVINCE) as HTMLSelectElement)).toEqual(['', 'MI', 'RM']);
      expect(optionsOf(control(CURRENCY) as HTMLSelectElement)).toEqual(['EUR', 'USD']);
    });

    it('keeps a stored country, province and currency the lists do not have', async () => {
      const company = fakeCompany({
        address: { street: 'S', postcode: '1', city: 'C', province: 'ZZ', country: 'IT' },
        currency: 'CHF',
      });
      const { control } = await renderCompany({ company });
      expect(optionsOf(control(PROVINCE) as HTMLSelectElement)).toContain('ZZ');
      expect(control(PROVINCE).value).toBe('ZZ');
      expect(optionsOf(control(CURRENCY) as HTMLSelectElement)).toContain('CHF');
      expect(control(CURRENCY).value).toBe('CHF');
    });

    it('lets platform administrators and dealers change the reserved fields', async () => {
      const { control } = await renderCompany();
      expect(control(STATUS).disabled).toBe(false);
      expect(control(EXPIRATION).disabled).toBe(false);
    });

    it('marks the fields as touched when the user leaves them, whichever the province control', async () => {
      const { blurAll, type, error, control, submitForm } = await renderCompany();
      await type(NAME, '');
      await blurAll();
      expect(await submitForm()).toBe(true);
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
      await type(COUNTRY, 'FR');
      await blurAll();
      expect(control(PROVINCE).tagName).toBe('INPUT');
    });

    it('shows the reserved fields read-only to everyone else, with a note', async () => {
      const { control, text } = await renderCompany({
        profile: { role: 'SA', groupId: GROUP },
      });
      expect(control(STATUS).disabled).toBe(true);
      expect(control(EXPIRATION).disabled).toBe(true);
      expect(control(NAME).disabled).toBe(false);
      expect(text()).toContain('COMPANIES.RESERVED_NOTE');
    });

    it('does not read the currencies of a user who cannot read the group (company administrator)', async () => {
      const { control } = await renderCompany({
        profile: { role: 'CA', groupId: GROUP },
        permissions: ['companies:read', 'companies:update', 'profile:read'],
      });
      expect(optionsOf(control(CURRENCY) as HTMLSelectElement)).toEqual(['EUR']);
    });

    it('is read-only without the permission to update', async () => {
      const { control, button } = await renderCompany({
        permissions: ['companies:read', 'groups:read', 'profile:read'],
      });
      expect(control(NAME).disabled).toBe(true);
      expect(button(SAVE)).toBeUndefined();
    });

    it('uses a text field for the province of a country without areas', async () => {
      const { control, type } = await renderCompany();
      await type(COUNTRY, 'FR');
      expect(control(PROVINCE).tagName).toBe('INPUT');
      expect(control(PROVINCE).value).toBe('');
    });

    it('keeps the province when the new country has it, clears it otherwise', async () => {
      const { control, type } = await renderCompany({
        lookupData: {
          countries: {
            data: [
              { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }] },
              { code: 'SM', name: 'San Marino', areas: [{ code: 'MI', name: 'Milano' }] },
            ],
            page: { limit: 2, next: null },
          },
        },
      });
      await type(COUNTRY, 'SM');
      expect(control(PROVINCE).value).toBe('MI');
    });
  });

  describe('lookups', () => {
    it('says so when a list could not be read, and keeps the stored values', async () => {
      const view = await renderCompany({ lookups: false });
      backend().expectOne(`${API}/v1/countries`).flush(COUNTRIES);
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/currencies`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view.view();
      expect(view.text()).toContain('COMPANIES.LOOKUP_ERROR');
      expect(view.control(CURRENCY).value).toBe('EUR');
    });

    it('says nothing while the lists are fine', async () => {
      const { text } = await renderCompany();
      expect(text()).not.toContain('COMPANIES.LOOKUP_ERROR');
    });
  });

  describe('saving', () => {
    it('sends only what changed with If-Match and shows the saved data', async () => {
      const { control, type, click, button, toasts } = await renderCompany();
      await type(NAME, 'Nuova Srl');
      expect(button(SAVE)?.disabled).toBe(false);
      await click(SAVE);
      const req = backend().expectOne(COMPANY_URL);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({ name: 'Nuova Srl' });
      req.flush({ data: fakeCompany({ name: 'Nuova Srl' }) }, { headers: { ETag: '"v2"' } });
      await settle();
      expect(toasts()).toEqual(['COMPANIES.SAVED']);
      expect(control(NAME).value).toBe('Nuova Srl');
      expect(button(SAVE)?.disabled).toBe(true);
      // The next save presents the new version.
      await type(NAME, 'Altra Srl');
      await click(SAVE);
      const next = backend().expectOne(COMPANY_URL);
      expect(next.request.headers.get('If-Match')).toBe('"v2"');
      next.flush({ data: fakeCompany({ name: 'Altra Srl' }) }, { headers: { ETag: '"v3"' } });
      await settle();
    });

    it('writes empty optional texts as null and the address by field', async () => {
      const { type, click } = await renderCompany();
      await type('COMPANIES.GENERAL.EMAIL', '');
      await type('COMPANIES.GENERAL.PHONE', '');
      await type('COMPANIES.GENERAL.FISCAL_CODE', 'RSSMRA80A01H501U');
      await type(STREET, 'Via Verdi 2');
      await type(EXPIRATION, '2030-12-31');
      await type(STATUS, 'disabled');
      await type(CURRENCY, 'USD');
      await click(SAVE);
      const req = backend().expectOne(COMPANY_URL);
      expect(req.request.body).toEqual({
        fiscalCode: 'RSSMRA80A01H501U',
        address: { street: 'Via Verdi 2' },
        currency: 'USD',
        email: null,
        phone: null,
        status: 'disabled',
        expirationDate: '2030-12-31',
      });
      req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
      await settle();
    });

    it('does not send an invalid form and focuses the first error', async () => {
      const { control, type, click, error } = await renderCompany();
      await type(NAME, '');
      await type(VAT, '');
      await click(SAVE);
      await settle();
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(VAT)).toBe('FORM.ISSUE.REQUIRED');
      expect(document.activeElement).toBe(control(NAME));
    });
  });

  describe('errors', () => {
    async function failWith(status: number, body: object, headers: Record<string, string> = {}) {
      const view = await renderCompany();
      await view.type(NAME, 'Nuova Srl');
      await view.click(SAVE);
      backend().expectOne(COMPANY_URL).flush(body, { status, statusText: 'x', headers });
      await settle();
      await view.view();
      return view;
    }

    it('puts a 422 on the field', async () => {
      const { error, text } = await failWith(
        422,
        errorBody('VALIDATION_ERROR', [{ field: 'address.street', issue: 'maxLength' }]),
      );
      expect(error(STREET)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(text()).not.toContain('ERRORS.API.VALIDATION_ERROR');
    });

    it('puts a 409 "vatNumber taken" on the field', async () => {
      const { error } = await failWith(
        409,
        errorBody('CONFLICT', [{ field: 'vatNumber', issue: 'taken' }]),
      );
      expect(error(VAT)).toBe('FORM.ISSUE.TAKEN');
    });

    it('shows a message for a 403 notAllowed and marks the field', async () => {
      const { error, text } = await failWith(
        403,
        errorBody('FORBIDDEN', [{ field: 'status', issue: 'notAllowed' }]),
      );
      expect(error(STATUS)).toBe('FORM.ISSUE.NOT_ALLOWED');
      expect(text()).toContain('COMPANIES.NOT_ALLOWED');
    });

    it('shows the general message for a detail that matches no field', async () => {
      const { text } = await failWith(
        422,
        errorBody('VALIDATION_ERROR', [{ field: 'nope.nothing', issue: 'unknown' }]),
      );
      expect(text()).toContain('ERRORS.API.VALIDATION_ERROR');
    });

    it('shows the message of any other failure', async () => {
      const { text } = await failWith(500, errorBody('INTERNAL_ERROR'));
      expect(text()).toContain('ERRORS.API.INTERNAL_ERROR');
    });

    it('offers to reload after a 412 and drops every draft', async () => {
      const view = await failWith(412, errorBody('PRECONDITION_FAILED'));
      expect(view.text()).toContain('COMPANIES.CONFLICT');
      await view.click('COMPANIES.RELOAD');
      backend()
        .expectOne(COMPANY_URL)
        .flush({ data: fakeCompany({ name: 'Cambiata da altri' }) }, { headers: { ETag: '"v9"' } });
      await view.view();
      expect(view.control(NAME).value).toBe('Cambiata da altri');
      expect(view.text()).not.toContain('COMPANIES.CONFLICT');
    });
  });

  describe('new company', () => {
    it('starts from the defaults and shows only the general tab', async () => {
      const { control, text, button } = await renderCompany({ path: 'new' });
      expect(control(NAME).value).toBe('');
      expect(control(COUNTRY).value).toBe('IT');
      expect(control(CURRENCY).value).toBe('EUR');
      expect(text()).not.toContain('COMPANIES.SECTION.E_INVOICING');
      expect(button('COMPANIES.CREATE')?.disabled).toBe(false);
    });

    it('asks for the required data before creating', async () => {
      const { click, error } = await renderCompany({ path: 'new' });
      await click('COMPANIES.CREATE');
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(STREET)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('creates the company and opens its detail', async () => {
      const { type, click, toasts } = await renderCompany({ path: 'new' });
      await type(NAME, 'Nuova Srl');
      await type(VAT, '01114601006');
      await type(STREET, 'Via Roma 1');
      await type('COMPANIES.GENERAL.POSTCODE', '20100');
      await type('COMPANIES.GENERAL.CITY', 'Milano');
      await type(PROVINCE, 'MI');
      await type('COMPANIES.GENERAL.EMAIL', 'a@b.it');
      await click('COMPANIES.CREATE');
      const req = backend().expectOne(`${API}/v1/groups/${GROUP}/companies`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        name: 'Nuova Srl',
        vatNumber: '01114601006',
        address: {
          street: 'Via Roma 1',
          postcode: '20100',
          city: 'Milano',
          country: 'IT',
          province: 'MI',
        },
        currency: 'EUR',
        status: 'active',
        email: 'a@b.it',
      });
      req.flush(
        { data: fakeCompany({ name: 'Nuova Srl' }) },
        { status: 201, statusText: 'Created', headers: { ETag: ETAG } },
      );
      await settle();
      await settle();
      expect(toasts()).toEqual(['COMPANIES.CREATED']);
      expect(TestBed.inject(Router).url).toBe(`/groups/${GROUP}/companies/${COMPANY}`);
      backend()
        .expectOne(COMPANY_URL)
        .flush({ data: fakeCompany() }, { headers: { ETag: ETAG } });
      await settle();
    });

    it('shows a 409 of the creation on the field', async () => {
      const { type, click, error, view } = await renderCompany({ path: 'new' });
      for (const [label, value] of [
        [NAME, 'N'],
        [VAT, '1'],
        [STREET, 'S'],
        ['COMPANIES.GENERAL.POSTCODE', 'P'],
        ['COMPANIES.GENERAL.CITY', 'C'],
      ]) {
        await type(label, value);
      }
      await click('COMPANIES.CREATE');
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/companies`)
        .flush(errorBody('CONFLICT', [{ field: 'vatNumber', issue: 'taken' }]), {
          status: 409,
          statusText: 'x',
        });
      await view();
      expect(error(VAT)).toBe('FORM.ISSUE.TAKEN');
    });

    it('sends the optional data it was given', async () => {
      const { type, click } = await renderCompany({ path: 'new' });
      for (const [label, value] of [
        [NAME, 'N'],
        [VAT, '1'],
        [STREET, 'S'],
        ['COMPANIES.GENERAL.POSTCODE', 'P'],
        ['COMPANIES.GENERAL.CITY', 'C'],
        ['COMPANIES.GENERAL.FISCAL_CODE', 'F'],
        ['COMPANIES.GENERAL.PHONE', '123'],
        [EXPIRATION, '2031-01-01'],
      ]) {
        await type(label, value);
      }
      await click('COMPANIES.CREATE');
      const req = backend().expectOne(`${API}/v1/groups/${GROUP}/companies`);
      expect(req.request.body).toMatchObject({
        fiscalCode: 'F',
        phone: '123',
        expirationDate: '2031-01-01',
      });
      req.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await settle();
    });
  });
});
