import { WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TestRequest } from '@angular/common/http/testing';
import { provideRouter, Route, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { I18nService } from '../app/core/i18n/i18n.service';
import { ContactApi } from '../app/features/contacts/contact-api';
import { leaveFidelityCard } from '../app/features/fidelity-cards/fidelity-card-leave';
import { CardModel } from '../app/features/fidelity-cards/fidelity-card-model';
import { FidelityCardPage } from '../app/features/fidelity-cards/fidelity-card-page';
import { FidelityCard } from '../app/features/fidelity-cards/fidelity-card.types';
import { CardType, PointsCollection } from '../app/features/groups/catalogs/catalog.types';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, errorBody, provideApiTesting, settle } from './api';
import { emulateNativeDialog } from './dialog';
import { errorOf, findControl } from './forms';
import { aCardType, aPointsCollection } from './fidelity';
import { fakeFeatureFlags } from './groups';
import { signIn } from './session';

export const GROUP = '665f1c2e9b1d4a0012ab34a1';
export const ID = '665f1c2e9b1d4a0012ab3c01';
export const NEW_ID = '665f1c2e9b1d4a0012ab3c02';
export const USER = '665f1c2e9b1d4a0012ab34ce';
export const CONTACT_A = '665f1c2e9b1d4a0012ab3d01';
export const CONTACT_B = '665f1c2e9b1d4a0012ab3d02';

export const FULL = [
  'fidelity:read',
  'fidelity:update',
  'contacts:read',
  'groups:read',
  'profile:read',
];
export const READ_ONLY = ['fidelity:read', 'contacts:read', 'groups:read', 'profile:read'];
/** Cards can be changed, contacts cannot be read. */
export const NO_CONTACTS = ['fidelity:read', 'fidelity:update', 'groups:read', 'profile:read'];

export const BASE = `${API}/v1/groups/${GROUP}/fidelity-cards`;
export const ITEM = `${BASE}/${ID}`;
export const MOVEMENTS = `${ITEM}/movements`;
export const ADJUSTMENTS = `${ITEM}/adjustments`;
export const TYPES_URL = `${API}/v1/groups/${GROUP}/fidelity/card-types`;
export const COLLECTIONS_URL = `${API}/v1/groups/${GROUP}/fidelity/points-collections`;
export const CURRENCIES_URL = `${API}/v1/groups/${GROUP}/lookup/currencies`;
export const NEW = `/groups/${GROUP}/fidelity/cards/new`;
export const EDIT = `/groups/${GROUP}/fidelity/cards/${ID}`;
export const LIST_ROUTE = `/groups/${GROUP}/fidelity/cards`;

/** Labels of the fields (the dictionary is replaced by the keys in these tests). */
export const L = {
  enabled: 'FIDELITY_CARDS.FIELD.ENABLED',
  code: 'FIDELITY_CARDS.FIELD.CODE',
  type: 'FIDELITY_CARDS.FIELD.TYPE',
  initialBalance: 'FIDELITY_CARDS.FIELD.INITIAL_BALANCE',
  pointsOf: (name: string) => `FIDELITY_CARDS.FIELD.POINTS_OF {"name":"${name}"}`,
};

/** A prepaid type that collects points on the collections `pc1` and `pc2`. */
export const GOLD = aCardType({
  id: 'ct1',
  name: 'Gold',
  prepaid: { enabled: true, type: 'multi', taxPercentage: null },
  pointsCollect: { enabled: true, collectionIds: ['pc1', 'pc2', 'pcGone'] },
});
/** A type with neither credit nor points. */
export const PLAIN = aCardType({ id: 'ct2', name: 'Plain' });
/** A type that only collects points, on the collection `pc1`. */
export const POINTS_ONLY = aCardType({
  id: 'ct3',
  name: 'Points',
  pointsCollect: { enabled: true, collectionIds: ['pc1'] },
});
/** A prepaid type that collects no points. */
export const PREPAID_ONLY = aCardType({
  id: 'ct4',
  name: 'Wallet',
  prepaid: { enabled: true, type: 'multi', taxPercentage: null },
});

export const TYPES: CardType[] = [GOLD, PLAIN, POINTS_ONLY, PREPAID_ONLY];
export const COLLECTIONS: PointsCollection[] = [
  aPointsCollection({ id: 'pc1', name: 'Spring' }),
  aPointsCollection({ id: 'pc2', name: 'Winter' }),
];

/** A card of the Gold type with credit, points on two collections and one customer. */
export function aCard(overrides: Partial<FidelityCard> = {}): FidelityCard {
  return {
    id: ID,
    code: 'CARD-001',
    cardTypeId: 'ct1',
    cardType: { id: 'ct1', name: 'Gold', enabled: true, prepaid: true, pointsCollect: true },
    enabled: true,
    balance: 12.5,
    points: [
      { collectionId: 'pc1', name: 'Spring', points: 120, active: true },
      { collectionId: 'pc2', name: 'Winter', points: 7, active: false },
    ],
    totalPoints: 127,
    contacts: [{ id: CONTACT_A, displayName: 'Anna Bianchi' }],
    contactsCount: 1,
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-10T09:30:00.000Z',
    ...overrides,
  };
}

