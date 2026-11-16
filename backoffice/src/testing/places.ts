import { Provider } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Route, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupFeatures } from '../app/core/groups/group-features';
import { I18nService } from '../app/core/i18n/i18n.service';
import { Profile } from '../app/core/session/session.types';
import { FIELDS, FieldDef, setAt } from '../app/features/places/place-fields';
import { HoursSchedule } from '../app/features/places/place.types';
import { PlaceCash } from '../app/features/places/place-cash';
import { PlaceDelivery } from '../app/features/places/place-delivery';
import { PlaceGeneral } from '../app/features/places/place-general';
import { PlaceHours } from '../app/features/places/place-hours';
import { PlaceKiosk } from '../app/features/places/place-kiosk';
import { PlaceLicense } from '../app/features/places/place-license';
import { leavePlace } from '../app/features/places/place-leave';
import { PlaceMedia } from '../app/features/places/place-media';
import { PlacePage } from '../app/features/places/place-page';
import { PlacePayments } from '../app/features/places/place-payments';
import { PlacePrinting } from '../app/features/places/place-printing';
import { PlaceReservations } from '../app/features/places/place-reservations';
import { PlaceScalarTab } from '../app/features/places/place-scalar-tab';
import { PlaceSelfOrdering } from '../app/features/places/place-self-ordering';
import { PlaceStoreKey } from '../app/features/places/place-store-key';
import { PlaceTables } from '../app/features/places/place-tables';
import {
  PlaceListItem,
  PlaceRecord,
  SettingsBlockName,
  SETTINGS_BLOCKS,
} from '../app/features/places/place.types';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, provideApiTesting, settle } from './api';
import { COUNTRIES, COMPANY, fakeCompany, GROUP } from './companies';
import { errorOf, findControl } from './forms';
import { signIn } from './session';

export { COMPANY, COUNTRIES, GROUP };

export const PLACE = '665f1c2e9b1d4a0012ab34b3';
export const PLACE_2 = '665f1c2e9b1d4a0012ab34b4';
export const COMPANY_2 = '665f1c2e9b1d4a0012ab34b9';
export const LIST_1 = '665f1c2e9b1d4a0012ab34f0';
export const LIST_2 = '665f1c2e9b1d4a0012ab34f1';
export const LIST_3 = '665f1c2e9b1d4a0012ab34f2';
export const TEMPLATE_1 = '665f1c2e9b1d4a0012ab34d1';
export const TEMPLATE_2 = '665f1c2e9b1d4a0012ab34d2';
export const CATEGORY_1 = '665f1c2e9b1d4a0012ab34c1';
export const CATEGORY_2 = '665f1c2e9b1d4a0012ab34c2';
export const PLACE_URL = `${API}/v1/groups/${GROUP}/places/${PLACE}`;
export const PLACES_URL = `${API}/v1/groups/${GROUP}/places`;
export const ETAG = '"v1"';

const WEEK = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((day) => [
    day,
    day === '1'
      ? { active: true, values: [{ start: '09:00', end: '18:00' }] }
      : { active: false, values: [] },
  ]),
);

function schedule(special: HoursSchedule['special'] = {}): HoursSchedule {
  return { week: WEEK as HoursSchedule['week'], special };
}

function defaultValue(definition: FieldDef): unknown {
  switch (definition.type) {
    case 'flag':
      return false;
    case 'plain':
      return '';
    case 'font':
      return '1-1';
    case 'color':
      return '#8936f7';
    case 'int':
    case 'number':
    case 'duration':
      return definition.def ?? null;
    case 'select':
      return definition.nullable === true ? null : (definition.values as string[])[0];
    default:
      return null;
  }
}

/** The keys of a settings block as the API returns them, every one at its default. */
export function blockDefaults(block: SettingsBlockName): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const definition of FIELDS[block]) {
    setAt(body, definition.key, defaultValue(definition));
  }
  return body;
}

const DESCRIPTOR = {
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
};

