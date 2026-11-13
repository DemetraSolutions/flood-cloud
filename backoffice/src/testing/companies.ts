import { Provider } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Route, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { FEATURE_NAMES } from '../app/core/groups/feature-catalog';
import { GroupFeatures } from '../app/core/groups/group-features';
import { I18nService } from '../app/core/i18n/i18n.service';
import { Profile } from '../app/core/session/session.types';
import { CompanyBanks } from '../app/features/companies/company-banks';
import { CompanyCustomerApp } from '../app/features/companies/company-customer-app';
import { CompanyEInvoicing } from '../app/features/companies/company-e-invoicing';
import { CompanyGeneral } from '../app/features/companies/company-general';
import { leaveCompany } from '../app/features/companies/company-leave';
import { CompanyMealVouchers } from '../app/features/companies/company-meal-vouchers';
import { CompanyMedia } from '../app/features/companies/company-media';
import { CompanyNumbering } from '../app/features/companies/company-numbering';
import { CompanyPage } from '../app/features/companies/company-page';
import {
  CompanyRecord,
  ECOMMERCE_FLAGS,
  MediaImage,
} from '../app/features/companies/company.types';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, provideApiTesting, settle } from './api';
import { errorOf, findControl } from './forms';
import { signIn } from './session';

export const GROUP = '665f1c2e9b1d4a0012ab34a1';
export const COMPANY = '665f1c2e9b1d4a0012ab34b2';
export const COMPANY_URL = `${API}/v1/groups/${GROUP}/companies/${COMPANY}`;
export const ETAG = '"v1"';

/** A complete company for tests; override what the test cares about. */
export function fakeCompany(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    id: COMPANY,
    groupId: GROUP,
    name: 'Azienda Esempio Srl',
    vatNumber: '01114601006',
    fiscalCode: null,
    address: {
      street: 'Via Roma 1',
      postcode: '20100',
      city: 'Milano',
      province: 'MI',
      country: 'IT',
    },
    currency: 'EUR',
    email: 'info@esempio.it',
    phone: '+39 02 1234567',
    status: 'active',
    trashed: false,
    expirationDate: null,
    createdAt: '2026-01-15T10:00:00.000Z',
    updatedAt: '2026-11-13T09:30:00.000Z',
    eInvoicing: {
      hub: 'aruba',
      transmitter: { country: 'IT', code: '01879020517' },
      eori: null,
      pec: 'pec@esempio.it',
      recipientCode: 'ABC1234',
      professionalRegister: { name: null, number: null, province: null, date: null },
      rea: {
        office: 'MI',
        number: '123456',
        shareCapital: '10000.50',
        shareholders: 'SU',
        liquidation: 'LN',
      },
      taxRegime: 'RF01',
    },
    invoiceNumbering: {
      position: 'prefix',
      values: [
        { name: 'FE', cash: true },
        { name: 'NC', cash: false },
      ],
      lastInvoiceNumber: 120,
      discountLines: true,
      cervedLookup: false,
    },
    bankAccounts: [
      {
        id: '6a1b00000000000000000001',
        name: 'Banca',
        iban: 'IT60X0542811101000000123456',
        abi: '05428',
        cab: '11101',
        bic: null,
        default: true,
      },
    ],
    mealVoucherIssuers: [
      { id: '6a1c00000000000000000001', name: 'Buoni Pasto', cuts: [5, 10, null] },
    ],
    customerApp: {
      enableLoginSignup: true,
      showPrivacyPage: true,
      showTermsPage: false,
      ecommerce: {
        ...(Object.fromEntries(ECOMMERCE_FLAGS.map((flag) => [flag, false])) as Record<
          string,
          boolean
        >),
        status: true,
        priceListId: '665f1c2e9b1d4a0012ab34f0',
        minimumOrder: { EUR: 25.5 },
        showProductRemainingQuantity: 3,
      } as unknown as CompanyRecord['customerApp']['ecommerce'],
    },
    media: {
      internalFileName: '',
      externalUrl: '',
      customersAppLogoLight: {
        _id: '6734a1c2e9b1d4a0012ab3f1',
        basename: 'logo.png',
        extension: 'png',
        filename: 'logo',
        mimetype: 'image/png',
        title: null,
        alt: null,
        dirname: '/media/image',
        type: 'image',
        filectime: 1700000000000,
      },
      customersAppLogoDark: null,
    },
    ...overrides,
  };
}

/** An image of the media library for tests. */
export function fakeImage(overrides: Partial<MediaImage> = {}): MediaImage {
  return {
    id: '6734a1c2e9b1d4a0012ab3f2',
    name: 'Logo Bar',
    title: 'Logo Bar',
    alt: 'Logo Bar',
    companyId: null,
    extension: 'png',
    mimetype: 'image/png',
    createdAt: '2026-11-13T10:00:00.123Z',
    urls: {
      xs: 'https://files.test/xs/logo.png',
      s: 'https://files.test/s/logo.png',
      m: 'https://files.test/m/logo.png',
      l: 'https://files.test/l/logo.png',
      xl: 'https://files.test/xl/logo.png',
    },
    ...overrides,
  };
}

/** All the permissions of the companies module. */
export const COMPANY_PERMISSIONS = [
  'companies:read',
  'companies:create',
  'companies:update',
  'companies:trash',
  'companies:delete',
  'groups:read',
  'profile:read',
];

/** Countries of the tests. */
export const COUNTRIES = {
  data: [
    {
      code: 'IT',
      name: 'Italia',
      areas: [
        { code: 'MI', name: 'Milano' },
        { code: 'RM', name: 'Roma' },
      ],
    },
    { code: 'FR', name: 'Francia', areas: [] },
  ],
  page: { limit: 2, next: null },
};

