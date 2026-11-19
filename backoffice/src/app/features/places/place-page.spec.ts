import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, settle } from '../../../testing/api';
import {
  COMPANY_2,
  GROUP,
  PLACE,
  PLACE_PERMISSIONS,
  PLACE_URL,
  PLACES_URL,
  answerPlaceLookups,
  fakePlace,
} from '../../../testing/places';
import {
  ETAG,
  drainSeries,
  expectPlace,
  fail,
  flushPlace,
  freshPlacePage,
  optionsOf,
  renderPlacePage,
} from '../../../testing/places-page';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';
import { exportSettings } from './settings-transfer';
import { toModel } from './place-model';

const NAME = 'PLACES.GENERAL.NAME';
const CITY = 'PLACES.GENERAL.CITY';
const COMPANY_LABEL = 'PLACES.GENERAL.COMPANY';
const PLAN = 'PLACES.LICENSE.PLAN';
const EXPIRATION = 'PLACES.LICENSE.EXPIRATION_DATE';
const STATUS = 'PLACES.LICENSE.STATUS';
const SAVE = 'COMMON.SAVE';
const UNSAVED = 'PLACES.UNSAVED';
const ERRORS = 'PLACES.SECTION_ERRORS';
const FAST_LOGIN = 'PLACES.F.CASH_SETTINGS.FAST_LOGIN';
const CANCELLATION = 'PLACES.F.CASH_SETTINGS.RECEIPTS_CANCELLATION';
const PLACE_PATH = `/groups/${GROUP}/places/${PLACE}`;

const SA = { role: 'SA', groupId: GROUP } as const;
const DEALER = { role: 'D', groupId: null } as const;
const NO_FEATURES = { features: [], profile: SA };
const MINIMAL = ['places:read', 'places:update', 'profile:read'];

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

type View = Awaited<ReturnType<typeof renderPlacePage>>;

/** Presses the save and lets the request be seen. */
async function save(view: View, label = SAVE): Promise<ReturnType<typeof expectPlace>> {
  await view.click(label);
  return expectPlace();
}

/** Settles after an answer, the navigation it starts and the render that follows. */
async function afterAnswer(view: View): Promise<void> {
  await view.view();
  await settle();
  await view.view();
}