/** A complete place for tests; override what the test cares about. */
export function fakePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  const blocks = Object.fromEntries(
    SETTINGS_BLOCKS.map((block) => [block, blockDefaults(block)]),
  ) as Record<SettingsBlockName, Record<string, unknown>>;
  blocks.cashSettings['workshiftNames'] = ['Pranzo', 'Cena'];
  blocks.payments['paymentTypes'] = [
    {
      id: 'abc1234',
      name: 'Contanti',
      cash: true,
      electronic: false,
      cheque: false,
      tickets: false,
      electronicInvoiceMode: 'MP01',
    },
  ];
  blocks.tables['tipValues'] = [{ type: 'p', value: 10 }];
  blocks.reservations['timeBlocks'] = [{ weekDays: [1, 2], start: '12:00', end: '14:00' }];
  setAt(blocks.delivery, 'takeAway.shippingCosts', [{ taxed: 2.5, toKm: 5 }]);
  blocks.delivery['minAmount'] = { EUR: 10 };
  blocks.selfOrdering['priceListsConfig'] = {
    [LIST_1]: {
      roundTime: 5,
      roundMaxProducts: 3,
      totalMaxProducts: null,
      variants: true,
      freeVariants: false,
      tableAutoClose: false,
      productsCategories: [
        {
          _id: CATEGORY_1,
          roundMaxProducts: 2,
          totalMaxProducts: null,
          position: 1,
          purchasable: true,
        },
      ],
    },
  };
  blocks.kiosk['productsCategories'] = [{ _id: CATEGORY_1, position: 1 }];
  blocks.kiosk['titleText'] = { it: 'Benvenuti' };
  blocks.kiosk['subTitleText'] = {};
  blocks.kiosk['startButtonText'] = {};
  blocks.kiosk['eatHereText'] = {};
  blocks.kiosk['takeAwayText'] = {};
  blocks.media['logoLight'] = DESCRIPTOR;
  for (const slot of ['coverLight', 'logoKiosk', 'coverKiosk', 'productPlaceholderKiosk']) {
    blocks.media[slot] = null;
  }
  return {
    id: PLACE,
    groupId: GROUP,
    name: 'Bar Roma',
    companyId: COMPANY,
    address: {
      street: 'Via Roma 1',
      postcode: '20100',
      city: 'Milano',
      province: 'MI',
      country: 'IT',
    },
    contactName: 'Mario Rossi',
    email: 'bar@esempio.it',
    phone: '+39 02 1234567',
    priceListId: LIST_1,
    ecommercePriceListId: null,
    invoiceSeries: 'FE',
    priceLists: [{ id: LIST_1, allYouCanEat: true, ayceCode1: '12', ayceCode2: null }],
    trashed: false,
    createdAt: '2026-01-15T10:00:00.000Z',
    updatedAt: '2026-11-13T09:30:00.000Z',
    license: {
      plan: 'advanced',
      expirationDate: '2030-01-01T10:30:00.000Z',
      status: 'active',
      sentry: false,
    },
    openingHours: {
      timezone: 'Europe/Rome',
      ...schedule({ '2026-12-25': { closed: true, values: [] } }),
      deliveryTime: schedule(),
    },
    ...blocks,
    ...overrides,
  };
}

/** A place of the list for tests. */
export function fakeListItem(overrides: Partial<PlaceListItem> = {}): PlaceListItem {
  return {
    id: PLACE,
    name: 'Bar Roma',
    companyId: COMPANY,
    trashed: false,
    plan: 'advanced',
    status: 'active',
    city: 'Milano',
    province: 'MI',
    country: 'IT',
    expirationDate: '2030-01-01T10:30:00.000Z',
    ...overrides,
  };
}

/** All the permissions of the places module, and the ones the lookups need. */
export const PLACE_PERMISSIONS = [
  'places:read',
  'places:create',
  'places:update',
  'places:trash',
  'places:delete',
  'companies:read',
  'groups:read',
  'products:read',
  'profile:read',
];

/** The tabs of the place page, as the router config. */
export const PLACE_TAB_ROUTES: Route[] = [
  { path: '', pathMatch: 'full', component: PlaceGeneral },
  { path: 'license', component: PlaceLicense },
  { path: 'opening-hours', component: PlaceHours },
  { path: 'cash', component: PlaceCash },
  { path: 'printing', component: PlacePrinting },
  { path: 'payments', component: PlacePayments },
  { path: 'tables', component: PlaceTables },
  { path: 'reservations', component: PlaceReservations },
  { path: 'delivery', component: PlaceDelivery },
  { path: 'self-ordering', component: PlaceSelfOrdering },
  { path: 'kiosk', component: PlaceKiosk },
  { path: 'appointments', component: PlaceScalarTab, data: { section: 'appointments' } },
  { path: 'external-display', component: PlaceScalarTab, data: { section: 'externalDisplay' } },
  { path: 'fidelity', component: PlaceScalarTab, data: { section: 'fidelity' } },
  { path: 'tobacco', component: PlaceScalarTab, data: { section: 'tobacco' } },
  { path: 'store-key', component: PlaceStoreKey },
  { path: 'media', component: PlaceMedia },
  { path: 'elsewhere', children: [] },
];

/** Lookup data the tabs read, by endpoint. */
export interface PlaceLookupData {
  countries?: unknown;
  currencies?: unknown;
  priceLists?: unknown;
  categories?: unknown;
}