/** The tabs of the company page, as the router config. */
export const COMPANY_TAB_ROUTES: Route[] = [
  { path: '', pathMatch: 'full', component: CompanyGeneral },
  { path: 'e-invoicing', component: CompanyEInvoicing },
  { path: 'invoice-numbering', component: CompanyNumbering },
  { path: 'bank-accounts', component: CompanyBanks },
  { path: 'meal-vouchers', component: CompanyMealVouchers },
  { path: 'customer-app', component: CompanyCustomerApp },
  { path: 'media', component: CompanyMedia },
  { path: 'elsewhere', children: [] },
];

/**
 * Mounts the company page with its real tabs under the routes of the application, signs a user
 * in and (unless told otherwise) answers the read of the company. Features are the ones given
 * (`GroupFeatures` is replaced by a stand-in).
 */
export async function renderCompany(
  options: {
    path?: string;
    profile?: Partial<Profile>;
    company?: CompanyRecord | null;
    features?: string[];
    providers?: Provider[];
    permissions?: string[];
    answer?: boolean;
    lookups?: boolean;
    lookupData?: LookupData;
  } = {},
) {
  const enabled = new Set(options.features ?? ['customersApp', 'rooms', 'media']);
  const ensure = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      {
        provide: GroupFeatures,
        useValue: { enabled: (name: string) => enabled.has(name), ensure, refresh: vi.fn() },
      },
      ...(options.providers ?? []),
      provideRouter(
        [
          {
            path: 'groups/:groupId/companies/new',
            component: CompanyPage,
            canDeactivate: [leaveCompany],
            children: [{ path: '', component: CompanyGeneral }],
          },
          {
            path: 'groups/:groupId/companies/:companyId',
            component: CompanyPage,
            canDeactivate: [leaveCompany],
            children: COMPANY_TAB_ROUTES,
          },
          { path: 'groups/:groupId/companies', children: [] },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const profile = signIn({
    role: 'PSA',
    groupId: null,
    permissions: options.permissions ?? COMPANY_PERMISSIONS,
    ...options.profile,
  });
  const harness = await RouterTestingHarness.create();
  const path = options.path ?? '';
  const creating = path === 'new';
  await harness.navigateByUrl(
    `/groups/${GROUP}/companies/${creating ? 'new' : `${COMPANY}${path === '' ? '' : `/${path}`}`}`,
  );
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  if (!creating && options.answer !== false) {
    await settle();
    harness.detectChanges();
    const request = backend().expectOne(COMPANY_URL);
    request.flush(
      { data: options.company === undefined ? fakeCompany() : options.company },
      { headers: { ETag: ETAG } },
    );
  }
  await view();
  if (options.lookups !== false) {
    await answerLookups(options.lookupData);
    await view();
  }
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const control = (label: string) => findControl(scope, label);
  const type = async (label: string, value: string) => {
    const field = control(label);
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const toggle = async (label: string, checked: boolean) => {
    const box = control(label) as HTMLInputElement;
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
  const click = async (text: string) => {
    (button(text) as HTMLButtonElement).click();
    await view();
  };
  /** Moves the focus out of every field, as a user tabbing through the form does. */
  const blurAll = async () => {
    for (const field of root.querySelectorAll('input, select')) {
      field.dispatchEvent(new Event('blur'));
    }
    await view();
  };
  /** Submits the form as Enter in a field does: it must not save, nor reload the page. */
  const submitForm = async () => {
    const event = new Event('submit', { cancelable: true });
    root.querySelector('form')?.dispatchEvent(event);
    await view();
    return event.defaultPrevented;
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  return {
    harness,
    root,
    view,
    profile,
    enabled,
    ensure,
    control,
    type,
    toggle,
    button,
    buttons,
    click,
    blurAll,
    submitForm,
    toasts,
    error: (label: string) => errorOf(scope, label),
    text: () => root.textContent as string,
  };
}

/** Lookup data the tabs read, by endpoint. */
export interface LookupData {
  countries?: unknown;
  currencies?: unknown;
  priceLists?: unknown;
  hubs?: unknown;
}

const LOOKUP_URL = /\/v1\/countries$|\/currencies$|\/lookup\/price-lists$|\/e-invoicing-hubs$/;

/** Answers the lookups the open tab asked for, with the given data or the defaults. */
export async function answerLookups(data: LookupData = {}): Promise<void> {
  for (const request of backend().match((r) => LOOKUP_URL.test(r.url))) {
    const url = request.request.url;
    if (url.endsWith('/countries')) {
      request.flush(data.countries ?? COUNTRIES);
    } else if (url.endsWith('/currencies')) {
      request.flush(
        data.currencies ?? {
          data: [
            { code: 'EUR', symbol: '€' },
            { code: 'USD', symbol: '$' },
          ],
        },
      );
    } else if (url.endsWith('/price-lists')) {
      request.flush(
        data.priceLists ?? {
          data: [
            { id: '665f1c2e9b1d4a0012ab34f0', name: 'Listino 1', enabled: true, isDefault: true },
            { id: '665f1c2e9b1d4a0012ab34f1', name: 'Listino 2', enabled: false, isDefault: false },
          ],
        },
      );
    } else {
      request.flush(
        data.hubs ?? {
          data: [
            { value: 'aruba', label: 'Aruba' },
            { value: 'aruba__665f1c2e9b1d4a0012ab34d1', label: 'Dealer Uno' },
          ],
        },
      );
    }
  }
  await settle();
}