describe('PlacePage', () => {
  describe('header', () => {
    it('shows the name with the save disabled until something changes', async () => {
      const { root, button, type } = await renderPlacePage();
      expect(root.querySelector('h1')?.textContent).toBe('Bar Roma');
      expect(button(SAVE)?.disabled).toBe(true);
      await type(NAME, 'Altro');
      expect(button(SAVE)?.disabled).toBe(false);
      await type(NAME, 'Bar Roma');
      expect(button(SAVE)?.disabled).toBe(true);
    });

    it('tells a place in the trash or disabled', async () => {
      const trashed = await renderPlacePage({ place: fakePlace({ trashed: true }) });
      expect(trashed.text()).toContain('PLACES.STATUS.TRASHED');
      const disabled = await freshPlacePage({
        place: fakePlace({
          license: { plan: 'advanced', expirationDate: null, status: 'disabled' },
        }),
      });
      expect(disabled.text()).toContain('PLACES.STATUS.DISABLED');
      expect(disabled.text()).not.toContain('PLACES.STATUS.TRASHED');
    });

    it('offers no saving and says so to whoever cannot update', async () => {
      const { button, text, control } = await renderPlacePage({
        permissions: ['places:read', 'companies:read', 'groups:read', 'profile:read'],
      });
      expect(button(SAVE)).toBeUndefined();
      expect(text()).toContain('PLACES.READ_ONLY');
      expect(control(NAME).disabled).toBe(true);
    });

    it('waits for the place before showing anything', async () => {
      const { root, text, view } = await renderPlacePage({ answer: false, lookups: false });
      expect(text()).toContain('COMMON.LOADING');
      expect(root.querySelector('h1')).toBeNull();
      flushPlace(expectPlace(), fakePlace(), ETAG);
      await view();
      await answerPlaceLookups();
    });

    it('asks for the features of the group and leaves the working group alone', async () => {
      const { ensure } = await renderPlacePage();
      expect(ensure).toHaveBeenCalledWith(GROUP);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });

    it('names the group of the record when it is not the working group, and not when it is', async () => {
      const view = await renderPlacePage();
      const root = view.root;
      expect(root.querySelector('.record-group')?.textContent).toContain('RECORD_GROUP.LABEL');
      expect(root.querySelector('.record-group a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/settings`,
      );
      TestBed.inject(GroupContext).choose({ id: GROUP, name: 'Gruppo Esempio' });
      await view.view();
      expect(root.querySelector('.record-group')).toBeNull();
      sessionStorage.clear();
    });

    it('says so when a lookup could not be read, and keeps the stored values', async () => {
      const view = await renderPlacePage({ lookups: false });
      backend()
        .expectOne(`${API}/v1/countries`)
        .flush({ data: [], page: { limit: 1, next: null } });
      backend()
        .expectOne((r) => r.url.endsWith('/companies') && r.method === 'GET')
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      backend()
        .match((r) => r.url.includes('price-lists'))
        .forEach((r) => r.flush({ data: [] }));
      backend()
        .match((r) => r.url.includes('/companies/') || r.url.endsWith('/invoice-series'))
        .forEach((r) => r.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' }));
      await view.view();
      expect(view.text()).toContain('PLACES.LOOKUP_ERROR');
      expect(view.control(COMPANY_LABEL).value).toBe('665f1c2e9b1d4a0012ab34b2');
    });

    it('says nothing while the lookups are fine', async () => {
      const { text } = await renderPlacePage();
      expect(text()).not.toContain('PLACES.LOOKUP_ERROR');
    });
  });

  describe('load failures', () => {
    it('shows the error with a retry and a way back', async () => {
      const { root, view } = await renderPlacePage({ answer: false, lookups: false });
      expectPlace().flush(errorBody('NOT_FOUND'), {
        status: 404,
        statusText: 'x',
        headers: { 'X-Request-Id': 'r-1' },
      });
      await view();
      const failed = root.querySelector('fc-error-state')!;
      expect(failed.textContent).toContain('PLACES.LOAD_ERROR');
      expect(failed.textContent).toContain('ERRORS.API.NOT_FOUND');
      expect(failed.textContent).toContain('r-1');
      // No working group: the way back is the cross-group list.
      expect(root.querySelector<HTMLAnchorElement>('p a')?.getAttribute('href')).toBe('/places');
      failed.querySelector('button')!.click();
      await view();
      flushPlace(expectPlace(), fakePlace(), ETAG);
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      await answerPlaceLookups();
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('Bar Roma');
      await settle();
    });

    it('shows the error when the place cannot be read again after a conflict', async () => {
      const { type, click, text, view, root } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await click(SAVE);
      fail(expectPlace(), 412, 'PRECONDITION_FAILED');
      await view();
      await click('PLACES.RELOAD');
      fail(expectPlace(), 500, 'INTERNAL_ERROR');
      await view();
      expect(root.querySelector('fc-error-state')).not.toBeNull();
      expect(text()).not.toContain('PLACES.CONFLICT');
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await renderPlacePage({
        answer: false,
        lookups: false,
        providers: [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }],
      });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('tabs', () => {
    const ALL = [
      PLACE,
      'devices',
      'print-stations',
      'rooms',
      'storages',
      'hours',
      'media',
      'settings',
      'integrations',
    ];
    const ALWAYS = [PLACE, 'storages', 'hours', 'settings', 'integrations'];

    it('shows every tab to a platform administrator and to a dealer, whatever the modules', async () => {
      const psa = await renderPlacePage({ features: [] });
      expect(psa.tabNames()).toEqual(ALL);
      const dealer = await freshPlacePage({ features: [], profile: DEALER });
      expect(dealer.tabNames()).toEqual(ALL);
    });

    it('hides from the others the tabs of the modules the group does not have', async () => {
      const none = await renderPlacePage(NO_FEATURES);
      expect(none.tabNames()).toEqual(ALWAYS);
    });

    it.each([
      ['cash', 'devices'],
      ['ordering', 'print-stations'],
      ['rooms', 'rooms'],
      ['media', 'media'],
    ])('shows the tab of the %s module', async (feature, path) => {
      const view = await renderPlacePage({ features: [feature], profile: SA });
      expect(view.tabNames()).toContain(path);
      expect(view.tabNames()).toHaveLength(ALWAYS.length + 1);
    });

    it('shows only the general tab of a secondary plan, whoever the user is', async () => {
      const { tabNames } = await renderPlacePage({
        place: fakePlace({
          license: { plan: 'tgm-secondary', expirationDate: null, status: 'active' },
        }),
      });
      expect(tabNames()).toEqual([PLACE]);
    });

    it('marks the current tab and the tabs with unsaved changes', async () => {
      const { tabs, goTo, type, toggle, text } = await renderPlacePage();
      expect(tabs()[0].getAttribute('aria-current')).toBe('page');
      await type(NAME, 'Bozza');
      expect(tabs()[0].textContent).toContain(UNSAVED);
      await goTo('settings');
      expect(tabs()[0].getAttribute('aria-current')).toBeNull();
      expect(tabs()[7].getAttribute('aria-current')).toBe('page');
      expect(tabs()[7].textContent).not.toContain(UNSAVED);
      await toggle(FAST_LOGIN, true);
      expect(tabs()[7].textContent).toContain(UNSAVED);
      expect(text()).toContain(UNSAVED);
    });

    it('keeps the drafts of the tabs while the user moves between them', async () => {
      const { type, goTo, control, text } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await goTo('settings');
      await goTo(PLACE);
      expect(control(NAME).value).toBe('Bozza');
      expect(text()).toContain(UNSAVED);
    });
  });

  describe('settings menu', () => {
    const ALL = [
      'dealer',
      'general',
      'rooms-settings',
      'delivery',
      'reservations',
      'self-ordering',
      'external-display',
      'kiosk',
      'appointments',
      'fidelity',
      'tobacco',
      'print',
      'other',
      'payments',
    ];
    const ALWAYS = [
      'general',
      'external-display',
      'kiosk',
      'fidelity',
      'print',
      'other',
      'payments',
    ];

    it('shows every entry to platform administrators and dealers', async () => {
      const psa = await renderPlacePage({ path: 'settings', features: [] });
      expect(psa.entryNames()).toEqual(ALL);
      const dealer = await freshPlacePage({ path: 'settings', features: [], profile: DEALER });
      expect(dealer.entryNames()).toEqual(ALL);
    });

    it('hides from the others the entries of the dealers and of the modules the group lacks', async () => {
      const view = await renderPlacePage({ path: 'settings', ...NO_FEATURES });
      expect(view.entryNames()).toEqual(ALWAYS);
    });

    it.each([
      ['rooms', ['rooms-settings', 'delivery', 'reservations', 'self-ordering']],
      ['appointments', ['appointments']],
      ['tobaccosGamesMonopoly', ['tobacco']],
    ])('shows the entries of the %s module', async (feature, entries) => {
      const view = await renderPlacePage({ path: 'settings', features: [feature], profile: SA });
      expect(view.entryNames()).toEqual(
        ALL.filter((id) => id !== 'dealer' && (ALWAYS.includes(id) || entries.includes(id))),
      );
    });

    it('opens the general entry by default and groups the entries', async () => {
      const { root, router } = await renderPlacePage({ path: 'settings' });
      expect(router.url).toBe(`${PLACE_PATH}/settings/general`);
      expect(root.querySelectorAll('fc-place-settings h2')).toHaveLength(4);
    });

    it('marks the entries with unsaved changes: the cancellation of the receipts is its own entry', async () => {
      const { entries, goToEntry, type, toggle } = await renderPlacePage({
        path: 'settings/other',
      });
      const marked = () => entries().map((a) => a.textContent!.includes(UNSAVED));
      const index = (id: string) =>
        entries().findIndex((a) => a.getAttribute('href')!.endsWith(`/${id}`));
      expect(marked().some(Boolean)).toBe(false);
      await type(CANCELLATION, 'sync');
      expect(marked()[index('other')]).toBe(true);
      expect(marked()[index('general')]).toBe(false);
      await goToEntry('general');
      await toggle(FAST_LOGIN, true);
      expect(marked()[index('other')]).toBe(true);
      expect(marked()[index('general')]).toBe(true);
      expect(marked()[index('payments')]).toBe(false);
      await type(CANCELLATION, '').catch(() => undefined);
    });

    it('marks the general entry alone when only the general keys changed', async () => {
      const { entries, toggle } = await renderPlacePage({ path: 'settings/general' });
      await toggle(FAST_LOGIN, true);
      const marked = entries()
        .filter((a) => a.textContent!.includes(UNSAVED))
        .map((a) => a.getAttribute('href')!.split('/').pop());
      expect(marked).toEqual(['general']);
    });
  });

  describe('permissions', () => {
    it('lets a platform administrator change every reserved field', async () => {
      const { control } = await renderPlacePage();
      expect(control(PLAN).disabled).toBe(false);
      expect(control(EXPIRATION).disabled).toBe(false);
      expect(control(STATUS).disabled).toBe(false);
    });

    it('lets a dealer change the expiration date and the status, but not the plan of a place', async () => {
      const { control } = await renderPlacePage({ profile: DEALER });
      expect(control(PLAN).disabled).toBe(true);
      expect(control(EXPIRATION).disabled).toBe(false);
      expect(control(STATUS).disabled).toBe(false);
    });

    it('does not show the license to a store administrator', async () => {
      const { text, control } = await renderPlacePage({ profile: { role: 'PA', groupId: GROUP } });
      expect(text()).not.toContain(PLAN);
      expect(control(COMPANY_LABEL).disabled).toBe(true);
    });

    it('lets a store administrator move the place to another company, not a point of sale administrator', async () => {
      const sa = await renderPlacePage({ profile: SA });
      expect(sa.control(COMPANY_LABEL).disabled).toBe(false);
      const ca = await freshPlacePage({ profile: { role: 'CA', groupId: GROUP } });
      expect(ca.control(COMPANY_LABEL).disabled).toBe(false);
    });

    it('locks the sentry switch to whoever is not a platform administrator', async () => {
      const label = 'PLACES.F.DEALER_SETTINGS.SENTRY';
      const psa = await renderPlacePage({ path: 'settings/dealer' });
      expect(psa.control(label).disabled).toBe(false);
      const dealer = await freshPlacePage({ path: 'settings/dealer', profile: DEALER });
      expect(dealer.control(label).disabled).toBe(true);
    });

    it('locks the web widget of the appointments and the integration switches to whoever cannot reserve', async () => {
      const widget = 'PLACES.F.APPOINTMENTS.WEB_WIDGET_STATUS';
      const psa = await renderPlacePage({ path: 'settings/appointments' });
      expect(psa.control(widget).disabled).toBe(false);
      const sa = await freshPlacePage({ path: 'settings/appointments', profile: SA });
      expect(sa.control(widget).disabled).toBe(true);
      const integrations = await freshPlacePage({ path: 'integrations', profile: SA });
      const boxes = [
        ...integrations.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
      ];
      expect(boxes.length).toBeGreaterThan(0);
      expect(boxes.some((box) => box.disabled)).toBe(true);
      const open = await freshPlacePage({ path: 'integrations' });
      expect(
        [...open.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].some(
          (box) => box.disabled,
        ),
      ).toBe(false);
    });

    it('locks the lists the server says are not editable', async () => {
      const place = fakePlace({
        devices: { ...fakePlace().devices, editable: false },
        printStations: {
          ...fakePlace().printStations,
          stationsEditable: false,
          productionCentersEditable: false,
        },
        rooms: { ...fakePlace().rooms, editable: false },
        storages: { ...fakePlace().storages, editable: false },
      });
      const view = await renderPlacePage({ path: 'devices', place });
      for (const path of ['devices', 'print-stations', 'rooms', 'storages']) {
        await view.goTo(path);
        const inputs = [
          ...view.root.querySelectorAll<HTMLInputElement>('input:not([type=file]), select'),
        ];
        expect(inputs.every((input) => input.disabled)).toBe(true);
      }
    });

    it('offers the plans of the user, the stored one when it is historical', async () => {
      const psa = await renderPlacePage({
        place: fakePlace({
          license: { plan: 'professional', expirationDate: null, status: 'active' },
        }),
      });
      expect(optionsOf(psa.control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
        'desk-secondary',
        'professional',
      ]);
      const labels = [...(psa.control(PLAN) as HTMLSelectElement).options].map((o) =>
        o.textContent?.trim(),
      );
      expect(labels).toContain('professional');
      expect(labels).toContain('PLACES.PLAN.TGM_SECONDARY');
      const known = await freshPlacePage();
      expect(optionsOf(known.control(PLAN) as HTMLSelectElement)).toHaveLength(5);
      const empty = await freshPlacePage({
        place: fakePlace({ license: { plan: null, expirationDate: null, status: 'active' } }),
      });
      expect(optionsOf(empty.control(PLAN) as HTMLSelectElement)).toHaveLength(5);
      const dealer = await freshPlacePage({ profile: DEALER });
      expect(optionsOf(dealer.control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
      ]);
    });
  });

  describe('saving', () => {
    it('sends only what changed, with the version, and puts back what the server answered', async () => {
      const view = await renderPlacePage();
      await view.type(NAME, 'Altro');
      const request = await save(view);
      expect(request.request.method).toBe('PATCH');
      expect(request.request.headers.get('If-Match')).toBe(ETAG);
      expect(request.request.body).toEqual({ name: 'Altro' });
      flushPlace(request, fakePlace({ name: 'Altro' }), '"v2"');
      await view.view();
      expect(view.toasts()).toEqual(['PLACES.SAVED']);
      expect(view.button(SAVE)?.disabled).toBe(true);
      expect(view.text()).not.toContain(UNSAVED);
      expect(view.control(NAME).value).toBe('Altro');
      // The next save presents the new version.
      await view.type(NAME, 'Terzo');
      const next = await save(view);
      expect(next.request.headers.get('If-Match')).toBe('"v2"');
      flushPlace(next, fakePlace({ name: 'Terzo' }), '"v3"');
      await view.view();
    });

    it('sends the sections of every tab and entry in the one request', async () => {
      const view = await renderPlacePage();
      await view.type(NAME, 'Altro');
      await view.goTo('settings');
      await view.toggle(FAST_LOGIN, true);
      await view.goToEntry('other');
      await view.type(CANCELLATION, 'sync');
      const request = await save(view);
      const body = request.request.body as Record<string, Record<string, unknown>>;
      expect(Object.keys(body)).toEqual(expect.arrayContaining(['name', 'cashSettings']));
      expect(body['cashSettings']['fastLogin']).toBe(true);
      expect(body['cashSettings']['receiptsCancellation']).toBe('sync');
      expect(body['payments']).toBeUndefined();
      flushPlace(request, fakePlace({ name: 'Altro' }), '"v2"');
      await view.view();
      expect(view.text()).not.toContain(UNSAVED);
    });

    it('reads the series again when the company of the place changed', async () => {
      const view = await renderPlacePage();
      await view.type(COMPANY_LABEL, COMPANY_2);
      drainSeries();
      const request = await save(view);
      expect(request.request.body).toEqual({ companyId: COMPANY_2 });
      flushPlace(request, fakePlace({ companyId: COMPANY_2 }), '"v2"');
      await view.view();
      await answerPlaceLookups();
      await view.view();
      expect(view.text()).not.toContain(UNSAVED);
    });

    it('offers to reload after a 412 and drops every draft', async () => {
      const { type, goTo, click, text, view, control } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await goTo('settings');
      await click(SAVE);
      fail(expectPlace(), 412, 'PRECONDITION_FAILED');
      await view();
      expect(text()).toContain('PLACES.CONFLICT');
      await click('PLACES.RELOAD');
      flushPlace(expectPlace(), fakePlace({ name: 'Cambiato' }), '"v9"');
      await view();
      expect(text()).not.toContain('PLACES.CONFLICT');
      await goTo(PLACE);
      expect(control(NAME).value).toBe('Cambiato');
      expect(text()).not.toContain(UNSAVED);
    });

    it('says the user is not allowed and marks the fields on a 403 with details', async () => {
      const { type, click, text, view, error, tabs } = await renderPlacePage();
      await type(STATUS, 'disabled');
      await click(SAVE);
      fail(expectPlace(), 403, 'FORBIDDEN', [{ field: 'license.status', issue: 'notAllowed' }]);
      await view();
      expect(text()).toContain('PLACES.NOT_ALLOWED');
      expect(error(STATUS)).toBe('FORM.ISSUE.NOT_ALLOWED');
      expect(tabs()[0].textContent).toContain(`${ERRORS} {"count":1}`);
    });

    it('shows the failure of a conflict and of an unexpected error, and lets the user try again', async () => {
      const { type, click, text, view, button } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await click(SAVE);
      fail(expectPlace(), 409, 'CONFLICT');
      await view();
      expect(text()).toContain('ERRORS.API.CONFLICT');
      expect(text()).not.toContain('PLACES.RELOAD');
      await click(SAVE);
      fail(expectPlace(), 500, 'INTERNAL_ERROR');
      await view();
      expect(text()).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(button(SAVE)?.disabled).toBe(false);
    });

    it('puts the 422 details on the fields of different tabs and entries and marks them', async () => {
      const view = await renderPlacePage();
      await view.type(NAME, 'Nuovo');
      await view.goTo('settings');
      await view.toggle(FAST_LOGIN, true);
      await view.goTo('hours');
      const request = await save(view);
      fail(request, 422, 'VALIDATION_ERROR', [
        { field: 'name', issue: 'maxLength' },
        { field: 'license.expirationDate', issue: 'format' },
        { field: 'devices.items.0.name', issue: 'required' },
        { field: 'openingHours.timezone', issue: 'format' },
        { field: 'cashSettings.fastLogin', issue: 'invalid' },
        { field: 'cashSettings.receiptsCancellation', issue: 'invalid' },
        { field: 'payments.paymentTypes.0.name', issue: 'required' },
      ]);
      await afterAnswer(view);
      expect(view.text()).not.toContain('ERRORS.API');
      const badge = (index: number) => view.tabs()[index].textContent;
      expect(badge(0)).toContain(`${ERRORS} {"count":2}`);
      expect(badge(1)).toContain(`${ERRORS} {"count":1}`);
      expect(badge(5)).toContain(`${ERRORS} {"count":1}`);
      expect(badge(7)).toContain(`${ERRORS} {"count":3}`);
      expect(badge(2)).not.toContain(ERRORS);
      // The first tab with an error is opened.
      expect(view.router.url).toBe(PLACE_PATH);
      expect(view.error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
      await view.goTo('settings');
      const marks = (id: string) =>
        view.entries().find((a) => a.getAttribute('href')!.endsWith(`/${id}`))!
          .textContent as string;
      expect(marks('general')).toContain(`${ERRORS} {"count":1}`);
      expect(marks('other')).toContain(`${ERRORS} {"count":1}`);
      expect(marks('payments')).toContain(`${ERRORS} {"count":1}`);
      expect(marks('print')).not.toContain(ERRORS);
      await view.goToEntry('payments');
      expect(view.error('PLACES.PAYMENTS.NAME 1')).toBe('FORM.ISSUE.REQUIRED');
    });

    it('shows a general failure when a detail matches no field', async () => {
      const { type, click, text, view, error } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await click(SAVE);
      fail(expectPlace(), 422, 'VALIDATION_ERROR', [
        { field: 'unknown.thing', issue: 'invalid' },
        { field: 'name', issue: 'maxLength' },
      ]);
      await view();
      expect(text()).toContain('ERRORS.API.VALIDATION_ERROR');
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    });

    it('opens the entry of the other settings when its key alone is wrong, the general one with others', async () => {
      const only = await renderPlacePage();
      await only.goTo('settings');
      await only.toggle(FAST_LOGIN, true);
      await only.goTo('hours');
      fail(await save(only), 422, 'VALIDATION_ERROR', [
        { field: 'cashSettings.receiptsCancellation', issue: 'invalid' },
      ]);
      await afterAnswer(only);
      expect(only.router.url).toBe(`${PLACE_PATH}/settings/other`);
      const mixed = await freshPlacePage({ path: 'settings' });
      await mixed.toggle(FAST_LOGIN, true);
      await mixed.goTo('hours');
      fail(await save(mixed), 422, 'VALIDATION_ERROR', [
        { field: 'cashSettings.receiptsCancellation', issue: 'invalid' },
        { field: 'cashSettings.fastLogin', issue: 'invalid' },
      ]);
      await afterAnswer(mixed);
      expect(mixed.router.url).toBe(`${PLACE_PATH}/settings/general`);
    });

    it('opens the tab of a section with an error and focuses its first invalid field', async () => {
      const view = await renderPlacePage({ path: 'hours' });
      await view.click('PLACES.HOURS.ADD_SLOT');
      await view.goTo('settings');
      await view.click(SAVE);
      await afterAnswer(view);
      expect(view.router.url).toBe(`${PLACE_PATH}/hours`);
      expect(view.root.querySelector('fc-hours-schedule')).not.toBeNull();
    });

    it('keeps the user on the general tab, with the focus on the invalid field', async () => {
      const { type, click, control, view, error, router } = await renderPlacePage();
      await type(NAME, '');
      await click(SAVE);
      await view();
      await settle();
      await view();
      expect(router.url).toBe(PLACE_PATH);
      expect(document.activeElement).toBe(control(NAME));
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    });
  });

  describe('lookups', () => {
    it('reads the companies, the series and the price lists of a user who can', async () => {
      const { control } = await renderPlacePage();
      expect(optionsOf(control(COMPANY_LABEL) as HTMLSelectElement)).toEqual([
        '',
        '665f1c2e9b1d4a0012ab34b2',
        COMPANY_2,
      ]);
      expect(optionsOf(control('PLACES.GENERAL.INVOICE_SERIES') as HTMLSelectElement)).toEqual([
        '',
        'FE',
        'NC',
      ]);
    });

    it('does not read the companies of a user who cannot, but reads the series from the place', async () => {
      const { control } = await renderPlacePage({
        profile: { role: 'PA', groupId: GROUP },
        permissions: MINIMAL,
      });
      expect(optionsOf(control(COMPANY_LABEL) as HTMLSelectElement)).toEqual([
        '',
        '665f1c2e9b1d4a0012ab34b2',
      ]);
      expect(optionsOf(control('PLACES.GENERAL.INVOICE_SERIES') as HTMLSelectElement)).toEqual([
        '',
        'FE',
        'NC',
      ]);
    });

    it.each(['groups:read', 'users:read', 'fidelity:read'])(
      'reads the price lists with %s',
      async (permission) => {
        const { control } = await renderPlacePage({ permissions: [...MINIMAL, permission] });
        expect(optionsOf(control('PLACES.GENERAL.PRICE_LIST') as HTMLSelectElement)).toEqual([
          '',
          '665f1c2e9b1d4a0012ab34f0',
          '665f1c2e9b1d4a0012ab34f1',
        ]);
      },
    );

    it('reads the lookups of the settings entries with the permissions to, and only then', async () => {
      const entries = [
        'rooms-settings',
        'delivery',
        'reservations',
        'self-ordering',
        'kiosk',
        'tobacco',
        'appointments',
      ];
      const full = await renderPlacePage({ path: 'settings' });
      for (const entry of entries) {
        await full.goToEntry(entry);
        if (entry === 'tobacco') {
          expect(full.text()).toContain('Altra Azienda');
        }
      }
      const narrow = await freshPlacePage({ path: 'settings', permissions: MINIMAL });
      for (const entry of entries) {
        await narrow.goToEntry(entry);
      }
      expect(narrow.root.querySelector('fc-place-settings form')).not.toBeNull();
    });

    it('reads the tax rates, the users and the favorites the tabs of devices and rooms show', async () => {
      const view = await renderPlacePage({
        path: 'devices',
        permissions: [...PLACE_PERMISSIONS, 'users:read'],
      });
      await view.goTo('rooms');
      expect(view.text()).toContain('mario');
      expect(view.text()).toContain('IVA ordinaria');
      await view.goTo('devices');
      await view.click('PLACES.DEVICES.EDIT');
      expect(view.text()).toContain('PLACES.DEVICES.FAVORITES');
      expect(view.text()).toContain('Preferiti');
      const narrow = await freshPlacePage({ path: 'devices', permissions: MINIMAL });
      await narrow.click('PLACES.DEVICES.EDIT');
      expect(narrow.text()).toContain('PLACES.DEVICES.FAVORITES');
      expect(narrow.text()).not.toContain('Preferiti');
    });

    it('reads the languages only with the permission to update the place or read the group', async () => {
      const view = await renderPlacePage({
        path: 'settings/kiosk',
        permissions: ['places:read', 'profile:read'],
      });
      expect(view.root.querySelector('fc-place-settings form')).not.toBeNull();
    });

    it('asks for each lookup once, however many times it is shown', async () => {
      const { goTo } = await renderPlacePage();
      await goTo('settings');
      await goTo(PLACE);
      await goTo('settings');
      await goTo(PLACE);
    });
  });

  describe('creation', () => {
    const COMPANY_ID = '665f1c2e9b1d4a0012ab34b2';

    async function fill(view: View, values: Record<string, string> = {}) {
      const all: Record<string, string> = {
        [NAME]: 'Nuovo Bar',
        [COMPANY_LABEL]: COMPANY_ID,
        'PLACES.GENERAL.STREET': 'Via Nuova 1',
        'PLACES.GENERAL.POSTCODE': '20100',
        [CITY]: 'Milano',
        ...values,
      };
      for (const [label, value] of Object.entries(all)) {
        await view.type(label, value);
      }
    }

    it('shows an empty form, the create button and no tabs nor menu', async () => {
      const { root, text, button, control } = await renderPlacePage({ path: 'new' });
      expect(root.querySelector('h1')?.textContent).toBe('PLACES.NEW_TITLE');
      expect(root.querySelector('nav')).toBeNull();
      expect(button(SAVE)).toBeUndefined();
      expect(button('PLACES.TRANSFER.DOWNLOAD')).toBeUndefined();
      expect(button('PLACES.CREATE')?.disabled).toBe(false);
      expect(control(NAME).value).toBe('');
      expect(control('PLACES.GENERAL.COUNTRY').value).toBe('IT');
      expect(text()).not.toContain(UNSAVED);
    });

    it('asks for the required fields before sending anything, focusing the first text field', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await view.click('PLACES.CREATE');
      await afterAnswer(view);
      const labels = [
        NAME,
        COMPANY_LABEL,
        'PLACES.GENERAL.STREET',
        'PLACES.GENERAL.POSTCODE',
        CITY,
      ];
      for (const label of labels) {
        expect(view.error(label)).toBe('FORM.ISSUE.REQUIRED');
      }
      await view.type(COMPANY_LABEL, COMPANY_ID);
      await view.click('PLACES.CREATE');
      await afterAnswer(view);
      expect(view.error(COMPANY_LABEL)).toBe('');
      expect(document.activeElement).toBe(view.control(NAME));
    });

    it('creates a place for a platform administrator with the plan, and opens it', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await fill(view, { [PLAN]: 'enterprice' });
      expect(optionsOf(view.control(PLAN) as HTMLSelectElement)).toContain('desk-secondary');
      await view.click('PLACES.CREATE');
      const req = backend().expectOne(PLACES_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(req.request.body).toEqual({
        name: 'Nuovo Bar',
        companyId: COMPANY_ID,
        address: { street: 'Via Nuova 1', postcode: '20100', city: 'Milano', country: 'IT' },
        license: { plan: 'enterprice' },
      });
      flushPlace(req, fakePlace({ name: 'Nuovo Bar' }), ETAG);
      await afterAnswer(view);
      expect(view.toasts()).toEqual(['PLACES.CREATED']);
      expect(view.router.url).toBe(PLACE_PATH);
      flushPlace(backend().expectOne(PLACE_URL), fakePlace({ name: 'Nuovo Bar' }), ETAG);
      await view.view();
      expect(view.harness.routeNativeElement?.querySelector('h1')?.textContent).toBe('Nuovo Bar');
      drainSeries();
      await answerPlaceLookups();
    });

    it('sends every optional field the user filled in', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await fill(view);
      for (const [label, value] of Object.entries({
        'PLACES.GENERAL.PROVINCE': 'MI',
        'PLACES.GENERAL.CONTACT_NAME': 'Mario',
        'PLACES.GENERAL.EMAIL': 'a@b.it',
        'PLACES.GENERAL.PHONE': '123',
        'PLACES.GENERAL.PRICE_LIST': '665f1c2e9b1d4a0012ab34f0',
        'PLACES.GENERAL.ECOMMERCE_PRICE_LIST': '665f1c2e9b1d4a0012ab34f1',
      })) {
        await view.type(label, value);
      }
      drainSeries();
      await view.view();
      await view.type('PLACES.GENERAL.INVOICE_SERIES', 'FE');
      await view.toggle('Listino 1', true);
      await view.click('PLACES.CREATE');
      const req = backend().expectOne(PLACES_URL);
      expect(req.request.body).toEqual({
        name: 'Nuovo Bar',
        companyId: COMPANY_ID,
        address: {
          street: 'Via Nuova 1',
          postcode: '20100',
          city: 'Milano',
          country: 'IT',
          province: 'MI',
        },
        contactName: 'Mario',
        email: 'a@b.it',
        phone: '123',
        priceListId: '665f1c2e9b1d4a0012ab34f0',
        ecommercePriceListId: '665f1c2e9b1d4a0012ab34f1',
        invoiceSeries: 'FE',
        priceLists: [
          { id: '665f1c2e9b1d4a0012ab34f0', allYouCanEat: false, ayceCode1: null, ayceCode2: null },
        ],
        license: { plan: 'basic' },
      });
      fail(req, 500, 'INTERNAL_ERROR');
      await view.view();
    });

    it('does not send the plan of a user who does not choose it', async () => {
      const view = await renderPlacePage({
        path: 'new',
        profile: SA,
        permissions: [
          'places:read',
          'places:create',
          'companies:read',
          'groups:read',
          'profile:read',
        ],
      });
      expect(view.root.textContent).not.toContain(PLAN);
      await fill(view);
      await view.click('PLACES.CREATE');
      const req = backend().expectOne(PLACES_URL);
      expect(req.request.body).toEqual({
        name: 'Nuovo Bar',
        companyId: COMPANY_ID,
        address: { street: 'Via Nuova 1', postcode: '20100', city: 'Milano', country: 'IT' },
      });
      fail(req, 500, 'INTERNAL_ERROR');
      await view.view();
    });

    it('lets a dealer choose the plan, but not desk-secondary', async () => {
      const view = await renderPlacePage({ path: 'new', profile: DEALER });
      expect(view.control(PLAN).disabled).toBe(false);
      expect(optionsOf(view.control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
      ]);
      await fill(view, { [PLAN]: 'tgm-secondary' });
      await view.click('PLACES.CREATE');
      const req = backend().expectOne(PLACES_URL);
      expect(req.request.body).toMatchObject({ license: { plan: 'tgm-secondary' } });
      fail(req, 500, 'INTERNAL_ERROR');
      await view.view();
    });

    it('reuses the Idempotency-Key on a retry of the same body and changes it with the body', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await fill(view);
      await view.click('PLACES.CREATE');
      const first = backend().expectOne(PLACES_URL);
      const key = first.request.headers.get('Idempotency-Key');
      fail(first, 500, 'INTERNAL_ERROR');
      await view.view();
      expect(view.text()).toContain('ERRORS.API.INTERNAL_ERROR');
      await view.click('PLACES.CREATE');
      const retry = backend().expectOne(PLACES_URL);
      expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
      fail(retry, 500, 'INTERNAL_ERROR');
      await view.view();
      await view.type(NAME, 'Altro nome');
      await view.click('PLACES.CREATE');
      const changed = backend().expectOne(PLACES_URL);
      expect(changed.request.headers.get('Idempotency-Key')).not.toBe(key);
      fail(changed, 500, 'INTERNAL_ERROR');
      await view.view();
    });

    it('puts a 422 of the creation on the fields', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await fill(view);
      await view.click('PLACES.CREATE');
      fail(backend().expectOne(PLACES_URL), 422, 'VALIDATION_ERROR', [
        { field: 'companyId', issue: 'invalid' },
        { field: 'address.postcode', issue: 'format' },
      ]);
      await afterAnswer(view);
      expect(view.error(COMPANY_LABEL)).toBe('FORM.ISSUE.INVALID');
      expect(view.error('PLACES.GENERAL.POSTCODE')).toBe('FORM.ISSUE.FORMAT');
    });
  });

  describe('transfer menu', () => {
    const UPLOAD = 'PLACES.TRANSFER.UPLOAD';
    const DOWNLOAD = 'PLACES.TRANSFER.DOWNLOAD';

    /** Puts a file in the chooser as the browser does and lets the page read it. */
    async function choose(view: View, content: string, size = content.length): Promise<void> {
      const input = view.root.querySelector<HTMLInputElement>('input[type=file]')!;
      const file = { size, text: () => Promise.resolve(content) };
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
      await settle();
      await view.view();
    }

    it('is offered to platform administrators and dealers, not to the others', async () => {
      const psa = await renderPlacePage();
      expect(psa.button(DOWNLOAD)).toBeDefined();
      expect(psa.button(UPLOAD)).toBeDefined();
      const dealer = await freshPlacePage({ profile: DEALER });
      expect(dealer.button(DOWNLOAD)).toBeDefined();
      const sa = await freshPlacePage({ profile: SA });
      expect(sa.button(DOWNLOAD)).toBeUndefined();
      expect(sa.root.querySelector('input[type=file]')).toBeNull();
    });

    it('only downloads for who cannot write', async () => {
      const { button, root } = await renderPlacePage({
        permissions: ['places:read', 'profile:read'],
      });
      expect(button(DOWNLOAD)).toBeDefined();
      expect(button(UPLOAD)).toBeUndefined();
      expect(root.querySelector('input[type=file]')).not.toBeNull();
    });

    it('downloads the settings of the form as a JSON file', async () => {
      const view = await renderPlacePage();
      const blobs: Blob[] = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:settings';
      });
      URL.revokeObjectURL = vi.fn();
      const clicked: HTMLAnchorElement[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this);
      });
      await view.click(DOWNLOAD);
      expect(blobs).toHaveLength(1);
      expect(blobs[0].type).toBe('application/json');
      expect(clicked[0].download).toBe('settings.json');
      expect(clicked[0].href).toBe('blob:settings');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:settings');
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(blobs[0]);
      });
      expect(text).toBe(exportSettings(toModel(fakePlace())));
    });

    it('opens the file chooser', async () => {
      const view = await renderPlacePage();
      const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
      await view.click(UPLOAD);
      expect(click).toHaveBeenCalledTimes(1);
    });

    it('puts the values of the file in the form without saving anything', async () => {
      const view = await renderPlacePage();
      await choose(
        view,
        JSON.stringify({
          general: { fastLogin: true, workshiftNames: ['Mattina'], logs: 'no' },
          receipt: { serverPrint: true },
          roomsSettings: { tipValues: [{ type: 'p', value: 5 }] },
        }),
      );
      expect(view.toasts()).toEqual(['PLACES.TRANSFER.IMPORTED {"applied":4,"ignored":1}']);
      expect(view.tabs()[7].textContent).toContain(UNSAVED);
      expect(view.button(SAVE)?.disabled).toBe(false);
      await view.goTo('settings');
      expect((view.control(FAST_LOGIN) as HTMLInputElement).checked).toBe(true);
    });

    it('keeps the lists of the form when the file has none', async () => {
      const view = await renderPlacePage();
      await choose(view, JSON.stringify({ general: { fastLogin: true } }));
      expect(view.toasts()).toEqual(['PLACES.TRANSFER.IMPORTED {"applied":1,"ignored":0}']);
      const request = await save(view);
      const body = request.request.body as Record<string, Record<string, unknown>>;
      expect(body['cashSettings']['workshiftNames']).toEqual(['Pranzo', 'Cena']);
      expect(body['tables']).toBeUndefined();
      flushPlace(request);
      await view.view();
    });

    it('refuses a file that is not a settings file', async () => {
      const view = await renderPlacePage();
      await choose(view, 'not json');
      expect(view.toasts()).toEqual(['PLACES.TRANSFER.IMPORT_INVALID']);
      expect(view.button(SAVE)?.disabled).toBe(true);
    });

    it('refuses a file that is too large without reading it', async () => {
      const view = await renderPlacePage();
      await choose(view, '{}', 10 * 1024 * 1024);
      expect(view.toasts()).toEqual(['PLACES.TRANSFER.IMPORT_TOO_LARGE']);
    });
  });

  describe('leaving the page', () => {
    it('leaves at once when nothing is unsaved, also from another tab', async () => {
      const { leave, goTo } = await renderPlacePage();
      await goTo('settings');
      expect(await leave()).toBe(true);
    });

    it('asks for confirmation with unsaved changes and stays when the user cancels', async () => {
      const { type, leave, dialogButton, view, router, control } = await renderPlacePage();
      await type(NAME, 'Bozza');
      const navigation = leave();
      await view();
      expect(dialogButton('PLACES.LEAVE.CONFIRM')).toBeDefined();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(await navigation).toBe(false);
      expect(router.url).toBe(PLACE_PATH);
      expect(control(NAME).value).toBe('Bozza');
    });

    it('stays when the dialog is closed with Esc', async () => {
      const { type, leave, root, view } = await renderPlacePage();
      await type(NAME, 'Bozza');
      const navigation = leave();
      await view();
      root.querySelector('dialog')!.dispatchEvent(new Event('close'));
      await view();
      expect(await navigation).toBe(false);
    });

    it('leaves when the user confirms', async () => {
      const { type, dialogButton, view, router } = await renderPlacePage();
      await type(NAME, 'Bozza');
      const navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('PLACES.LEAVE.CONFIRM').click();
      await view();
      expect(await navigation).toBe(true);
      expect(router.url).toBe('/elsewhere');
    });

    it('never asks when the user only moves between the tabs', async () => {
      const { type, goTo, router } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await goTo('settings');
      expect(router.url).toBe(`${PLACE_PATH}/settings/general`);
    });

    it('leaves a new place without asking until the user typed something, then asks', async () => {
      const untouched = await renderPlacePage({ path: 'new' });
      expect(await untouched.leave()).toBe(true);
      const { type, dialogButton, view, router } = await freshPlacePage({ path: 'new' });
      await type(NAME, 'Nuovo');
      const navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('PLACES.LEAVE.CONFIRM').click();
      await view();
      expect(await navigation).toBe(true);
    });
  });
});