const LOOKUP_URL =
  /\/v1\/countries$|\/currencies$|\/lookup\/price-lists$|\/companies$|\/places$|\/lookup\/product-categories$|\/lookup\/email-templates$|\/lookup\/languages$|\/invoice-series$/;

const page = (data: unknown[]) => ({ data, page: { limit: 100, next: null } });

/** Answers the lookups the open tab asked for, with the given data or the defaults. */
export async function answerPlaceLookups(data: PlaceLookupData = {}): Promise<void> {
  for (const request of backend().match((r) => LOOKUP_URL.test(r.url) && r.method === 'GET')) {
    const url = request.request.url;
    if (url.endsWith('/countries')) {
      request.flush(data.countries ?? COUNTRIES);
    } else if (url.endsWith('/currencies')) {
      request.flush(data.currencies ?? { data: [{ code: 'EUR' }, { code: 'USD' }] });
    } else if (url.endsWith('/lookup/price-lists')) {
      request.flush(
        data.priceLists ?? {
          data: [
            { id: LIST_1, name: 'Listino 1', enabled: true, isDefault: true },
            { id: LIST_2, name: 'Listino 2', enabled: true, isDefault: false },
            { id: LIST_3, name: 'Listino 3', enabled: false, isDefault: false },
          ],
        },
      );
    } else if (url.endsWith('/lookup/product-categories')) {
      request.flush(
        data.categories ??
          page([
            { id: CATEGORY_1, name: 'Bevande' },
            { id: CATEGORY_2, name: 'Dolci' },
          ]),
      );
    } else if (url.endsWith('/lookup/email-templates')) {
      request.flush(
        page([
          { id: TEMPLATE_1, name: 'Conferma' },
          { id: TEMPLATE_2, name: 'Rifiuto' },
        ]),
      );
    } else if (url.endsWith('/lookup/languages')) {
      request.flush({ data: [{ code: 'it' }, { code: 'en' }] });
    } else if (url.endsWith('/invoice-series')) {
      request.flush({
        data: [
          { name: 'FE', cash: true },
          { name: 'NC', cash: false },
        ],
      });
    } else if (url.endsWith('/places')) {
      request.flush(
        page([
          { id: PLACE, name: 'Bar Roma', companyId: COMPANY, trashed: false },
          { id: PLACE_2, name: 'Bar Milano', companyId: COMPANY, trashed: false },
        ]),
      );
    } else {
      request.flush(
        page([
          { id: COMPANY, name: 'Azienda Esempio Srl', trashed: false },
          { id: COMPANY_2, name: 'Altra Azienda', trashed: false },
        ]),
      );
    }
  }
  await settle();
}

/**
 * Mounts the place page with its real tabs under the routes of the application, signs a user in
 * and (unless told otherwise) answers the read of the place and the lookups the tab asks for.
 * Features are the ones given (`GroupFeatures` is replaced by a stand-in).
 */
export async function renderPlace(
  options: {
    path?: string;
    profile?: Partial<Profile>;
    place?: PlaceRecord | null;
    features?: string[];
    providers?: Provider[];
    permissions?: string[];
    answer?: boolean;
    lookups?: boolean;
    lookupData?: PlaceLookupData;
  } = {},
) {
  const enabled = new Set(
    options.features ?? ['customersApp', 'rooms', 'media', 'appointments', 'ordering', 'warehouse'],
  );
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
            path: 'groups/:groupId/places/new',
            component: PlacePage,
            canDeactivate: [leavePlace],
            children: [{ path: '', component: PlaceGeneral }],
          },
          {
            path: 'groups/:groupId/places/:placeId',
            component: PlacePage,
            canDeactivate: [leavePlace],
            children: PLACE_TAB_ROUTES,
          },
          { path: 'groups/:groupId/places', children: [] },
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
    permissions: options.permissions ?? PLACE_PERMISSIONS,
    ...options.profile,
  });
  const harness = await RouterTestingHarness.create();
  const path = options.path ?? '';
  const creating = path === 'new';
  await harness.navigateByUrl(
    `/groups/${GROUP}/places/${creating ? 'new' : `${PLACE}${path === '' ? '' : `/${path}`}`}`,
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
    const request = backend().expectOne(PLACE_URL);
    request.flush(
      { data: options.place === undefined ? fakePlace() : options.place },
      { headers: { ETag: ETAG } },
    );
  }
  await view();
  if (options.lookups !== false) {
    await answerPlaceLookups(options.lookupData);
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
    for (const field of root.querySelectorAll('input, select, textarea')) {
      field.dispatchEvent(new Event('blur'));
    }
    await view();
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
    toasts,
    error: (label: string) => errorOf(scope, label),
    text: () => root.textContent as string,
  };
}
