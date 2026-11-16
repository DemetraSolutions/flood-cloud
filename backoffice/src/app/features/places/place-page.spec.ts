import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, settle } from '../../../testing/api';
import {
  GROUP,
  PLACE,
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

const NAME = 'PLACES.GENERAL.NAME';
const CITY = 'PLACES.GENERAL.CITY';
const COMPANY_LABEL = 'PLACES.GENERAL.COMPANY';
const SAVE_ALL = 'PLACES.SAVE_ALL';
const SAVE = 'COMMON.SAVE';
const STATUS = 'PLACES.LICENSE.STATUS';
const PLAN = 'PLACES.LICENSE.PLAN';
const EXPIRATION = 'PLACES.LICENSE.EXPIRATION_DATE';

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

describe('PlacePage', () => {
  describe('header', () => {
    it('shows the name with "Salva tutto" disabled until something changes', async () => {
      const { root, button, type } = await renderPlacePage();
      expect(root.querySelector('h1')?.textContent).toBe('Bar Roma');
      expect(button(SAVE_ALL)?.disabled).toBe(true);
      await type(NAME, 'Altro');
      expect(button(SAVE_ALL)?.disabled).toBe(false);
    });

    it('tells a place in the trash or disabled', async () => {
      const trashed = await renderPlacePage({ place: fakePlace({ trashed: true }) });
      expect(trashed.text()).toContain('PLACES.STATUS.TRASHED');
      const disabled = await freshPlacePage({
        place: fakePlace({
          license: { plan: 'advanced', expirationDate: null, status: 'disabled', sentry: false },
        }),
      });
      expect(disabled.text()).toContain('PLACES.STATUS.DISABLED');
      expect(disabled.text()).not.toContain('PLACES.STATUS.TRASHED');
    });

    it('offers no saving and says so to whoever cannot update', async () => {
      const { button, text, control } = await renderPlacePage({
        permissions: ['places:read', 'companies:read', 'groups:read', 'profile:read'],
      });
      expect(button(SAVE_ALL)).toBeUndefined();
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

    it('asks for the features of the group and takes the group as the working one', async () => {
      const { ensure } = await renderPlacePage();
      expect(ensure).toHaveBeenCalledWith(GROUP);
      expect(TestBed.inject(GroupContext).groupId()).toBe(GROUP);
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
      expect(root.querySelector<HTMLAnchorElement>('p a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/places`,
      );
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
      'license',
      'opening-hours',
      'cash',
      'printing',
      'payments',
      'tables',
      'reservations',
      'delivery',
      'self-ordering',
      'kiosk',
      'appointments',
      'external-display',
      'fidelity',
      'tobacco',
      'media',
    ];

    it('shows every tab to a platform administrator whose group has the modules', async () => {
      const { tabNames } = await renderPlacePage();
      expect(tabNames()).toEqual(ALL);
    });

    it('hides the tabs of the modules the group does not have, keeping tobacco for the privileged', async () => {
      const none = await renderPlacePage({ features: [] });
      expect(none.tabNames()).toEqual([
        PLACE,
        'license',
        'opening-hours',
        'cash',
        'printing',
        'payments',
        'kiosk',
        'external-display',
        'fidelity',
        'tobacco',
      ]);
      const dealer = await freshPlacePage({ features: [], profile: { role: 'D' } });
      expect(dealer.tabNames()).toContain('tobacco');
      const store = await freshPlacePage({
        features: [],
        profile: { role: 'SA', groupId: GROUP },
      });
      expect(store.tabNames()).not.toContain('tobacco');
    });

    it('shows the tabs of each module', async () => {
      const rooms = await renderPlacePage({
        features: ['rooms'],
        profile: { role: 'SA', groupId: GROUP },
      });
      expect(rooms.tabNames()).toEqual(
        expect.arrayContaining(['tables', 'reservations', 'delivery', 'self-ordering']),
      );
      expect(rooms.tabNames()).not.toContain('appointments');
      expect(rooms.tabNames()).not.toContain('media');
      const others = await freshPlacePage({
        features: ['appointments', 'media', 'tobaccosGamesMonopoly'],
        profile: { role: 'SA', groupId: GROUP },
      });
      expect(others.tabNames()).toEqual(
        expect.arrayContaining(['appointments', 'media', 'tobacco']),
      );
      expect(others.tabNames()).not.toContain('tables');
    });

    it('shows only the general and license tabs of a secondary plan', async () => {
      const { tabNames } = await renderPlacePage({
        place: fakePlace({
          license: {
            plan: 'tgm-secondary',
            expirationDate: null,
            status: 'active',
            sentry: false,
          },
        }),
      });
      expect(tabNames()).toEqual([PLACE, 'license']);
    });

    it('marks the current tab and the tabs with unsaved changes', async () => {
      const { tabs, goTo, type, typeIn, root } = await renderPlacePage();
      expect(tabs()[0].getAttribute('aria-current')).toBe('page');
      await type(NAME, 'Bozza');
      expect(tabs()[0].textContent).toContain('PLACES.UNSAVED');
      await goTo('license');
      expect(tabs()[0].getAttribute('aria-current')).toBeNull();
      expect(tabs()[1].getAttribute('aria-current')).toBe('page');
      expect(tabs()[1].textContent).not.toContain('PLACES.UNSAVED');
      await typeIn(root, STATUS, 'disabled');
      expect(tabs()[1].textContent).toContain('PLACES.UNSAVED');
    });

    it('keeps the drafts of the tabs while the user moves between them', async () => {
      const { type, goTo, control, text } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await goTo('license');
      await type(STATUS, 'disabled');
      await goTo(PLACE);
      expect(control(NAME).value).toBe('Bozza');
      expect(text()).toContain('PLACES.UNSAVED');
      await goTo('license');
      expect(control(STATUS).value).toBe('disabled');
    });
  });

  describe('permissions', () => {
    it('lets a platform administrator change every reserved field', async () => {
      const { control } = await renderPlacePage({ path: 'license' });
      expect(control(PLAN).disabled).toBe(false);
      expect(control(EXPIRATION).disabled).toBe(false);
      expect(control(STATUS).disabled).toBe(false);
      expect(control('PLACES.LICENSE.SENTRY').disabled).toBe(false);
    });

    it('lets a dealer change only the expiration date and the status', async () => {
      const { control, text } = await renderPlacePage({
        path: 'license',
        profile: { role: 'D', groupId: null },
      });
      expect(control(PLAN).disabled).toBe(true);
      expect(control(EXPIRATION).disabled).toBe(false);
      expect(control(STATUS).disabled).toBe(false);
      expect(control('PLACES.LICENSE.SENTRY').disabled).toBe(true);
      expect(text()).not.toContain('PLACES.RESERVED_NOTE');
    });

    it.each(['SA', 'CA', 'PA'] as const)(
      'shows the license to a %s read-only with a note',
      async (role) => {
        const { control, text } = await renderPlacePage({
          path: 'license',
          profile: { role, groupId: GROUP },
        });
        for (const label of [PLAN, EXPIRATION, STATUS, 'PLACES.LICENSE.SENTRY']) {
          expect(control(label).disabled).toBe(true);
        }
        expect(text()).toContain('PLACES.RESERVED_NOTE');
        expect(text()).toContain('PLACES.LICENSE.PLAN_HINT');
      },
    );

    it('stops a store administrator from moving the place to another company', async () => {
      const pa = await renderPlacePage({ profile: { role: 'PA', groupId: GROUP } });
      expect(pa.control(COMPANY_LABEL).disabled).toBe(true);
      const sa = await freshPlacePage({ profile: { role: 'SA', groupId: GROUP } });
      expect(sa.control(COMPANY_LABEL).disabled).toBe(false);
      expect(sa.control(NAME).disabled).toBe(false);
    });

    it('locks the web widget of the appointments to whoever cannot reserve', async () => {
      const sa = await renderPlacePage({
        path: 'appointments',
        profile: { role: 'SA', groupId: GROUP },
      });
      expect(sa.root.querySelector('fc-place-fields')).not.toBeNull();
      const disabled = [
        ...sa.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
      ].filter((box) => box.disabled);
      expect(disabled).toHaveLength(1);
      const psa = await freshPlacePage({ path: 'appointments' });
      expect(
        [...psa.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter(
          (box) => box.disabled,
        ),
      ).toHaveLength(0);
    });

    it('offers the stored plan even when it is a historical one', async () => {
      const { control } = await renderPlacePage({
        path: 'license',
        place: fakePlace({
          license: { plan: 'professional', expirationDate: null, status: 'active', sentry: false },
        }),
      });
      expect(optionsOf(control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
        'desk-secondary',
        'professional',
      ]);
      expect(control(PLAN).value).toBe('professional');
      const label = [...(control(PLAN) as HTMLSelectElement).options].map((o) =>
        o.textContent?.trim(),
      );
      expect(label).toContain('professional');
      expect(label).toContain('PLACES.PLAN.TGM_SECONDARY');
    });

    it('does not add a stored plan that is already offered, nor an empty one', async () => {
      const known = await renderPlacePage({ path: 'license' });
      expect(optionsOf(known.control(PLAN) as HTMLSelectElement)).toHaveLength(5);
      const empty = await freshPlacePage({
        path: 'license',
        place: fakePlace({
          license: { plan: null, expirationDate: null, status: 'active', sentry: false },
        }),
      });
      expect(optionsOf(empty.control(PLAN) as HTMLSelectElement)).toHaveLength(5);
    });

    it('does not offer desk-secondary to a dealer', async () => {
      const { control } = await renderPlacePage({
        path: 'license',
        profile: { role: 'D', groupId: null },
      });
      expect(optionsOf(control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
      ]);
    });
  });

  describe('saving', () => {
    it('saves the general tab with a PATCH of the changed fields only', async () => {
      const { type, click, toasts, view, text, button } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await type(CITY, 'Roma');
      await click(SAVE);
      const req = expectPlace();
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({ name: 'Nuovo', address: { city: 'Roma' } });
      flushPlace(
        req,
        fakePlace({
          name: 'Nuovo',
          address: {
            street: 'Via Roma 1',
            postcode: '20100',
            city: 'Roma',
            province: 'MI',
            country: 'IT',
          },
        }),
      );
      await view();
      expect(toasts()).toEqual(['PLACES.SAVED']);
      expect(text()).not.toContain('PLACES.UNSAVED');
      expect(button(SAVE)?.disabled).toBe(true);
      // The next save presents the new version.
      await type(NAME, 'Ancora');
      await click(SAVE);
      const next = expectPlace();
      expect(next.request.headers.get('If-Match')).toBe('"v2"');
      expect(next.request.body).toEqual({ name: 'Ancora' });
      flushPlace(next, fakePlace({ name: 'Ancora' }), '"v3"');
      await view();
    });

    it('sends every changed field of the general tab, clearing the optional ones with null', async () => {
      const { type, click, view, toggle } = await renderPlacePage({ lookups: true });
      await type(NAME, 'N');
      await type(COMPANY_LABEL, '665f1c2e9b1d4a0012ab34b9');
      await type('PLACES.GENERAL.STREET', 'Via Nuova 2');
      await type('PLACES.GENERAL.POSTCODE', '00100');
      await type('PLACES.GENERAL.COUNTRY', 'FR');
      await type('PLACES.GENERAL.PROVINCE', '');
      await type('PLACES.GENERAL.CONTACT_NAME', '');
      await type('PLACES.GENERAL.EMAIL', '');
      await type('PLACES.GENERAL.PHONE', '');
      await type('PLACES.GENERAL.PRICE_LIST', '');
      await type('PLACES.GENERAL.ECOMMERCE_PRICE_LIST', '665f1c2e9b1d4a0012ab34f1');
      await type('PLACES.GENERAL.INVOICE_SERIES', '');
      await toggle('Listino 2', true);
      await click(SAVE);
      const req = expectPlace();
      expect(req.request.body).toMatchObject({
        name: 'N',
        address: { street: 'Via Nuova 2', postcode: '00100', country: 'FR', province: '' },
        contactName: null,
        email: null,
        phone: null,
        priceListId: null,
        ecommercePriceListId: '665f1c2e9b1d4a0012ab34f1',
        invoiceSeries: null,
        priceLists: [
          { id: '665f1c2e9b1d4a0012ab34f0', allYouCanEat: true, ayceCode1: '12', ayceCode2: null },
          { id: '665f1c2e9b1d4a0012ab34f1', allYouCanEat: false, ayceCode1: null, ayceCode2: null },
        ],
      });
      req.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
    });

    it('saves the license with a PUT of the whole block, keeping the stored instant', async () => {
      const { type, click, toasts, view, control } = await renderPlacePage({ path: 'license' });
      await type(STATUS, 'disabled');
      await click(SAVE);
      const req = expectPlace('/license');
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({
        plan: 'advanced',
        expirationDate: '2030-01-01T10:30:00.000Z',
        status: 'disabled',
        sentry: false,
      });
      flushPlace(
        req,
        fakePlace({
          license: {
            plan: 'advanced',
            expirationDate: '2030-01-01T10:30:00.000Z',
            status: 'disabled',
            sentry: false,
          },
        }),
      );
      await view();
      expect(toasts()).toEqual(['PLACES.SAVED']);
      expect(control(STATUS).value).toBe('disabled');
    });

    it('sends the new expiration date as written, or null when cleared', async () => {
      const { type, click, view } = await renderPlacePage({ path: 'license' });
      await type(EXPIRATION, '2031-02-03');
      await click(SAVE);
      const req = expectPlace('/license');
      expect(req.request.body).toMatchObject({ expirationDate: '2031-02-03' });
      flushPlace(req);
      await view();
      await type(EXPIRATION, '');
      await click(SAVE);
      const cleared = expectPlace('/license');
      expect(cleared.request.body).toMatchObject({ expirationDate: null });
      cleared.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
    });

    it('sends the sections with changes in one PATCH on "Salva tutto"', async () => {
      const { type, goTo, click, tabs, toasts, view, text, control } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await goTo('license');
      await type(STATUS, 'disabled');
      await goTo('delivery');
      await click(SAVE_ALL);
      const req = expectPlace();
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({
        name: 'Nuovo',
        license: {
          plan: 'advanced',
          expirationDate: '2030-01-01T10:30:00.000Z',
          status: 'disabled',
          sentry: false,
        },
      });
      flushPlace(
        req,
        fakePlace({
          name: 'Nuovo',
          license: {
            plan: 'advanced',
            expirationDate: '2030-01-01T10:30:00.000Z',
            status: 'disabled',
            sentry: false,
          },
        }),
      );
      await view();
      expect(toasts()).toEqual(['PLACES.SAVED']);
      expect(text()).not.toContain('PLACES.UNSAVED');
      expect(tabs()).toHaveLength(16);
      await goTo(PLACE);
      expect(control(NAME).value).toBe('Nuovo');
    });

    it('saves a tab on its own and keeps the drafts of the others', async () => {
      const { type, goTo, click, text, view, control, tabs } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await goTo('license');
      await type(STATUS, 'disabled');
      await click(SAVE);
      const req = expectPlace('/license');
      flushPlace(
        req,
        fakePlace({
          license: {
            plan: 'advanced',
            expirationDate: '2030-01-01T10:30:00.000Z',
            status: 'disabled',
            sentry: false,
          },
        }),
      );
      await view();
      expect(tabs()[0].textContent).toContain('PLACES.UNSAVED');
      expect(tabs()[1].textContent).not.toContain('PLACES.UNSAVED');
      expect(text()).toContain('PLACES.UNSAVED');
      await goTo(PLACE);
      expect(control(NAME).value).toBe('Bozza');
      await click(SAVE_ALL);
      const next = expectPlace();
      expect(next.request.headers.get('If-Match')).toBe('"v2"');
      expect(next.request.body).toEqual({ name: 'Bozza' });
      flushPlace(next, fakePlace({ name: 'Bozza' }), '"v3"');
      await view();
    });

    it('offers to reload after a 412 and drops every draft', async () => {
      const { type, goTo, click, text, view, control } = await renderPlacePage();
      await type(NAME, 'Bozza');
      await goTo('license');
      await type(STATUS, 'disabled');
      await click(SAVE_ALL);
      fail(expectPlace(), 412, 'PRECONDITION_FAILED');
      await view();
      expect(text()).toContain('PLACES.CONFLICT');
      await click('PLACES.RELOAD');
      flushPlace(expectPlace(), fakePlace({ name: 'Cambiato' }), '"v9"');
      await view();
      expect(text()).not.toContain('PLACES.CONFLICT');
      expect(control(STATUS).value).toBe('active');
      await goTo(PLACE);
      expect(control(NAME).value).toBe('Cambiato');
      expect(text()).not.toContain('PLACES.UNSAVED');
    });

    it('says the user is not allowed and marks the fields on a 403 with details', async () => {
      const { type, goTo, click, text, view, error, tabs } = await renderPlacePage();
      await goTo('license');
      await type(STATUS, 'disabled');
      await click(SAVE_ALL);
      fail(expectPlace(), 403, 'FORBIDDEN', [{ field: 'license.status', issue: 'notAllowed' }]);
      await view();
      expect(text()).toContain('PLACES.NOT_ALLOWED');
      expect(error(STATUS)).toBe('FORM.ISSUE.NOT_ALLOWED');
      expect(tabs()[1].textContent).toContain('PLACES.SECTION_ERRORS {"count":1}');
    });

    it('puts the 422 details on the fields of different tabs and marks the tabs', async () => {
      const { type, goTo, click, tabs, error, view, text, control } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await goTo('license');
      await type(STATUS, 'disabled');
      await goTo('printing');
      await click(SAVE_ALL);
      // Only the dirty sections are sent; the server complains about others as well.
      fail(expectPlace(), 422, 'VALIDATION_ERROR', [
        { field: 'name', issue: 'maxLength' },
        { field: 'address.city', issue: 'required' },
        { field: 'license.expirationDate', issue: 'format' },
        { field: 'printing.receipt.user', issue: 'format' },
        { field: 'payments.paymentTypes.0.name', issue: 'required' },
        { field: 'openingHours.timezone', issue: 'format' },
      ]);
      await view();
      expect(text()).not.toContain('ERRORS.API');
      expect(tabs()[0].textContent).toContain('PLACES.SECTION_ERRORS {"count":2}');
      expect(tabs()[1].textContent).toContain('PLACES.SECTION_ERRORS {"count":1}');
      expect(tabs()[2].textContent).toContain('PLACES.SECTION_ERRORS {"count":1}');
      expect(tabs()[4].textContent).toContain('PLACES.SECTION_ERRORS {"count":1}');
      expect(tabs()[5].textContent).toContain('PLACES.SECTION_ERRORS {"count":1}');
      await goTo('license');
      expect(error(EXPIRATION)).toBe('FORM.ISSUE.FORMAT');
      await goTo('opening-hours');
      expect(error('PLACES.HOURS.TIMEZONE')).toBe('FORM.ISSUE.FORMAT');
      await goTo(PLACE);
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(error(CITY)).toBe('FORM.ISSUE.REQUIRED');
      expect(control(NAME).value).toBe('Nuovo');
    });

    it('shows the 422 of a row of a list on the row', async () => {
      const { goTo, click, error, view, type } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await click(SAVE_ALL);
      fail(expectPlace(), 422, 'VALIDATION_ERROR', [
        { field: 'payments.paymentTypes.0.name', issue: 'required' },
      ]);
      await view();
      await goTo('payments');
      expect(error('PLACES.PAYMENTS.NAME 1')).toBe('FORM.ISSUE.REQUIRED');
    });

    it('shows a general failure when a detail matches no field', async () => {
      const { type, click, text, view, error } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await click(SAVE_ALL);
      fail(expectPlace(), 422, 'VALIDATION_ERROR', [
        { field: 'unknown.thing', issue: 'invalid' },
        { field: 'name', issue: 'maxLength' },
      ]);
      await view();
      expect(text()).toContain('ERRORS.API.VALIDATION_ERROR');
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    });

    it('shows a general failure on an error that is not about a field', async () => {
      const { type, click, text, view, button } = await renderPlacePage();
      await type(NAME, 'Nuovo');
      await click(SAVE_ALL);
      fail(expectPlace(), 500, 'INTERNAL_ERROR');
      await view();
      expect(text()).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(text()).not.toContain('PLACES.RELOAD');
      expect(button(SAVE_ALL)?.disabled).toBe(false);
    });

    it('opens the first tab with an error on "Salva tutto" and focuses its field', async () => {
      const { typeIn, goTo, click, control, router, tabs, view, root, button } =
        await renderPlacePage({ path: 'license' });
      await typeIn(root, STATUS, 'disabled');
      await goTo('opening-hours');
      await click('PLACES.HOURS.ADD_SLOT');
      await goTo('license');
      await click(SAVE_ALL);
      await view();
      await settle();
      await view();
      expect(router.url).toBe(`/groups/${GROUP}/places/${PLACE}/opening-hours`);
      expect(document.activeElement).toBe(control('PLACES.HOURS.START 2'));
      expect(tabs()[2].textContent).toContain('PLACES.SECTION_ERRORS');
      expect(button('COMMON.SAVE')).toBeDefined();
    });

    it('focuses the first invalid field of the tab when it saves on its own', async () => {
      const { type, click, control, view, error, router } = await renderPlacePage();
      await type(NAME, '');
      await click(SAVE);
      await view();
      await settle();
      await view();
      expect(router.url).toBe(`/groups/${GROUP}/places/${PLACE}`);
      expect(document.activeElement).toBe(control(NAME));
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('opens the tab of a block saved on its own when it has an error', async () => {
      const { goTo, click, router, view, root } = await renderPlacePage({
        path: 'opening-hours',
      });
      await click('PLACES.HOURS.ADD_SLOT');
      await goTo('license');
      await goTo('opening-hours');
      await click(SAVE);
      await view();
      await settle();
      await view();
      expect(router.url).toBe(`/groups/${GROUP}/places/${PLACE}/opening-hours`);
      expect(root.querySelector('fc-hours-schedule')).not.toBeNull();
    });
  });

  describe('lookups', () => {
    it('asks for each lookup once, however many times a tab is opened', async () => {
      const { goTo } = await renderPlacePage();
      await goTo('license');
      await goTo(PLACE);
      await goTo('license');
      await goTo(PLACE);
    });

    it('reads the companies of a user who can read them and the series of the company', async () => {
      const { control } = await renderPlacePage();
      expect(optionsOf(control(COMPANY_LABEL) as HTMLSelectElement)).toEqual([
        '',
        '665f1c2e9b1d4a0012ab34b2',
        '665f1c2e9b1d4a0012ab34b9',
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
        permissions: ['places:read', 'places:update', 'profile:read'],
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
      expect(optionsOf(control('PLACES.GENERAL.PRICE_LIST') as HTMLSelectElement)).toEqual([
        '',
        '665f1c2e9b1d4a0012ab34f0',
      ]);
    });

    it.each(['groups:read', 'users:read', 'fidelity:read'])(
      'reads the price lists with %s',
      async (permission) => {
        const { control } = await renderPlacePage({
          permissions: ['places:read', 'places:update', 'profile:read', permission],
        });
        expect(optionsOf(control('PLACES.GENERAL.PRICE_LIST') as HTMLSelectElement)).toEqual([
          '',
          '665f1c2e9b1d4a0012ab34f0',
          '665f1c2e9b1d4a0012ab34f1',
        ]);
      },
    );

    it('reads the currencies only with the permission to read the group', async () => {
      const withRead = await renderPlacePage({ path: 'delivery' });
      expect(withRead.text()).toContain('EUR');
      const without = await freshPlacePage({
        path: 'delivery',
        permissions: ['places:read', 'places:update', 'profile:read'],
      });
      expect(without.text()).not.toContain('USD');
    });

    it('reads the languages of the group for the kiosk', async () => {
      const { text } = await renderPlacePage({ path: 'kiosk' });
      expect(text()).toContain('it');
      const without = await freshPlacePage({
        path: 'kiosk',
        permissions: ['places:read', 'places:update', 'profile:read'],
      });
      expect(without.root.querySelector('form')).not.toBeNull();
    });

    it('reads the companies and the places for the tobacco tab', async () => {
      const { text } = await renderPlacePage({ path: 'tobacco' });
      expect(text()).toContain('Bar Milano');
      expect(text()).toContain('Altra Azienda');
    });

    it('says so when a list could not be read, and keeps the stored values', async () => {
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
      expect(view.control('PLACES.GENERAL.COMPANY').value).toBe('665f1c2e9b1d4a0012ab34b2');
    });

    it('says nothing while the lists are fine', async () => {
      const { text } = await renderPlacePage();
      expect(text()).not.toContain('PLACES.LOOKUP_ERROR');
    });
  });

  describe('creation', () => {
    const COMPANY_ID = '665f1c2e9b1d4a0012ab34b2';

    async function fill(
      view: Awaited<ReturnType<typeof renderPlacePage>>,
      values: Record<string, string> = {},
    ) {
      const all: Record<string, string> = {
        'PLACES.GENERAL.NAME': 'Nuovo Bar',
        'PLACES.GENERAL.COMPANY': COMPANY_ID,
        'PLACES.GENERAL.STREET': 'Via Nuova 1',
        'PLACES.GENERAL.POSTCODE': '20100',
        'PLACES.GENERAL.CITY': 'Milano',
        ...values,
      };
      for (const [label, value] of Object.entries(all)) {
        await view.type(label, value);
      }
    }

    it('shows an empty form without reading any place and no tabs', async () => {
      const { root, text, button, control } = await renderPlacePage({ path: 'new' });
      expect(root.querySelector('h1')?.textContent).toBe('PLACES.NEW_TITLE');
      expect(root.querySelector('nav')).toBeNull();
      expect(button(SAVE_ALL)).toBeUndefined();
      expect(button('PLACES.CREATE')?.disabled).toBe(false);
      expect(control(NAME).value).toBe('');
      expect(control('PLACES.GENERAL.COUNTRY').value).toBe('IT');
      expect(text()).not.toContain('PLACES.UNSAVED');
    });

    it('asks for the required fields before sending anything', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await view.click('PLACES.CREATE');
      await settle();
      await view.view();
      for (const label of [
        NAME,
        COMPANY_LABEL,
        'PLACES.GENERAL.STREET',
        'PLACES.GENERAL.POSTCODE',
        CITY,
      ]) {
        expect(view.error(label)).toBe('FORM.ISSUE.REQUIRED');
      }
      expect(document.activeElement).toBe(view.control(NAME));
      expect(view.control('PLACES.GENERAL.COUNTRY').value).toBe('IT');
    });

    it('creates a place for a platform administrator with the plan, and opens it', async () => {
      const view = await renderPlacePage({ path: 'new' });
      await fill(view, { 'PLACES.LICENSE.PLAN': 'enterprice' });
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
      await view.view();
      await settle();
      await view.view();
      expect(view.toasts()).toEqual(['PLACES.CREATED']);
      expect(view.router.url).toBe(`/groups/${GROUP}/places/${PLACE}`);
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
      // The series of the company are read again after every change: answer before choosing one.
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
        profile: { role: 'SA', groupId: GROUP },
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
      const view = await renderPlacePage({ path: 'new', profile: { role: 'D', groupId: null } });
      expect(view.control(PLAN).disabled).toBe(false);
      expect(optionsOf(view.control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
      ]);
      await fill(view, { 'PLACES.LICENSE.PLAN': 'tgm-secondary' });
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
      await view.view();
      expect(view.error(COMPANY_LABEL)).toBe('FORM.ISSUE.INVALID');
      expect(view.error('PLACES.GENERAL.POSTCODE')).toBe('FORM.ISSUE.FORMAT');
    });

    it('leaves a new place without asking until the user typed something', async () => {
      const { leave } = await renderPlacePage({ path: 'new' });
      expect(await leave()).toBe(true);
    });
  });

  describe('leaving the page', () => {
    it('leaves at once when nothing is unsaved, also from another tab', async () => {
      const { leave, goTo } = await renderPlacePage();
      await goTo('license');
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
      expect(router.url).toBe(`/groups/${GROUP}/places/${PLACE}`);
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
      await goTo('license');
      expect(router.url).toBe(`/groups/${GROUP}/places/${PLACE}/license`);
    });

    it('asks before leaving a new place that was started', async () => {
      const { type, dialogButton, view, router } = await renderPlacePage({ path: 'new' });
      await type(NAME, 'Nuovo');
      const navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('PLACES.LEAVE.CONFIRM').click();
      await view();
      expect(await navigation).toBe(true);
    });
  });
});
