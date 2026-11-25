import { Provider, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TestRequest } from '@angular/common/http/testing';
import { provideRouter, Route, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { I18nService } from '../app/core/i18n/i18n.service';
import { ReferenceStore } from '../app/core/reference/reference-store';
import { Profile } from '../app/core/session/session.types';
import { leaveContact } from '../app/features/contacts/contact-leave';
import { ContactModel } from '../app/features/contacts/contact-model';
import { ContactPage } from '../app/features/contacts/contact-page';
import { Contact } from '../app/features/contacts/contact.types';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, errorBody, provideApiTesting, settle } from './api';
import { emulateNativeDialog } from './dialog';
import { errorOf, findControl } from './forms';
import { fakeFeatureFlags } from './groups';
import { signIn } from './session';

export const GROUP = '665f1c2e9b1d4a0012ab34a1';
export const ID = '665f1c2e9b1d4a0012ab3a01';
export const OTHER_ID = '665f1c2e9b1d4a0012ab3a02';
export const USER = '665f1c2e9b1d4a0012ab34ce';
export const CONTACT_GROUP = '665f1c2e9b1d4a0012ab3b01';
export const PRICE_LIST = '665f1c2e9b1d4a0012ab3b11';
export const OFF_PRICE_LIST = '665f1c2e9b1d4a0012ab3b12';
export const SERVICE = '665f1c2e9b1d4a0012ab3b21';
export const LIST_A = '665f1c2e9b1d4a0012ab3b31';
export const LIST_B = '665f1c2e9b1d4a0012ab3b32';

export const FULL = ['contacts:read', 'contacts:write', 'groups:read', 'profile:read'];
export const READ_ONLY = ['contacts:read', 'groups:read', 'profile:read'];

export const BASE = `${API}/v1/groups/${GROUP}/contacts`;
export const ITEM = `${BASE}/${ID}`;
export const CURRENCIES_URL = `${API}/v1/groups/${GROUP}/lookup/currencies`;
export const PRICE_LISTS_URL = `${API}/v1/groups/${GROUP}/lookup/price-lists`;
export const NEW = `/groups/${GROUP}/contacts/new`;
export const EDIT = `/groups/${GROUP}/contacts/${ID}`;
export const LIST_ROUTE = `/groups/${GROUP}/contacts`;

export const ALL_FEATURES = fakeFeatureFlags(true);
export const NO_FEATURES = fakeFeatureFlags(false);

export const PRICE_LISTS = [
  { id: PRICE_LIST, name: 'Listino base', enabled: true },
  { id: OFF_PRICE_LIST, name: 'Listino spento', enabled: false },
];

/** Labels of the fields (the dictionary is replaced by the keys in these tests). */
export const L = {
  customer: 'CONTACTS.GENERAL.CUSTOMER',
  supplier: 'CONTACTS.GENERAL.SUPPLIER',
  group: 'CONTACTS.GENERAL.GROUP',
  priceList: 'CONTACTS.GENERAL.PRICE_LIST',
  code: 'CONTACTS.GENERAL.CODE',
  notes: 'CONTACTS.GENERAL.NOTES',
  firstName: 'CONTACTS.PERSON.FIRST_NAME',
  lastName: 'CONTACTS.PERSON.LAST_NAME',
  personTaxCode: 'CONTACTS.PERSON.TAX_CODE',
  birthDate: 'CONTACTS.PERSON.BIRTH_DATE',
  personDiscount: 'CONTACTS.PERSON.DISCOUNT',
  companyName: 'CONTACTS.COMPANY.NAME',
  vatNumber: 'CONTACTS.COMPANY.VAT_NUMBER',
  companyTaxCode: 'CONTACTS.COMPANY.TAX_CODE',
  companyDiscount: 'CONTACTS.COMPANY.DISCOUNT',
  recipientCode: 'CONTACTS.E_INVOICING.RECIPIENT_CODE',
  pec: 'CONTACTS.E_INVOICING.PEC',
  accountEmail: 'CONTACTS.ACCOUNT.EMAIL',
  accountPhone: 'CONTACTS.ACCOUNT.PHONE',
};

