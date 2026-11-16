import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { Role } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { UsersApi } from '../users/users-api';
import { NewCustomer } from './new-customer';
import { IDEMPOTENCY_HEADER, NewCustomerApi } from './new-customer-api';

const COUNTRIES = {
  data: [
    {
      code: 'IT',
      name: 'Italia',
      areas: [
        { code: 'MI', name: 'Milano' },
        { code: 'TO', name: 'Torino' },
      ],
    },
    { code: 'SM', name: 'San Marino', areas: [{ code: 'MI', name: 'Milano' }] },
    { code: 'DE', name: 'Germania', areas: [] },
  ],
  page: { limit: 3, next: null },
};
const DEALER_A = fakeDealer({ id: 'd1', businessName: 'Dealer Attivo' });
const DEALER_OFF = fakeDealer({
  id: 'd2',
  businessName: 'Dealer Spento',
  user: { id: 'd2', username: 'off', status: 'disabled' },
});
const DEALER_NO_USER = fakeDealer({ id: 'd3', businessName: 'Senza utente', user: null });
const IDS = { groupId: 'g1', companyId: 'c1', placeId: 'p1', userId: 'u1' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const L = {
  group: 'NEW_CUSTOMER.FIELD.GROUP_NAME',
  dealer: 'NEW_CUSTOMER.FIELD.DEALER',
  demo: 'NEW_CUSTOMER.FIELD.DEMO',
  company: 'NEW_CUSTOMER.FIELD.COMPANY_NAME',
  vat: 'NEW_CUSTOMER.FIELD.VAT_NUMBER',
  cf: 'NEW_CUSTOMER.FIELD.FISCAL_CODE',
  sdi: 'NEW_CUSTOMER.FIELD.RECIPIENT_CODE',
  pec: 'NEW_CUSTOMER.FIELD.PEC',
  street: 'NEW_CUSTOMER.FIELD.STREET',
  postcode: 'NEW_CUSTOMER.FIELD.POSTCODE',
  city: 'NEW_CUSTOMER.FIELD.CITY',
  country: 'NEW_CUSTOMER.FIELD.COUNTRY',
  province: 'NEW_CUSTOMER.FIELD.PROVINCE',
  phone: 'NEW_CUSTOMER.FIELD.PHONE',
  email: 'NEW_CUSTOMER.FIELD.EMAIL',
  place: 'NEW_CUSTOMER.FIELD.PLACE_NAME',
  other: 'NEW_CUSTOMER.FIELD.OTHER_ADDRESS',
  pStreet: 'NEW_CUSTOMER.FIELD.PLACE_STREET',
  pPostcode: 'NEW_CUSTOMER.FIELD.PLACE_POSTCODE',
  pCity: 'NEW_CUSTOMER.FIELD.PLACE_CITY',
  pProvince: 'NEW_CUSTOMER.FIELD.PLACE_PROVINCE',
  contact: 'NEW_CUSTOMER.FIELD.CONTACT_NAME',
  pPhone: 'NEW_CUSTOMER.FIELD.PLACE_PHONE',
  pEmail: 'NEW_CUSTOMER.FIELD.PLACE_EMAIL',
  type: 'NEW_CUSTOMER.FIELD.TYPE',
  first: 'NEW_CUSTOMER.FIELD.FIRST_NAME',
  last: 'NEW_CUSTOMER.FIELD.LAST_NAME',
  uPhone: 'NEW_CUSTOMER.FIELD.USER_PHONE',
  uEmail: 'NEW_CUSTOMER.FIELD.USER_EMAIL',
  username: 'NEW_CUSTOMER.FIELD.USERNAME',
  password: 'NEW_CUSTOMER.FIELD.PASSWORD',
  plan: 'NEW_CUSTOMER.FIELD.PLAN',
  expiration: 'NEW_CUSTOMER.FIELD.EXPIRATION',
};

interface Options {
  role?: Role;
  permissions?: string[];
  dealers?: unknown[];
}

async function render({
  role = 'PSA',
  dealers = [DEALER_A, DEALER_OFF, DEALER_NO_USER],
}: Options = {}) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter([{ path: 'tools/new-customer', component: NewCustomer }]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(UsersApi.prototype, 'isUsernameAvailable').mockResolvedValue(true);
  signIn({ role, permissions: ['groups:create', 'users:create'] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/tools/new-customer');
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  await view();
  backend().expectOne(`${API}/v1/countries`).flush(COUNTRIES);
  if (role === 'PSA') {
    const request = backend().expectOne((r) => r.url === `${API}/v1/dealers`);
    expect(request.request.params.get('limit')).toBe('200');
    request.flush({ data: dealers, page: { limit: 200, next: null } });
  } else {
    backend().expectNone((r) => r.url === `${API}/v1/dealers`);
  }
  await view();

  const control = (label: string) => findControl(scope, label);
  const has = (label: string) =>
    [...root.querySelectorAll('label')].some((l) => l.textContent?.trim() === label);
  const type = async (label: string, value: string) => {
    const field = control(label);
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const toggle = async (label: string) => {
    control(label).click();
    await view();
  };
  const error = (label: string) => errorOf(scope, label);
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const options = (label: string) =>
    [...(control(label) as HTMLSelectElement).options].map((o) => o.value);
  const features = () =>
    Object.fromEntries(
      [...root.querySelectorAll<HTMLInputElement>('.features input')].map((input) => [
        root
          .querySelector(`label[for="${input.id}"]`)!
          .textContent!.trim()
          .replace(/^FEATURE\.|\.LABEL$/g, ''),
        input.checked,
      ]),
    );
  const generate = async () => {
    root.querySelector<HTMLButtonElement>('fc-password-generator button')!.click();
    await view();
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  const ctx = {
    root,
    view,
    control,
    has,
    type,
    toggle,
    error,
    submit,
    options,
    features,
    generate,
    toasts,
  };

  /** Fills the mandatory fields; the legacy-like defaults stay. */
  const fill = async () => {
    await type(L.group, ' Nuovo Cliente ');
    await type(L.company, 'Cliente Srl');
    await type(L.vat, '00743110157');
    await type(L.sdi, 'abc1234');
    await type(L.street, 'Via Roma 1');
    await type(L.postcode, '20100');
    await type(L.city, 'Milano');
    await type(L.province, 'MI');
    await type(L.place, 'Insegna Centro');
    await type(L.first, 'Mario');
    await type(L.last, 'Rossi');
    await generate();
  };
  return { ...ctx, fill };
}

type Ctx = Awaited<ReturnType<typeof render>>;

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const POST = (r: { url: string; method: string }) =>
  r.url === `${API}/v1/groups` && r.method === 'POST';

describe('NewCustomer: form', () => {
  it('has the boxes of the legacy form in its order', async () => {
    const { root } = await render();
    expect(root.querySelector('h1')?.textContent).toBe('NEW_CUSTOMER.TITLE');
    expect(
      [...root.querySelectorAll('form > fieldset > legend')].map((l) => l.textContent),
    ).toEqual([
      'NEW_CUSTOMER.SECTION.CUSTOMER',
      'NEW_CUSTOMER.SECTION.COMPANY_CONTACTS',
      'NEW_CUSTOMER.SECTION.PLACE',
      'NEW_CUSTOMER.SECTION.PLACE_CONTACTS',
      'NEW_CUSTOMER.SECTION.TYPE',
      'NEW_CUSTOMER.SECTION.ADMIN',
      'NEW_CUSTOMER.SECTION.SERVICES',
    ]);
  });

  it('opens with the legacy defaults: risto, advanced plan, Italy, end of the year', async () => {
    const { control, features, root } = await render();
    expect((control(L.type) as HTMLSelectElement).value).toBe('risto');
    expect((control(L.plan) as HTMLSelectElement).value).toBe('advanced');
    expect((control(L.country) as HTMLSelectElement).value).toBe('IT');
    expect((control(L.expiration) as HTMLInputElement).value).toBe(
      `${new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', year: 'numeric' }).format(new Date())}-12-31`,
    );
    expect(features()).toMatchObject({
      CASH: true,
      ROOMS: true,
      SCALES: true,
      ORDERING: true,
      PRODUCTS_VARIANTS: true,
      WAREHOUSE: false,
      SERVICES: false,
      APPOINTMENTS: false,
    });
    expect(root.querySelectorAll('.tax')).toHaveLength(2);
  });

  describe('roles', () => {
    it('gives the platform administrator the dealer select (active dealers) and the demo switch', async () => {
      const { control, has, options } = await render();
      expect(has(L.dealer)).toBe(true);
      expect(has(L.demo)).toBe(true);
      expect(options(L.dealer)).toEqual(['', 'd1']);
      expect(control(L.dealer).textContent).toContain('Dealer Attivo');
      expect(options(L.plan)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
        'desk-secondary',
      ]);
    });

    it('gives the dealer neither of them, nor the secondary cash plan', async () => {
      const { has, options } = await render({ role: 'D' });
      expect(has(L.dealer)).toBe(false);
      expect(has(L.demo)).toBe(false);
      expect(options(L.plan)).toEqual(['basic', 'advanced', 'enterprice', 'tgm-secondary']);
    });

    it('offers no dealer while the list is not there', async () => {
      const { options } = await render({ dealers: [] });
      expect(options(L.dealer)).toEqual(['']);
    });
  });

  describe('presets', () => {
    it.each([
      ['retail', 'advanced', { ROOMS: false, SCALES: false, ORDERING: false, SERVICES: false }, 1],
      ['beauty', 'advanced', { SERVICES: true, APPOINTMENTS: true, ROOMS: false }, 1],
      ['beauty', 'basic', { SERVICES: true, APPOINTMENTS: false }, 1],
      ['risto', 'basic', { ROOMS: true, SCALES: false, ORDERING: false }, 2],
    ])(
      '%s with the %s plan sets the features and the tax rates',
      async (kind, plan, expected, taxes) => {
        const { type, features, root } = await render();
        await type(L.plan, plan);
        await type(L.type, kind === 'risto' ? 'retail' : 'risto');
        await type(L.type, kind);
        expect(features()).toMatchObject({ CASH: true, PRODUCTS_VARIANTS: true, ...expected });
        expect(root.querySelectorAll('.tax')).toHaveLength(taxes);
      },
    );

    it('shows the department and the rate of each tax', async () => {
      const { root } = await render();
      expect([...root.querySelectorAll('.tax')].map((tax) => tax.textContent)).toEqual([
        'NEW_CUSTOMER.TAX {"department":1,"rate":10}',
        'NEW_CUSTOMER.TAX {"department":2,"rate":22}',
      ]);
    });

    it('keeps the warehouse switch when the type changes, and follows the plan', async () => {
      const { type, toggle, features } = await render();
      await toggle('FEATURE.WAREHOUSE.LABEL');
      await type(L.type, 'beauty');
      expect(features()['WAREHOUSE']).toBe(true);
      await type(L.plan, 'basic');
      expect(features()).toMatchObject({ WAREHOUSE: true, APPOINTMENTS: false, SERVICES: true });
      await type(L.plan, 'enterprice');
      expect(features()['APPOINTMENTS']).toBe(true);
    });
  });

  describe('company address', () => {
    it('offers the provinces of the country and clears the one of another country', async () => {
      const { type, control, options } = await render();
      expect(options(L.province)).toEqual(['', 'MI', 'TO']);
      await type(L.province, 'TO');
      await type(L.country, 'SM');
      expect(options(L.province)).toEqual(['', 'MI']);
      expect((control(L.province) as HTMLSelectElement).value).toBe('');
      await type(L.province, 'MI');
      await type(L.country, 'IT');
      expect((control(L.province) as HTMLSelectElement).value).toBe('MI');
      await type(L.country, 'DE');
      expect(control(L.province).tagName).toBe('INPUT');
    });

    it('applies the Italian rules and relaxes them for another country', async () => {
      const { type, error, submit } = await render();
      await submit();
      for (const label of [
        L.group,
        L.company,
        L.vat,
        L.street,
        L.postcode,
        L.city,
        L.province,
        L.place,
        L.username,
        L.password,
      ]) {
        expect(error(label)).toBe('FORM.ISSUE.REQUIRED');
      }
      await type(L.vat, '123');
      expect(error(L.vat)).toBe('FORM.ISSUE.PATTERN');
      await type(L.cf, 'ABC');
      expect(error(L.cf)).toBe('FORM.ISSUE.PATTERN');
      await type(L.postcode, '1');
      expect(error(L.postcode)).toBe('FORM.ISSUE.PATTERN');
      await type(L.country, 'DE');
      await type(L.vat, 'DE123456');
      await type(L.cf, 'x-1');
      await type(L.postcode, '10115');
      expect(error(L.vat)).toBe('');
      expect(error(L.cf)).toBe('');
      expect(error(L.postcode)).toBe('');
      expect(error(L.province)).toBe('');
    });

    it('asks an Italian company for the recipient code or the PEC', async () => {
      const { type, error, submit } = await render();
      await submit();
      expect(error(L.sdi)).toBe('FORM.ISSUE.REQUIRED');
      await type(L.pec, 'cliente@pec.it');
      expect(error(L.sdi)).toBe('');
      await type(L.pec, '');
      await type(L.sdi, 'abc');
      expect(error(L.sdi)).toBe('FORM.ISSUE.PATTERN');
      await type(L.sdi, 'ABC1234');
      expect(error(L.sdi)).toBe('');
      await type(L.pec, 'not-an-email');
      expect(error(L.pec)).toBe('FORM.ISSUE.FORMAT');
      await type(L.sdi, '');
      await type(L.country, 'DE');
      await type(L.pec, '');
      expect(error(L.sdi)).toBe('');
    });

    it('checks the contacts', async () => {
      const { type, error, submit } = await render();
      await submit();
      await type(L.phone, 'abc');
      await type(L.email, 'x');
      await type(L.pPhone, 'abc');
      await type(L.pEmail, 'x');
      await type(L.uPhone, 'abc');
      await type(L.uEmail, 'x');
      for (const label of [L.phone, L.pPhone, L.uPhone]) {
        expect(error(label)).toBe('FORM.ISSUE.PATTERN');
      }
      for (const label of [L.email, L.pEmail, L.uEmail]) {
        expect(error(label)).toBe('FORM.ISSUE.FORMAT');
      }
    });
  });

  describe('address of the place', () => {
    it('is hidden until "different from the company" is on, and then asks street, postcode and city', async () => {
      const { has, toggle, error, submit, type, control } = await render();
      expect(has(L.pStreet)).toBe(false);
      await toggle(L.other);
      expect(has(L.pStreet)).toBe(true);
      await submit();
      expect(error(L.pStreet)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(L.pPostcode)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(L.pCity)).toBe('FORM.ISSUE.REQUIRED');
      await type(L.pPostcode, '1');
      expect(error(L.pPostcode)).toBe('FORM.ISSUE.PATTERN');
      expect(control(L.pProvince).tagName).toBe('SELECT');
      await type(L.country, 'DE');
      expect(control(L.pProvince).tagName).toBe('INPUT');
      await toggle(L.other);
      expect(has(L.pStreet)).toBe(false);
    });
  });

  describe('username', () => {
    it('proposes first.last, in lower case without spaces, until the operator types one', async () => {
      const { type, control } = await render();
      await type(L.first, 'Mario');
      expect((control(L.username) as HTMLInputElement).value).toBe('');
      await type(L.last, 'De Rossi');
      expect((control(L.username) as HTMLInputElement).value).toBe('mario.derossi');
      await type(L.first, 'Luigi');
      expect((control(L.username) as HTMLInputElement).value).toBe('luigi.derossi');
      await type(L.username, 'custom.name');
      await type(L.last, 'Bianchi');
      expect((control(L.username) as HTMLInputElement).value).toBe('custom.name');
      await type(L.first, '');
      expect((control(L.username) as HTMLInputElement).value).toBe('custom.name');
    });

    it('does not wipe the username when a name is emptied', async () => {
      const { type, control } = await render();
      await type(L.first, 'Mario');
      await type(L.last, 'Rossi');
      await type(L.last, '');
      expect((control(L.username) as HTMLInputElement).value).toBe('mario.rossi');
    });

    it('checks the availability once typing pauses', async () => {
      const { type, root, view } = await render();
      const spy = vi.mocked(UsersApi.prototype.isUsernameAvailable);
      await type(L.username, 'a b');
      await sleep(350);
      expect(spy).not.toHaveBeenCalled();
      await type(L.username, 'mario.rossi');
      expect(root.textContent).toContain('USERS.FORM.USERNAME_CHECKING');
      await sleep(350);
      await view();
      expect(spy).toHaveBeenCalledWith('mario.rossi');
      expect(root.textContent).toContain('USERS.FORM.USERNAME_AVAILABLE');
    });

    it('reports a taken username on the field', async () => {
      const { type, error, view } = await render();
      vi.mocked(UsersApi.prototype.isUsernameAvailable).mockResolvedValue(false);
      await type(L.username, 'mario.rossi');
      await sleep(350);
      await view();
      expect(error(L.username)).toBe('FORM.ISSUE.TAKEN');
    });

    it('says so when it cannot be checked, logging without the username', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { type, root, view } = await render();
      vi.mocked(UsersApi.prototype.isUsernameAvailable).mockRejectedValue(new Error('x'));
      await type(L.username, 'mario.rossi');
      await sleep(350);
      await view();
      expect(root.textContent).toContain('USERS.FORM.USERNAME_ERROR');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('mario.rossi');
    });
  });

  describe('temporary password', () => {
    it('is generated, filling the field', async () => {
      const { control, generate, root } = await render();
      await generate();
      expect((control(L.password) as HTMLInputElement).value).toHaveLength(16);
      expect(root.querySelector('fc-password-generator output')).not.toBeNull();
    });

    it('follows the policy', async () => {
      const { type, error, submit } = await render();
      await submit();
      await type(L.username, 'mario.rossi');
      await type(L.password, 'short');
      expect(error(L.password)).toBe('FORM.ISSUE.TOO_SHORT');
      await type(L.password, 'x'.repeat(129));
      expect(error(L.password)).toBe('FORM.ISSUE.TOO_LONG');
      await type(L.password, 'mario.rossi');
      await type(L.username, 'long.enough.name');
      await type(L.password, 'long.enough.name');
      expect(error(L.password)).toBe('FORM.ISSUE.SAME_AS_USERNAME');
      await type(L.password, 'Another-Pass-1');
      expect(error(L.password)).toBe('');
    });
  });

  it('reports blur on every field', async () => {
    const { control, toggle, type, root } = await render();
    await toggle(L.other);
    for (const label of Object.values(L).filter(
      (l) => l !== L.demo && l !== L.other && l !== L.type,
    )) {
      control(label).dispatchEvent(new Event('blur'));
    }
    control(L.demo).dispatchEvent(new Event('blur'));
    await type(L.country, 'DE');
    control(L.province).dispatchEvent(new Event('blur'));
    control(L.pProvince).dispatchEvent(new Event('blur'));
    expect(root.querySelector('fc-form-error')).toBeNull();
  });
});

describe('NewCustomer: submission', () => {
  /** Submits and returns the request of the creation, for the caller to flush. */
  async function send(ctx: Ctx) {
    await ctx.submit();
    await settle();
    return backend().expectOne(POST);
  }

  it('does not send an invalid form, and focuses the first error', async () => {
    const { submit, root } = await render();
    await submit();
    backend().expectNone(POST);
    expect(document.activeElement).toBe(root.querySelector('input'));
  });

  it('sends the exact body of a platform administrator, with the idempotency key', async () => {
    const ctx = await render();
    await ctx.fill();
    await ctx.type(L.dealer, 'd1');
    await ctx.toggle(L.demo);
    await ctx.type(L.phone, '02 1234');
    await ctx.type(L.contact, 'Anna');
    await ctx.type(L.pEmail, 'bar@cliente.it');
    await ctx.type(L.type, 'retail');
    await ctx.type(L.plan, 'desk-secondary');
    await ctx.type(L.expiration, '2027-07-15');
    const request = await send(ctx);
    expect(request.request.body).toEqual({
      group: {
        name: 'Nuovo Cliente',
        features: expect.objectContaining({ cash: true, productsVariants: true, rooms: false }),
        demo: true,
        dealerId: 'd1',
      },
      company: {
        name: 'Cliente Srl',
        vatNumber: '00743110157',
        address: {
          street: 'Via Roma 1',
          postcode: '20100',
          city: 'Milano',
          country: 'IT',
          province: 'MI',
        },
        phone: '02 1234',
        eInvoicing: { recipientCode: 'ABC1234' },
      },
      place: {
        name: 'Insegna Centro',
        plan: 'desk-secondary',
        expirationDate: '2027-07-15T21:59:59.000Z',
        contactName: 'Anna',
        email: 'bar@cliente.it',
      },
      user: {
        username: 'mario.rossi',
        password: expect.stringMatching(/^.{16}$/),
        firstName: 'Mario',
        lastName: 'Rossi',
      },
      taxes: [{ rate: 22, department: 2 }],
    });
    expect(request.request.body).not.toHaveProperty('type');
    expect(request.request.headers.get(IDEMPOTENCY_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    request.flush({ data: IDS }, { status: 201, statusText: 'Created' });
    await ctx.view();
  });

  it('sends a dealer body without demo and dealer, with the address of the place', async () => {
    const ctx = await render({ role: 'D' });
    await ctx.fill();
    await ctx.toggle(L.other);
    await ctx.type(L.pStreet, 'Via Po 2');
    await ctx.type(L.pPostcode, '10100');
    await ctx.type(L.pCity, 'Torino');
    await ctx.type(L.pProvince, 'TO');
    const request = await send(ctx);
    expect(request.request.body.group).toEqual({
      name: 'Nuovo Cliente',
      features: expect.any(Object),
    });
    expect(request.request.body.place.address).toEqual({
      street: 'Via Po 2',
      postcode: '10100',
      city: 'Torino',
      province: 'TO',
    });
    request.flush({ data: IDS }, { status: 201, statusText: 'Created' });
    await ctx.view();
  });

  describe('success', () => {
    async function created(ctx: Ctx) {
      const request = await send(ctx);
      request.flush({ data: IDS }, { status: 201, statusText: 'Created' });
      await ctx.view();
      await ctx.view();
    }

    it('shows the summary with the links, the user and the password, and keeps the form until asked', async () => {
      const ctx = await render();
      await ctx.fill();
      await created(ctx);
      const { root } = ctx;
      expect(root.querySelector('form')).toBeNull();
      expect(ctx.toasts()).toEqual(['NEW_CUSTOMER.CREATED']);
      expect([...root.querySelectorAll('.summary a')].map((a) => a.getAttribute('href'))).toEqual([
        '/groups/g1/settings',
        '/groups/g1/companies/c1',
        '/groups/g1/places/p1',
        '/groups/g1/users/u1',
      ]);
      expect(root.querySelector('.summary')?.textContent).toContain('mario.rossi');
      expect(root.querySelector('.summary output')?.textContent).toHaveLength(16);
      expect(document.activeElement).toBe(root.querySelector('#summary-heading'));
    });

    it('copies the password, or says it could not', async () => {
      const ctx = await render();
      await ctx.fill();
      await created(ctx);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const copy = ctx.root.querySelector<HTMLButtonElement>('.summary .password button')!;
      copy.click();
      await ctx.view();
      expect(writeText).toHaveBeenCalledWith(
        ctx.root.querySelector('.summary output')!.textContent,
      );
      expect(ctx.toasts()).toContain('PASSWORD_GENERATOR.COPIED');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
      });
      copy.click();
      await ctx.view();
      expect(ctx.toasts()).toContain('PASSWORD_GENERATOR.COPY_FAILED');
      expect(warn).toHaveBeenCalled();
    });

    it('starts over only when asked, with an empty form and a new key', async () => {
      const ctx = await render();
      await ctx.fill();
      const first = await send(ctx);
      const firstKey = first.request.headers.get(IDEMPOTENCY_HEADER);
      first.flush({ data: IDS }, { status: 201, statusText: 'Created' });
      await ctx.view();
      ctx.root.querySelector<HTMLButtonElement>('.summary .actions button')!.click();
      await ctx.view();
      expect(ctx.root.querySelector('.summary')).toBeNull();
      expect((ctx.control(L.group) as HTMLInputElement).value).toBe('');
      expect((ctx.control(L.password) as HTMLInputElement).value).toBe('');
      expect((ctx.control(L.type) as HTMLSelectElement).value).toBe('risto');
      expect(ctx.root.querySelector('fc-form-error')).toBeNull();
      await ctx.fill();
      const second = await send(ctx);
      expect(second.request.headers.get(IDEMPOTENCY_HEADER)).not.toBe(firstKey);
      second.flush({ data: IDS }, { status: 201, statusText: 'Created' });
      await ctx.view();
    });

    it('starts over from the default preset even after another type was chosen', async () => {
      const ctx = await render();
      await ctx.fill();
      await ctx.type(L.type, 'retail');
      await created(ctx);
      ctx.root.querySelector<HTMLButtonElement>('.summary .actions button')!.click();
      await ctx.view();
      expect(ctx.root.querySelectorAll('.tax')).toHaveLength(2);
    });
  });

  describe('failures keep the form', () => {
    async function failWith(
      status: number,
      code: string,
      details?: { field: string; issue: string }[],
      headers?: Record<string, string>,
    ) {
      const ctx = await render();
      await ctx.fill();
      const request = await send(ctx);
      request.flush(errorBody(code, details), { status, statusText: 'x', headers });
      await ctx.view();
      return ctx;
    }
    const message = (ctx: Ctx) => ctx.root.querySelector('fc-form-error')?.textContent ?? '';

    it('puts a taken username on the field', async () => {
      const ctx = await failWith(409, 'CONFLICT', [{ field: 'user.username', issue: 'taken' }]);
      expect(ctx.error(L.username)).toBe('FORM.ISSUE.TAKEN');
      expect(message(ctx)).toBe('');
      expect((ctx.control(L.group) as HTMLInputElement).value).toBe(' Nuovo Cliente ');
    });

    it('puts the 422 errors of every section on their fields and the rest on the form', async () => {
      const ctx = await failWith(422, 'VALIDATION_ERROR', [
        { field: 'group.name', issue: 'maxLength' },
        { field: 'company.name', issue: 'maxLength' },
        { field: 'company.vatNumber', issue: 'incorrect' },
        { field: 'company.fiscalCode', issue: 'incorrect' },
        { field: 'company.eInvoicing.recipientCode', issue: 'required' },
        { field: 'company.eInvoicing.pec', issue: 'format' },
        { field: 'company.address.street', issue: 'required' },
        { field: 'company.address.postcode', issue: 'format' },
        { field: 'company.address.city', issue: 'required' },
        { field: 'company.address.country', issue: 'incorrect' },
        { field: 'company.address.province', issue: 'incorrect' },
        { field: 'company.phone', issue: 'format' },
        { field: 'company.email', issue: 'format' },
        { field: 'place.name', issue: 'required' },
        { field: 'place.contactName', issue: 'maxLength' },
        { field: 'place.phone', issue: 'format' },
        { field: 'place.email', issue: 'format' },
        { field: 'place.plan', issue: 'enum' },
        { field: 'place.expirationDate', issue: 'format' },
        { field: 'user.firstName', issue: 'maxLength' },
        { field: 'user.lastName', issue: 'maxLength' },
        { field: 'user.phone', issue: 'format' },
        { field: 'user.email', issue: 'format' },
        { field: 'user.password', issue: 'tooShort' },
        { field: 'taxes.0.department', issue: 'incorrect' },
      ]);
      const expected: Record<string, string> = {
        [L.group]: 'FORM.ISSUE.MAX_LENGTH',
        [L.company]: 'FORM.ISSUE.MAX_LENGTH',
        [L.vat]: 'FORM.ISSUE.INCORRECT',
        [L.cf]: 'FORM.ISSUE.INCORRECT',
        [L.sdi]: 'FORM.ISSUE.REQUIRED',
        [L.pec]: 'FORM.ISSUE.FORMAT',
        [L.street]: 'FORM.ISSUE.REQUIRED',
        [L.postcode]: 'FORM.ISSUE.FORMAT',
        [L.city]: 'FORM.ISSUE.REQUIRED',
        [L.country]: 'FORM.ISSUE.INCORRECT',
        [L.province]: 'FORM.ISSUE.INCORRECT',
        [L.phone]: 'FORM.ISSUE.FORMAT',
        [L.email]: 'FORM.ISSUE.FORMAT',
        [L.place]: 'FORM.ISSUE.REQUIRED',
        [L.contact]: 'FORM.ISSUE.MAX_LENGTH',
        [L.pPhone]: 'FORM.ISSUE.FORMAT',
        [L.pEmail]: 'FORM.ISSUE.FORMAT',
        [L.plan]: 'FORM.ISSUE.ENUM',
        [L.expiration]: 'FORM.ISSUE.FORMAT',
        [L.first]: 'FORM.ISSUE.MAX_LENGTH',
        [L.last]: 'FORM.ISSUE.MAX_LENGTH',
        [L.uPhone]: 'FORM.ISSUE.FORMAT',
        [L.uEmail]: 'FORM.ISSUE.FORMAT',
        [L.password]: 'FORM.ISSUE.TOO_SHORT',
      };
      for (const [label, text] of Object.entries(expected)) {
        expect(ctx.error(label), label).toBe(text);
      }
      expect(message(ctx)).toContain('ERRORS.API.VALIDATION_ERROR');
    });

    it('puts the 422 errors of the address of the place, the dealer and the demo flag on their fields', async () => {
      const ctx = await render();
      await ctx.fill();
      await ctx.toggle(L.other);
      await ctx.type(L.pStreet, 'Via Po 2');
      await ctx.type(L.pPostcode, '10100');
      await ctx.type(L.pCity, 'Torino');
      const request = await send(ctx);
      request.flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'place.address.street', issue: 'maxLength' },
          { field: 'place.address.postcode', issue: 'format' },
          { field: 'place.address.city', issue: 'maxLength' },
          { field: 'place.address.province', issue: 'incorrect' },
          { field: 'group.dealerId', issue: 'format' },
        ]),
        { status: 422, statusText: 'x' },
      );
      await ctx.view();
      expect(ctx.error(L.pStreet)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(ctx.error(L.pPostcode)).toBe('FORM.ISSUE.FORMAT');
      expect(ctx.error(L.pCity)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(ctx.error(L.pProvince)).toBe('FORM.ISSUE.INCORRECT');
      expect(ctx.error(L.dealer)).toBe('FORM.ISSUE.FORMAT');
    });

    it('shows a 403 with the fields that are not allowed on the fields', async () => {
      const ctx = await failWith(403, 'FORBIDDEN', [{ field: 'place.plan', issue: 'notAllowed' }]);
      expect(ctx.error(L.plan)).toBe('FORM.ISSUE.NOT_ALLOWED');
    });

    it('shows a 403 without details clearly', async () => {
      expect(message(await failWith(403, 'FORBIDDEN'))).toContain('ERRORS.API.FORBIDDEN');
    });

    it('says the dealer does not exist on a 404', async () => {
      expect(message(await failWith(404, 'NOT_FOUND'))).toContain(
        'NEW_CUSTOMER.ERROR.DEALER_NOT_FOUND',
      );
    });

    it('says when to retry on a 429, or says it generically', async () => {
      expect(
        message(await failWith(429, 'RATE_LIMITED', undefined, { 'Retry-After': '30' })),
      ).toContain('NEW_CUSTOMER.ERROR.RATE_LIMITED_WAIT {"seconds":30}');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      expect(message(await failWith(429, 'RATE_LIMITED'))).toContain('ERRORS.API.RATE_LIMITED');
    });

    it('shows a key already in use as a message of the form', async () => {
      const ctx = await failWith(409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]);
      expect(message(ctx)).toContain('ERRORS.API.CONFLICT');
    });

    it('shows a network failure as the central message', async () => {
      const ctx = await render();
      await ctx.fill();
      const request = await send(ctx);
      request.error(new ProgressEvent('error'));
      await ctx.view();
      expect(message(ctx)).toContain('ERRORS.API.NETWORK_ERROR');
    });

    it('shows an unexpected failure generically, logging it', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(NewCustomerApi.prototype, 'create').mockRejectedValue(new Error('boom'));
      const ctx = await render();
      await ctx.fill();
      await ctx.submit();
      await settle();
      await ctx.view();
      expect(message(ctx)).toContain('ERRORS.GENERIC.MESSAGE');
      expect(error).toHaveBeenCalled();
    });

    it('reuses the key on a retry of the same body, and uses a new one when the body changes', async () => {
      const ctx = await render();
      await ctx.fill();
      const first = await send(ctx);
      const key = first.request.headers.get(IDEMPOTENCY_HEADER);
      first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      expect(message(ctx)).toContain('ERRORS.API.INTERNAL_ERROR');
      const retry = await send(ctx);
      expect(retry.request.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
      retry.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      await ctx.type(L.place, 'Altra Insegna');
      const changed = await send(ctx);
      expect(changed.request.headers.get(IDEMPOTENCY_HEADER)).not.toBe(key);
      changed.flush({ data: IDS }, { status: 201, statusText: 'Created' });
      await ctx.view();
    });

    it('clears the message of a failure when the next attempt starts', async () => {
      const ctx = await render();
      await ctx.fill();
      const first = await send(ctx);
      first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      const retry = await send(ctx);
      expect(message(ctx)).toBe('');
      retry.flush({ data: IDS }, { status: 201, statusText: 'Created' });
      await ctx.view();
    });
  });
});