/** What the reads of the page get; `'skip'` leaves a read pending, `'fail'` makes it fail. */
export interface Reads {
  card?: Partial<FidelityCard> | 'skip' | 'fail';
  /** The status of a failed read of the card. */
  cardStatus?: number;
  requestId?: string;
  /** The version the read gives; `null` for a response without one. */
  etag?: string | null;
  types?: CardType[] | 'fail';
  collections?: PointsCollection[] | 'fail';
  currencies?: { code: string }[] | 'fail';
  movements?: unknown[] | 'fail';
  /** The page shows an existing card whatever the URL it was opened with. */
  edit?: boolean;
}

export interface Options {
  permissions?: string[];
  reads?: Reads | null;
  /** The contacts the search of the customers returns. */
  contacts?: { value: string; label: string }[];
  /** Runs after the test module is configured and before the page opens. */
  prepare?: () => void;
}

const fail = (o: { status?: number; code?: string; requestId?: string }) =>
  [
    errorBody(o.code ?? 'INTERNAL_ERROR'),
    {
      status: o.status ?? 500,
      statusText: 'x',
      headers: o.requestId === undefined ? {} : { 'X-Request-Id': o.requestId },
    },
  ] as [object, { status: number; statusText: string; headers: Record<string, string> }];

/** Renders the page of a card at `url`. */
export async function renderCard(url: string, options: Options = {}) {
  emulateNativeDialog();
  const page = (path: string): Route => ({
    path,
    component: FidelityCardPage,
    canDeactivate: [leaveFidelityCard],
  });
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter(
        [
          page('groups/:groupId/fidelity/cards/new'),
          page('groups/:groupId/fidelity/cards/:cardId'),
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
  const search = vi
    .spyOn(TestBed.inject(ContactApi), 'searchContacts')
    .mockImplementation(async () => options.contacts as { value: string; label: string }[]);
  signIn({
    id: USER,
    role: 'SA',
    permissions: options.permissions ?? FULL,
    groupFeatures: fakeFeatureFlags(true),
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
    const answer = (read: unknown, ok: object) =>
      read === 'fail' ? request.flush(...fail({})) : request.flush(ok);
    switch (request.request.url) {
      case TYPES_URL:
        return answer(o.types, { data: o.types ?? TYPES });
      case COLLECTIONS_URL:
        return answer(o.collections, { data: o.collections ?? COLLECTIONS });
      case CURRENCIES_URL:
        return answer(o.currencies, { data: o.currencies ?? [{ code: 'EUR' }] });
      default: {
        if (request.request.url.endsWith('/movements')) {
          return answer(o.movements, {
            data: o.movements ?? [],
            page: { limit: 25, next: null },
          });
        }
        const id = request.request.url.slice(BASE.length + 1);
        return o.card === 'fail'
          ? request.flush(
              ...fail({
                status: o.cardStatus,
                code: o.cardStatus === 404 ? 'NOT_FOUND' : undefined,
                requestId: o.requestId,
              }),
            )
          : request.flush(
              { data: { ...aCard({ id }), ...(o.card as object) } },
              { headers: o.etag === null ? {} : { ETag: o.etag ?? '"v1"' } },
            );
      }
    }
  };
  /** Answers the reads the page makes when it opens (and the ones it makes later). */
  const answer = async (o: Reads = {}) => {
    await settle();
    harness.detectChanges();
    await settle();
    const wantsItem = (o.edit ?? !url.includes('/new')) && o.card !== 'skip';
    for (let round = 0; round < 3; round++) {
      const pending = backend().match(
        (r) =>
          r.method === 'GET' &&
          (!r.url.startsWith(`${BASE}/`) || r.url.endsWith('/movements') || wantsItem),
      );
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
  const component = () => harness.routeDebugElement!.componentInstance as FidelityCardPage;
  const internals = () =>
    component() as unknown as {
      model: WritableSignal<CardModel>;
      section: WritableSignal<string>;
    };
  const model = () => internals().model();
  const control = (label: string) => findControl(scope, label);
  const type = async (label: string, value: string) => {
    const input = control(label);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const blur = async (label: string) => {
    control(label).dispatchEvent(new Event('blur'));
    await view();
  };
  const toggle = async (label: string) => {
    control(label).click();
    await view();
  };
  const submit = async () => {
    el()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => el().querySelector<HTMLButtonElement>('button[form=fidelity-card-form]');
  const tab = (id: string) => el().querySelector<HTMLButtonElement>(`#fidelity-card-tab-${id}`);
  const tabs = () =>
    [...el().querySelectorAll('[role=tab]')].map((t) => t.id.replace('fidelity-card-tab-', ''));
  const openTab = async (id: string) => {
    tab(id)!.click();
    await view();
  };
  const visible = () =>
    [...el().querySelectorAll<HTMLElement>('[role=tabpanel]')]
      .filter((p) => !p.hidden)
      .map((p) => p.id.replace('fidelity-card-panel-', ''));
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const formError = () => el().querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const button = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => !b.closest('dialog') && b.textContent?.trim() === text,
    );
  const dialogButton = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const reload = () => button('FIDELITY_CARDS.FORM.RELOAD');
  const heading = () => (el().querySelector('h1') as HTMLElement).textContent!.trim();
  const text = () => el().textContent!;
  return {
    harness,
    el,
    component,
    view,
    answer,
    type,
    blur,
    toggle,
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
    text,
    model,
    search,
    router: TestBed.inject(Router),
    error: (label: string) => errorOf(scope, label),
    control,
  };
}

export type CardView = Awaited<ReturnType<typeof renderCard>>;