/** A contact with a value in every field of every tab (a person and a company, a card, a service). */
export const CONTACT: Contact = {
  id: ID,
  code: 'K1',
  customer: true,
  supplier: true,
  contactGroupId: CONTACT_GROUP,
  priceListId: PRICE_LIST,
  notes: 'Cliente di prova',
  person: {
    firstName: 'Luca',
    lastName: 'Verdi',
    taxCode: 'VRDLCU80A01H501X',
    birthDate: '1980-01-01',
    address: {
      street: 'Via Roma 1',
      postcode: '00100',
      city: 'Roma',
      countryCode: 'IT',
      areaCode: 'RM',
    },
    phones: ['+39 06 1234567'],
    emails: ['luca.verdi@example.com'],
    discountPercent: 5,
    associatedCompanyId: null,
  },
  company: {
    name: 'Verdi srl',
    vatNumber: 'IT01234567890',
    taxCode: '01234567890',
    address: {
      street: 'Via Milano 2',
      postcode: '20100',
      city: 'Milano',
      countryCode: 'IT',
      areaCode: 'MI',
    },
    phones: ['+39 02 7654321'],
    emails: ['info@verdi.example.com'],
    faxes: [],
    discountPercent: null,
    supplierPriceLists: [
      { id: LIST_A, name: 'Listino A', favorite: true },
      { id: LIST_B, name: 'Listino B', favorite: false },
    ],
  },
  eInvoicing: {
    transmissionFormat: 'FPR12',
    channel: 'CD',
    recipientCode: 'ABC1234',
    pec: null,
    paymentTerms: null,
    paymentMethod: null,
    taxRegime: null,
    administrationReference: null,
    splitPayment: false,
    requirePurchaseOrderData: false,
  },
  fidelityCards: [{ code: 'CARD1', points: 120, advanced: null }],
  services: [{ productId: SERVICE, duration: '00:30' }],
  account: { email: 'luca@example.com', phone: '+39 333 1234567' },
  displayName: 'Verdi srl',
  trashed: false,
  trashedAt: null,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
  warnings: [],
};

/** What the reads of the page get; `'skip'` leaves the contact pending, `'fail'` makes it fail. */
export interface Reads {
  item?: Partial<Contact> | 'skip' | 'fail';
  /** The status of a failed read of the contact. */
  itemStatus?: number;
  requestId?: string;
  etag?: string;
  /** The page shows an existing contact whatever the URL it was opened with (after a creation). */
  edit?: boolean;
  lists?: unknown;
  currencies?: { code: string }[];
  /** The rows the search of the names of duplicate contacts returns. */
  rows?: { id: string; displayName: string | null }[];
}

export const fail = (code: string, status = 500) =>
  [errorBody(code), { status, statusText: 'x' }] as const;

export interface Options {
  profile?: Partial<Profile>;
  features?: Partial<typeof ALL_FEATURES>;
  reads?: Reads | null;
  extra?: Provider[];
  /** The read of the groups of contacts fails. */
  groupsFail?: boolean;
  /** Runs after the test module is configured and before the page opens (to spy on a service). */
  prepare?: () => void;
}

