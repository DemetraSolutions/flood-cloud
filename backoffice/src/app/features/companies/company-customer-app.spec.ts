import { backend, errorBody } from '../../../testing/api';
import { COMPANY_URL, ETAG, fakeCompany, renderCompany } from '../../../testing/companies';

const PRICE_LIST = 'COMPANIES.CUSTOMER_APP.PRICE_LIST';
const REMAINING = 'COMPANIES.CUSTOMER_APP.REMAINING_QUANTITY';
const STATUS = 'COMPANIES.CUSTOMER_APP.STATUS';
const minimum = (currency: string) =>
  `COMPANIES.CUSTOMER_APP.MINIMUM_FOR {"currency":"${currency}"}`;
const URL = COMPANY_URL;
/** The block the page sent: the one save puts every changed section in one `PATCH`. */
const blockOf = (req: { request: { body: unknown } }) =>
  (req.request.body as Record<string, unknown>)['customerApp'];
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CompanyCustomerApp', () => {
  it('shows the settings, the enabled price lists and a minimum order per currency', async () => {
    const { control, text } = await renderCompany({ path: 'customer-app' });
    expect((control('COMPANIES.CUSTOMER_APP.LOGIN_SIGNUP') as HTMLInputElement).checked).toBe(true);
    expect((control('COMPANIES.CUSTOMER_APP.TERMS_PAGE') as HTMLInputElement).checked).toBe(false);
    expect((control(STATUS) as HTMLInputElement).checked).toBe(true);
    const lists = [...(control(PRICE_LIST) as HTMLSelectElement).options].map((o) => o.value);
    expect(lists).toEqual(['', '665f1c2e9b1d4a0012ab34f0']);
    expect(control(PRICE_LIST).value).toBe('665f1c2e9b1d4a0012ab34f0');
    expect(control(REMAINING).value).toBe('3');
    expect(control(minimum('EUR')).value).toBe('25.5');
    expect(control(minimum('USD')).value).toBe('');
    expect(
      control('COMPANIES.CUSTOMER_APP.FLAG.ENABLE_WIDGET_PRODUCTS_ALREADY_ORDERED'),
    ).toBeDefined();
    expect(text()).not.toContain('COMPANIES.CUSTOMER_APP.NO_CURRENCIES');
  });

  it('marks the fields as touched when the user leaves them', async () => {
    const { blurAll, submitForm } = await renderCompany({ path: 'customer-app' });
    await blurAll();
    expect(await submitForm()).toBe(true);
  });

  it('keeps a stored price list that is no longer offered', async () => {
    const base = fakeCompany();
    const company = fakeCompany({
      customerApp: {
        ...base.customerApp,
        ecommerce: { ...base.customerApp.ecommerce, priceListId: '665f1c2e9b1d4a0012ab34f1' },
      },
    });
    const { control } = await renderCompany({ path: 'customer-app', company });
    expect(control(PRICE_LIST).value).toBe('665f1c2e9b1d4a0012ab34f1');
  });

  it('shows the currencies already stored when the user cannot read those of the group', async () => {
    const { control, text } = await renderCompany({
      path: 'customer-app',
      profile: { role: 'CA', groupId: '665f1c2e9b1d4a0012ab34a1' },
      permissions: ['companies:read', 'companies:update', 'users:read', 'profile:read'],
    });
    expect(control(minimum('EUR')).value).toBe('25.5');
    expect(text()).not.toContain('COMPANIES.CUSTOMER_APP.MINIMUM_FOR {"currency":"USD"}');
  });

  it('says so when there is no currency at all', async () => {
    const base = fakeCompany();
    const company = fakeCompany({
      customerApp: {
        ...base.customerApp,
        ecommerce: { ...base.customerApp.ecommerce, minimumOrder: {} },
      },
    });
    const { text } = await renderCompany({
      path: 'customer-app',
      company,
      lookupData: { currencies: { data: [] } },
    });
    expect(text()).toContain('COMPANIES.CUSTOMER_APP.NO_CURRENCIES');
  });

  it('does not read the price lists of a user who cannot', async () => {
    const { control } = await renderCompany({
      path: 'customer-app',
      profile: { role: 'CA', groupId: '665f1c2e9b1d4a0012ab34a1' },
      permissions: ['companies:read', 'companies:update', 'profile:read'],
    });
    expect([...(control(PRICE_LIST) as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      '',
      '665f1c2e9b1d4a0012ab34f0',
    ]);
  });

  it('replaces the block with the minimum order per currency and the numbers as numbers', async () => {
    const { type, toggle, click, toasts, view } = await renderCompany({ path: 'customer-app' });
    await type(minimum('USD'), '40');
    await type(minimum('EUR'), '');
    await type(REMAINING, '5');
    await type(PRICE_LIST, '');
    await toggle(STATUS, false);
    await toggle('COMPANIES.CUSTOMER_APP.FLAG.CATALOG_MODE', true);
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(blockOf(req)).toMatchObject({
      enableLoginSignup: true,
      ecommerce: {
        status: false,
        priceListId: null,
        minimumOrder: { EUR: 0, USD: 40 },
        showProductRemainingQuantity: 5,
        catalogMode: true,
        showProductAvailability: false,
      },
    });
    expect(Object.keys((blockOf(req) as { ecommerce: object }).ecommerce)).toHaveLength(27);
    req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['COMPANIES.SAVED']);
  });

  it('puts the errors of the server on the price list and on the minimum order', async () => {
    const { type, click, error, text, view } = await renderCompany({ path: 'customer-app' });
    await type(REMAINING, '4');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'customerApp.ecommerce.priceListId', issue: 'incorrect' },
          { field: 'customerApp.ecommerce.minimumOrder.EUR', issue: 'maximum' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(error(PRICE_LIST)).toBe('FORM.ISSUE.INCORRECT');
    expect(text()).toContain('FORM.ISSUE.MAXIMUM');
  });

  it('shows the error of a currency the form does not hold on the minimum order', async () => {
    const { type, click, text, view } = await renderCompany({ path: 'customer-app' });
    await type(REMAINING, '4');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'customerApp.ecommerce.minimumOrder.GBP', issue: 'incorrect' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(text()).toContain('FORM.ISSUE.INCORRECT');
  });

  it('is read-only without the permission to update', async () => {
    const { control } = await renderCompany({
      path: 'customer-app',
      permissions: ['companies:read', 'groups:read', 'profile:read'],
    });
    expect(control(STATUS).disabled).toBe(true);
    expect(control(minimum('EUR')).disabled).toBe(true);
  });
});