/** Renders the page of a contact at `url` with a fake reference store. */
export async function renderContact(url: string, options: Options = {}) {
  emulateNativeDialog();
  const referenceStore = {
    page: vi.fn(async (_group: string, kind: string, query: { ids?: string[] }) => {
      if (kind === 'contact-groups' && options.groupsFail) {
        throw new Error('groups down');
      }
      const source: Record<string, string> =
        kind === 'contact-groups' ? { [CONTACT_GROUP]: 'Gruppo VIP' } : { [SERVICE]: 'Taglio' };
      const ids = query.ids ?? Object.keys(source);
      return {
        data: ids.filter((id) => id in source).map((id) => ({ id, name: source[id] })),
        page: { limit: 100, next: null },
      };
    }),
    invalidate: vi.fn(),
  };
  const page = (path: string): Route => ({
    path,
    component: ContactPage,
    canDeactivate: [leaveContact],
  });
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: ReferenceStore, useValue: referenceStore },
      ...(options.extra ?? []),
      provideRouter(
        [
          page('groups/:groupId/contacts/new'),
          page('groups/:groupId/contacts/:contactId'),
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  options.prepare?.();
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    id: USER,
    role: 'SA',
    permissions: FULL,
    groupFeatures: fakeFeatureFlags(false, { ...ALL_FEATURES, ...options.features }),
    ...options.profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const scope = {
    get nativeElement() {
      return harness.routeNativeElement;
    },
  } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const respond = (request: TestRequest, o: Reads) => {
    switch (request.request.url) {
      case BASE:
        return request.flush({ data: o.rows ?? [], page: { limit: 6, next: null } });
      case CURRENCIES_URL:
        return request.flush({ data: o.currencies ?? [{ code: 'EUR' }] });
      case PRICE_LISTS_URL:
        return request.flush({ data: o.lists ?? PRICE_LISTS });
      case ITEM:
        return o.item === 'fail'
          ? request.flush(errorBody(o.itemStatus === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR'), {
              status: o.itemStatus ?? 500,
              statusText: 'x',
              headers: o.requestId === undefined ? {} : { 'X-Request-Id': o.requestId },
            })
          : request.flush(
              { data: { ...CONTACT, ...(o.item as object) } },
              { headers: { ETag: o.etag ?? '"v1"' } },
            );
    }
  };
  /** Answers the reads the page makes when it opens. */
  const answer = async (o: Reads = {}) => {
    await settle();
    harness.detectChanges();
    await settle();
    const wantsItem = (o.edit ?? !url.includes('/new')) && o.item !== 'skip';
    for (let round = 0; round < 3; round++) {
      const pending = backend().match((r) => r.method === 'GET' && (r.url !== ITEM || wantsItem));
      if (pending.length === 0) {
        break;
      }
      for (const request of pending) {
        respond(request, o);
      }
      await settle();
      harness.detectChanges();
    }
    await view();
  };
  if (options.reads !== null) {
    await answer(options.reads ?? {});
  }
  const el = () => harness.routeNativeElement as HTMLElement;
  const component = () => harness.routeDebugElement!.componentInstance as ContactPage;
  const internals = () =>
    component() as unknown as {
      model: WritableSignal<ContactModel>;
      section: WritableSignal<string>;
    };
  /** Changes the form model as the controls would. */
  const setModel = async (change: (model: ContactModel) => ContactModel) => {
    internals().model.update(change);
    await view();
  };
  const model = () => internals().model();
  const type = async (label: string, value: string) => {
    const control = findControl(scope, label);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
    await view();
  };
  const blur = async (label: string) => {
    findControl(scope, label).dispatchEvent(new Event('blur'));
    await view();
  };
  const submit = async () => {
    el()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => el().querySelector<HTMLButtonElement>('button[type=submit]');
  const tab = (id: string) => el().querySelector<HTMLButtonElement>(`#contact-tab-${id}`);
  const tabs = () =>
    [...el().querySelectorAll('[role=tab]')].map((t) => t.id.replace('contact-tab-', ''));
  const openTab = async (id: string) => {
    tab(id)!.click();
    await view();
  };
  const visible = () =>
    [...el().querySelectorAll<HTMLElement>('[role=tabpanel]')]
      .filter((p) => !p.hidden)
      .map((p) => p.id.replace('contact-panel-', ''));
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const formError = () => el().querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const button = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button:not(dialog button)')].find(
      (b) => b.textContent?.trim() === text,
    );
  const dialogButton = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const reload = () =>
    [...el().querySelectorAll<HTMLButtonElement>('form button')].find(
      (b) => b.textContent?.trim() === 'CONTACTS.FORM.RELOAD',
    );
  const heading = () => (el().querySelector('h1') as HTMLElement).textContent!.trim();
  const labels = () => [...el().querySelectorAll('label')].map((l) => l.textContent?.trim());
  const count = (id: string) => tab(id)!.textContent!;
  return {
    harness,
    el,
    component,
    view,
    answer,
    type,
    blur,
    submit,
    save,
    tab,
    tabs,
    openTab,
    visible,
    toasts,
    formError,
    button,
    dialogButton,
    reload,
    heading,
    setModel,
    model,
    referenceStore,
    count,
    labels,
    router: TestBed.inject(Router),
    error: (label: string) => errorOf(scope, label),
    control: (label: string) => findControl(scope, label),
  };
}

export type ContactView = Awaited<ReturnType<typeof renderContact>>;
