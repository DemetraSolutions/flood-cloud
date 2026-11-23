import { TestBed } from '@angular/core/testing';
import { SessionService } from '../../core/session/session.service';
import { backend, settle } from '../../../testing/api';
import {
  BASE,
  BRAND,
  CAT,
  EDIT,
  GROUP,
  ID,
  ITEM,
  L,
  LANGS,
  LIST1,
  LIST3,
  NEW,
  NO_FEATURES,
  P1,
  P2,
  PRODUCT,
  READ_ONLY,
  TAX1,
  USER,
  descriptionLabel,
  fail,
  nameLabel,
  renderProduct,
  shortNameLabel,
} from '../../../testing/product-page';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

const optionsOf = (view: Awaited<ReturnType<typeof renderProduct>>, label: string) =>
  [...(view.control(label) as HTMLSelectElement).options].map((o) => o.value);

describe('ProductPage: a new product', () => {
  it.each([
    ['products', 'PRODUCTS', 'product', ['product', 'exempt']],
    ['product-modifiers', 'MODIFIERS', 'product', ['product', 'exempt']],
    ['tobacco-products', 'TOBACCOS', 'tobaccos', ['tobaccos', 'games', 'monopoly']],
  ])('opens the section %s with its title, its default type and the types the group offers', async (segment, text, type, types) => {
    const view = await renderProduct(`/groups/${GROUP}/${segment}/new`);
    expect(view.heading()).toBe(`PRODUCTS.FAMILY.${text}.NEW_TITLE`);
    expect(view.model().core.type).toBe(type);
    expect(optionsOf(view, L.type).filter((value) => value !== '')).toEqual(types);
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/${segment}`);
  });

  it('offers only the types of the family the group has the feature for', async () => {
    const view = await renderProduct(`/groups/${GROUP}/tobacco-products/new`, { features: { tobaccosGamesMonopoly: false } });
    expect(view.labels()).not.toContain(L.type);
    expect(view.model().core.type).toBe('tobaccos');
  });

  it('opens the services without a choice of type, and without the tabs a service does not have', async () => {
    const view = await renderProduct(`/groups/${GROUP}/services/new`);
    expect(view.heading()).toBe('PRODUCTS.FAMILY.SERVICES.NEW_TITLE');
    expect(view.labels()).not.toContain(L.type);
    expect(view.model().core.type).toBe('service');
    expect(view.tabs()).toEqual(['general', 'prices', 'categories', 'availability', 'variants', 'attributes', 'composition', 'media', 'margin']);
    expect(view.control(L.maxConcurrent)).toBeTruthy();
  });

  it.each(['odd', 'plain'])('opens the page of a family it does not know, or of none (%s), as the one of the products', async (segment) => {
    const view = await renderProduct(`/groups/${GROUP}/${segment}/new`);
    expect(view.heading()).toBe('PRODUCTS.FAMILY.PRODUCTS.NEW_TITLE');
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/products`);
  });

  it('shows the loading state until the languages and the defaults are read', async () => {
    const view = await renderProduct(NEW, { reads: null });
    await settle();
    expect(view.el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    backend().expectOne(LANGS).flush({ data: [{ code: 'it' }] });
    await view.view();
    expect(view.el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    await view.answer();
    expect(view.heading()).toBe('PRODUCTS.FAMILY.PRODUCTS.NEW_TITLE');
    expect(view.el().querySelector('[role=status]')?.textContent ?? '').not.toContain('COMMON.LOADING');
  });

  it('starts with a price rule for each enabled price list with the first tax rate, and the empty form', async () => {
    const view = await renderProduct(NEW);
    expect(view.save()!.disabled).toBe(true);
    expect(view.save()!.textContent).toContain('PRODUCTS.FORM.CREATE');
    expect(view.el().querySelector('.meta')).toBeNull();
    expect(view.model().core.prices.map((row) => [row.priceListId, row.taxId, row.currency, row.net, row.gross])).toEqual([
      [LIST1, TAX1, 'EUR', '0', '0.00'],
      [LIST3, TAX1, 'EUR', '0', '0.00'],
    ]);
    expect([...view.el().querySelectorAll('#product-panel-prices legend')].map((legend) => legend.textContent).filter((text) => text?.startsWith('PRODUCTS.PRICES.RULE'))).toEqual([
      'PRODUCTS.PRICES.RULE {"number":1}',
      'PRODUCTS.PRICES.RULE {"number":2}',
    ]);
    expect(view.model().core.enabled).toBe(true);
    expect(view.model().local.places).toEqual([]);
    expect(view.visible()).toEqual(['general']);
  });

  it('starts without price rules when the group has no tax rate', async () => {
    const view = await renderProduct(NEW, { reads: { taxes: [] } });
    expect(view.model().core.prices).toEqual([]);
  });

  it('starts without price rules when the price lists cannot be read', async () => {
    const view = await renderProduct(NEW, { reads: { lists: 'fail' } });
    expect(view.model().core.prices).toEqual([]);
    expect(view.heading()).toBeTruthy();
  });

  it('offers the euro and no unit of the group when their reads fail', async () => {
    const view = await renderProduct(NEW, { reads: { currencies: 'fail', units: 'fail' } });
    expect(view.model().core.prices[0].currency).toBe('EUR');
    expect(optionsOf(view, 'PRODUCTS.FIELD.LOAD_UNIT')).toEqual(['']);
  });

  it('keeps the units a product has even when the group does not list them', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { loadUnit: 'lt', unloadUnit: 'ml' } } });
    expect(optionsOf(view, 'PRODUCTS.FIELD.LOAD_UNIT')).toEqual(['', 'kg', 'pz', 'lt', 'ml']);
  });

  it('offers the units of the group', async () => {
    const view = await renderProduct(NEW);
    expect(optionsOf(view, 'PRODUCTS.FIELD.LOAD_UNIT')).toEqual(['', 'kg', 'pz']);
    expect(optionsOf(view, 'PRODUCTS.FIELD.UNLOAD_UNIT')).toEqual(['', 'kg', 'pz']);
  });

  it('starts a company administrator with every store of their perimeter and says so', async () => {
    const view = await renderProduct(NEW, { profile: { role: 'CA' } });
    expect(view.model().local.places.map((row) => row.placeId)).toEqual([P1, P2]);
    expect((view.control('Negozio uno') as HTMLInputElement).checked).toBe(true);
    expect((view.control('Negozio due') as HTMLInputElement).checked).toBe(true);
    expect(view.el().querySelector('#product-panel-availability [role=note]')?.textContent).toContain('PRODUCTS.AVAILABILITY.RESTRICTED');
  });

  it('waits for the stores of a company administrator before it shows the form', async () => {
    const view = await renderProduct(NEW, { profile: { role: 'PA' } });
    expect(view.model().local.places).toHaveLength(2);
  });

  it.each(['PSA', 'D', 'SA'])('starts %s with no store (the product is for every store) and explains it', async (role) => {
    const view = await renderProduct(NEW, { profile: { role: role as 'SA' } });
    expect(view.model().local.places).toEqual([]);
    const note = view.el().querySelector('#product-panel-availability .note')!;
    expect(note.textContent).toContain('PRODUCTS.AVAILABILITY.HINT_NEW');
    expect(note.getAttribute('role')).toBeNull();
  });

  it('says the stores cannot be read', async () => {
    const view = await renderProduct(NEW, { placesFail: true });
    expect(view.el().querySelectorAll('#product-panel-availability [role=alert]')).toHaveLength(1);
    await view.openTab('stations');
    expect(view.el().querySelectorAll('#product-panel-stations [role=alert]')).toHaveLength(1);
  });

  it('says the categories cannot be read', async () => {
    const view = await renderProduct(NEW, { reads: { tree: 'fail' } });
    expect(view.el().querySelector('#product-panel-categories [role=alert]')?.textContent).toContain('PRODUCT_CATEGORIES.FIELD.PARENT_FAILED');
  });

  it('creates it with an Idempotency-Key, only what the group has, and opens the page of the product', async () => {
    const view = await renderProduct(`/groups/${GROUP}/services/new`);
    await view.type(nameLabel('it'), '  Taglio  ');
    await view.type(nameLabel('en'), 'Cut');
    await view.type(L.code, ' S1 ');
    await view.type(L.maxConcurrent, '2');
    await view.type(L.position, '4');
    expect(view.save()!.disabled).toBe(false);
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.headers.has('If-Match')).toBe(false);
    expect(req.request.body).toEqual(
      expect.objectContaining({
        type: 'service',
        name: { it: 'Taglio', en: 'Cut' },
        code: 'S1',
        position: 4,
        maxConcurrent: 2,
        duration: null,
        enabled: true,
        availability: { pos: true, warehouse: false, scales: false, ecommerce: false },
        categoryIds: [],
        prices: [expect.objectContaining({ priceListId: LIST1, taxId: TAX1, net: 0 }), expect.objectContaining({ priceListId: LIST3 })],
      }),
    );
    expect(req.request.body).not.toHaveProperty('places');
    expect(req.request.body).not.toHaveProperty('isModifier');
    req.flush({ data: { ...PRODUCT, family: 'services', type: 'service' } }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view.view();
    expect(view.toasts()).toEqual(['success: PRODUCTS.FORM.CREATED']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'products');
    expect(view.router.url).toBe(`/groups/${GROUP}/services/${ID}`);
    await view.answer({ edit: true, item: { family: 'services', type: 'service' } });
    expect(view.heading()).toBe('PRODUCTS.FAMILY.SERVICES.EDIT_TITLE');
  });

  it('creates a modifier with the flag of a modifier and its settings, and a restricted user with their stores', async () => {
    const view = await renderProduct(`/groups/${GROUP}/product-modifiers/new`, { profile: { role: 'CA' } });
    await view.type(nameLabel('it'), 'Senza zucchero');
    await view.type(L.plus, '5');
    await view.type(L.minus, '3');
    await view.type('PRODUCTS.FIELD.MODIFIER_DESCRIPTION_IN {"language":"italiano"}', 'No zucchero');
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual(
      expect.objectContaining({
        isModifier: true,
        modifier: { type: 'addRemove', pricePercentagePlus: 5, pricePercentageMinus: 3, description: { it: 'No zucchero' } },
        places: [
          { placeId: P1, favorite: false, favoriteHandheld: false, position: null, productionCenterId: null },
          { placeId: P2, favorite: false, favoriteHandheld: false, position: null, productionCenterId: null },
        ],
      }),
    );
    expect(req.request.body).not.toHaveProperty('menu');
    expect(req.request.body).not.toHaveProperty('modifierIds');
    req.flush(...fail('INTERNAL_ERROR'));
    await view.view();
  });

  it('retries with the same key while the body is the same and with another when it changed', async () => {
    const view = await renderProduct(NEW);
    await view.type(nameLabel('it'), 'A');
    await view.submit();
    const first = backend().expectOne(BASE);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(...fail('INTERNAL_ERROR'));
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.INTERNAL_ERROR');
    await view.submit();
    const second = backend().expectOne(BASE);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush(...fail('INTERNAL_ERROR'));
    await view.view();
    await view.type(nameLabel('it'), 'B');
    await view.submit();
    const third = backend().expectOne(BASE);
    expect(third.request.headers.get('Idempotency-Key')).not.toBe(key);
    third.flush(...fail('INTERNAL_ERROR'));
    await view.view();
  });

  it('sends only the fields of the features the group has', async () => {
    const view = await renderProduct(NEW, { features: NO_FEATURES });
    await view.type(nameLabel('it'), 'A');
    await view.submit();
    const req = backend().expectOne(BASE);
    const body = req.request.body as Record<string, unknown>;
    for (const key of ['availability', 'favoriteHandheld', 'dining', 'featured', 'colors', 'plu', 'duration', 'loadUnit', 'modifierIds', 'gallery', 'printStations', 'stock']) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(body['name']).toEqual({ it: 'A' });
    req.flush(...fail('INTERNAL_ERROR'));
    await view.view();
  });
});

describe('ProductPage: a product that exists', () => {
  it('shows the product with the date of its last change and a save disabled while the form is clean', async () => {
    const view = await renderProduct(EDIT);
    expect(view.heading()).toBe('PRODUCTS.FAMILY.PRODUCTS.EDIT_TITLE');
    expect(view.el().querySelector('.meta')?.textContent).toContain('PRODUCT_CATALOG.FORM.UPDATED');
    expect(view.save()!.disabled).toBe(true);
    expect(view.save()!.textContent).toContain('COMMON.SAVE');
    expect((view.control(L.code) as HTMLInputElement).value).toBe('C1');
    expect((view.control(nameLabel('en')) as HTMLInputElement).value).toBe('Coffee');
    expect((view.control(L.position) as HTMLInputElement).value).toBe('3');
    expect(view.el().querySelector('[role=note]')).toBeNull();
  });

  it('shows the dates of the product that has none', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { updatedAt: null } } });
    expect(view.el().querySelector('.meta')?.textContent).toContain('PRODUCT_CATALOG.FORM.UPDATED {"date":""}');
  });

  it('shows the languages of the group and the ones the product has', async () => {
    const view = await renderProduct(EDIT, {
      reads: { languages: ['it'], item: { name: { it: 'A', fr: 'B' }, shortName: { de: 'x' }, description: { es: 'y' }, shortDescription: { pt: 'z' } } },
    });
    for (const language of ['it', 'fr']) {
      expect(view.control(nameLabel(language))).toBeTruthy();
    }
    expect(view.control(shortNameLabel('de'))).toBeTruthy();
    expect(view.control(descriptionLabel('es'))).toBeTruthy();
    expect(view.labels()).not.toContain(nameLabel('en'));
  });

  it('keeps the language of the group the user does not speak, and asks the name in the first of them', async () => {
    const view = await renderProduct(EDIT, { reads: { languages: ['de', 'fr'], item: { name: { de: 'Kaffee' } } } });
    expect(view.control(nameLabel('de'))).toBeTruthy();
    expect(view.el().textContent).toContain('PRODUCT_CATALOG.FIELD.REQUIRED_LANGUAGE');
  });

  it('falls back to Italian when the languages of the group cannot be read', async () => {
    const view = await renderProduct(EDIT, { reads: { languages: 'fail', item: { name: { it: 'A' } } } });
    expect(view.control(nameLabel('it'))).toBeTruthy();
    expect(view.labels()).not.toContain(nameLabel('en'));
  });

  it('falls back to Italian when the group has no language', async () => {
    const view = await renderProduct(NEW, { reads: { languages: [] } });
    expect(view.control(nameLabel('it'))).toBeTruthy();
  });

  it('sends only the fields that changed, with the version read in If-Match, and goes on with the new version', async () => {
    const view = await renderProduct(EDIT);
    await view.type(L.code, ' C2 ');
    expect(view.save()!.disabled).toBe(false);
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.headers.has('Idempotency-Key')).toBe(false);
    expect(req.request.body).toEqual({ code: 'C2' });
    req.flush({ data: { ...PRODUCT, code: 'C2' } }, { headers: { ETag: '"v2"' } });
    await view.view();
    expect(view.toasts()).toEqual(['success: PRODUCTS.FORM.SAVED']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'products');
    expect(view.router.url).toBe(EDIT);
    expect(view.save()!.disabled).toBe(true);
    await view.type(nameLabel('en'), 'Espresso');
    await view.submit();
    const second = backend().expectOne(ITEM);
    expect(second.request.headers.get('If-Match')).toBe('"v2"');
    expect(second.request.body).toEqual({ name: { en: 'Espresso' } });
    second.flush(...fail('INTERNAL_ERROR'));
    await view.view();
  });

  it('shows the warnings of the values other products use too, and never blocks the save', async () => {
    const view = await renderProduct(EDIT, {
      reads: {
        item: {
          warnings: [
            { field: 'code', issue: 'duplicate', productIds: [PRODUCT.modifierIds![0]], others: 2 },
            { field: 'plu', issue: 'duplicate', productIds: [], others: 1 },
            { field: 'barcodes.0', issue: 'duplicate', productIds: ['665f1c2e9b1d4a0012ab3799'], others: 0 },
          ],
        },
      },
    });
    const notes = [...view.el().querySelectorAll('#product-panel-general [role=status]')].map((note) => note.textContent?.replace(/\s+/g, ' ').trim());
    expect(notes[0]).toContain('PRODUCTS.WARNING.DUPLICATE Coca PRODUCTS.WARNING.OTHERS {"count":2}');
    expect(notes[1]).toContain('PRODUCTS.WARNING.OTHERS {"count":1}');
    await view.openTab('barcodes');
    expect(view.el().querySelector('#product-panel-barcodes [role=status]')?.textContent).toContain('…ab3799');
    await view.type(L.code, 'C2');
    await view.submit();
    const req = backend().expectOne(ITEM);
    req.flush({ data: { ...PRODUCT, code: 'C2', warnings: [] } }, { headers: { ETag: '"v2"' } });
    await view.view();
    expect(view.el().querySelectorAll('#product-panel-general [role=status]')).toHaveLength(0);
  });
});

describe('ProductPage: the views', () => {
  const ALL_TABS = ['general', 'barcodes', 'prices', 'categories', 'availability', 'variants', 'stations', 'stock', 'attributes', 'composition', 'media', 'margin', 'suppliers', 'shipping'];

  it('opens the full view by default, with every tab', async () => {
    const view = await renderProduct(EDIT);
    expect(view.tabs()).toEqual(ALL_TABS);
    expect(view.viewButton('FULL').getAttribute('aria-pressed')).toBe('true');
    expect(view.viewButton('QUICK').getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the quick view from the query with the tabs of the legacy basic form and the prices, barcodes and image in the general tab', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`);
    expect(view.tabs()).toEqual(['general', 'categories', 'availability', 'variants', 'stations']);
    expect(view.viewButton('QUICK').getAttribute('aria-pressed')).toBe('true');
    const general = view.el().querySelector('#product-panel-general')!;
    expect(general.textContent).toContain('PRODUCTS.SECTION.BARCODES');
    expect(general.textContent).toContain('PRODUCTS.SECTION.PRICES');
    expect(general.textContent).toContain('PRODUCTS.SECTION.MEDIA');
    expect(general.querySelectorAll('fc-product-price-rules')).toHaveLength(1);
    expect(general.querySelectorAll('fc-product-barcodes')).toHaveLength(1);
    expect(general.querySelectorAll('fc-logo-slot')).toHaveLength(1);
    expect(view.el().querySelector('#product-panel-prices')).toBeNull();
  });

  it('leaves out of the quick view the scales and restaurant cards, and the period without the advanced products', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`, { features: { advancedProducts: false } });
    expect(view.labels()).not.toContain(L.plu);
    expect(view.labels()).not.toContain(L.fee);
    expect(view.labels()).not.toContain(L.from);
  });

  it('has the period in the quick view with the advanced products, but not the scales and restaurant cards', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`);
    expect(view.labels()).toContain(L.from);
    expect(view.labels()).not.toContain(L.plu);
    expect(view.labels()).not.toContain(L.fee);
  });

  it('has the scales, restaurant and period cards in the full view even without the advanced products', async () => {
    const view = await renderProduct(EDIT, { features: { advancedProducts: false } });
    expect(view.labels()).toContain(L.plu);
    expect(view.labels()).toContain(L.fee);
    expect(view.labels()).toContain(L.from);
  });

  it.each(['?view=quick', ''])('gives the barcodes no ratio while the conversion ratio is empty (%s)', async (query) => {
    const view = await renderProduct(`${EDIT}${query}`);
    await view.setCore({ conversionRatio: '' });
    expect(view.el().querySelector('fc-product-barcodes')).toBeTruthy();
    await view.setCore({ conversionRatio: '2' });
    expect(view.el().querySelector('fc-product-barcodes')).toBeTruthy();
  });

  it('leaves out of the quick view the barcodes of a service and the image without the media feature', async () => {
    const view = await renderProduct(`/groups/${GROUP}/services/new?view=quick`, { features: { media: false } });
    const general = view.el().querySelector('#product-panel-general')!;
    expect(general.textContent).not.toContain('PRODUCTS.SECTION.BARCODES');
    expect(general.textContent).not.toContain('PRODUCTS.SECTION.MEDIA');
    expect(general.textContent).toContain('PRODUCTS.SECTION.PRICES');
  });

  it.each([
    ['', 5],
    ['?view=full', 14],
    ['?view=quick', 5],
    ['?view=other', 5],
  ])('remembers the view of the user, which the query overrides (%s)', async (query, tabs) => {
    localStorage.setItem(`fc.productView.${USER}`, 'quick');
    const view = await renderProduct(`${EDIT}${query}`);
    expect(view.tabs()).toHaveLength(tabs);
  });

  it('ignores a preference that is not a view', async () => {
    localStorage.setItem(`fc.productView.${USER}`, 'something');
    const view = await renderProduct(EDIT);
    expect(view.tabs()).toHaveLength(14);
  });

  it('switches view and remembers the choice for the user, without losing what was typed', async () => {
    const view = await renderProduct(EDIT);
    await view.type(L.code, 'NEW');
    await view.switchView('QUICK');
    expect(localStorage.getItem(`fc.productView.${USER}`)).toBe('quick');
    expect(view.tabs()).toHaveLength(5);
    expect((view.control(L.code) as HTMLInputElement).value).toBe('NEW');
    await view.type(nameLabel('en'), 'Cafe');
    await view.switchView('FULL');
    expect(localStorage.getItem(`fc.productView.${USER}`)).toBe('full');
    expect(view.tabs()).toHaveLength(14);
    expect((view.control(nameLabel('en')) as HTMLInputElement).value).toBe('Cafe');
    await view.submit();
    expect(backend().expectOne(ITEM).request.body).toEqual({ code: 'NEW', name: { en: 'Cafe' } });
  });

  it('remembers the view of an anonymous session under its own key and goes on when the storage fails', async () => {
    const view = await renderProduct(EDIT);
    (TestBed.inject(SessionService) as unknown as { meState: { set(value: null): void } }).meState.set(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    await view.switchView('QUICK');
    expect(warn).toHaveBeenCalled();
    expect(view.tabs()).toEqual(['general', 'categories', 'availability']);
  });

  it('goes back to the general tab when the one shown disappears with the view', async () => {
    const view = await renderProduct(EDIT);
    await view.openTab('shipping');
    expect(view.visible()).toEqual(['shipping']);
    await view.switchView('QUICK');
    expect(view.visible()).toEqual(['general']);
    await view.switchView('FULL');
    expect(view.visible()).toEqual(['shipping']);
  });

  it('opens the tab the user chooses', async () => {
    const view = await renderProduct(EDIT);
    await view.openTab('availability');
    expect(view.visible()).toEqual(['availability']);
  });
});

describe('ProductPage: the tabs of a product', () => {
  it('has only the tabs of a modifier that suit it: no variants and no menu', async () => {
    const view = await renderProduct(`/groups/${GROUP}/product-modifiers/new`);
    expect(view.tabs()).not.toContain('variants');
    expect(view.tabs()).toContain('composition');
    const composition = view.el().querySelector('#product-panel-composition')!;
    expect(composition.textContent).toContain('PRODUCTS.COMPOSITION.COMPONENTS');
    expect(composition.textContent).not.toContain('PRODUCTS.COMPOSITION.MENU');
    expect(composition.textContent).not.toContain('PRODUCTS.COMPOSITION.MODULAR');
    expect(view.labels()).toContain(L.plus);
  });

  it('has the menu, the choices and the modular price of a product that is not a modifier', async () => {
    const view = await renderProduct(EDIT);
    const composition = view.el().querySelector('#product-panel-composition')!;
    expect(composition.textContent).toContain('PRODUCTS.COMPOSITION.MENU');
    expect(composition.textContent).toContain('PRODUCTS.COMPOSITION.CHOICES');
    expect(composition.textContent).toContain('PRODUCTS.COMPOSITION.MODULAR');
    expect(view.labels()).not.toContain(L.plus);
  });

  it('has no choices of modifiers without the variants of the group, and no scales note unless it has the scales', async () => {
    const view = await renderProduct(EDIT, { features: { productsVariants: false, scales: false } });
    expect(view.el().querySelector('#product-panel-composition')!.textContent).not.toContain('PRODUCTS.COMPOSITION.CHOICES');
    expect(view.tabs()).not.toContain('variants');
    expect(view.el().querySelector('#product-panel-prices .note')).toBeNull();
  });

  it('notes that the scales read the prices', async () => {
    const view = await renderProduct(EDIT);
    expect(view.el().querySelector('#product-panel-prices .note')?.textContent).toContain('PRODUCTS.PRICES.SCALES_NOTE');
  });

  it('has the stock, stations, variants and media only with the features of the group', async () => {
    const view = await renderProduct(EDIT, { features: { warehouse: false, ordering: false, productsVariants: false, media: false } });
    expect(view.tabs()).toEqual(['general', 'barcodes', 'prices', 'categories', 'availability', 'attributes', 'composition', 'margin', 'suppliers', 'shipping']);
  });

  it('has no tab of the stock, stations and shipping for a service that exists', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { family: 'services', type: 'service' } } });
    expect(view.tabs()).toEqual(['general', 'prices', 'categories', 'availability', 'variants', 'attributes', 'composition', 'media', 'margin']);
  });

  it('follows the type chosen: a product turned into a service loses its tabs', async () => {
    const view = await renderProduct(NEW, { features: { services: true } });
    await view.setCore({ type: 'service' });
    expect(view.tabs()).not.toContain('barcodes');
    await view.setCore({ type: 'product' });
    expect(view.tabs()).toContain('barcodes');
  });

  it('keeps the type a product has even when the group does not offer it any more', async () => {
    const view = await renderProduct(EDIT, { features: { tobaccosGamesMonopoly: false }, reads: { item: { type: 'games' } } });
    expect(optionsOf(view, L.type)).toEqual(['product', 'exempt', 'games']);
    expect(view.model().core.type).toBe('games');
  });

  it('shows the product of a family the group lost the feature of, with the type it has', async () => {
    const view = await renderProduct(EDIT, { features: { tobaccosGamesMonopoly: false }, reads: { item: { type: 'games', family: 'tgm' } } });
    expect(view.heading()).toBe('PRODUCTS.FAMILY.TOBACCOS.EDIT_TITLE');
    expect(view.model().core.type).toBe('games');
  });

  it('shows a product without a type as the one of its family', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { type: null } } });
    expect(optionsOf(view, L.type)).toEqual(['product', 'exempt']);
    expect(view.model().core.type).toBe('product');
  });

  it('shows a modifier that exists with its own settings', async () => {
    const view = await renderProduct(EDIT, {
      reads: { item: { family: 'modifiers', isModifier: true, modifier: { type: 'add', pricePercentagePlus: 10, pricePercentageMinus: null, description: { it: 'Extra', fr: 'Plus' } } } },
    });
    expect(view.heading()).toBe('PRODUCTS.FAMILY.MODIFIERS.EDIT_TITLE');
    expect((view.control(L.plus) as HTMLInputElement).value).toBe('10');
    expect(view.control('PRODUCTS.FIELD.MODIFIER_DESCRIPTION_IN {"language":"francese"}')).toBeTruthy();
    expect(view.tabs()).not.toContain('variants');
  });

  it('has no unused tab when the group has no feature at all', async () => {
    const view = await renderProduct(EDIT, { features: NO_FEATURES });
    expect(view.tabs()).toEqual(['general', 'barcodes', 'prices', 'categories', 'availability', 'attributes', 'composition', 'margin', 'suppliers', 'shipping']);
    expect(view.labels()).not.toContain('PRODUCT_CATEGORIES.COLORS.BACKGROUND');
  });

  it('reads the brands and the attributes of the group', async () => {
    const view = await renderProduct(EDIT);
    expect(optionsOf(view, 'PRODUCTS.FIELD.BRAND')).toEqual(['', BRAND]);
    await view.openTab('attributes');
    expect(view.el().querySelector('#product-panel-attributes legend')?.textContent).toContain('Origine');
    expect(view.el().querySelector('#product-panel-attributes [role=note]')).toBeNull();
  });

  it('warns when the attribute groups are more than the ones read', async () => {
    const view = await renderProduct(EDIT, { reads: { attributes: { data: [], page: { limit: 100, next: 'x' } } } });
    expect(view.el().querySelector('#product-panel-attributes [role=note]')?.textContent).toContain('PRODUCTS.ATTRIBUTES.TRUNCATED');
  });

  it('works without brands and attributes when their reads fail', async () => {
    const view = await renderProduct(EDIT, { reads: { brands: 'fail', attributes: 'fail' } });
    expect(optionsOf(view, 'PRODUCTS.FIELD.BRAND')).toEqual(['', BRAND]);
    expect(view.heading()).toBe('PRODUCTS.FAMILY.PRODUCTS.EDIT_TITLE');
  });

  it('puts the categories of the tree in the categories tab', async () => {
    const view = await renderProduct(EDIT);
    await view.openTab('categories');
    expect((view.control('Bevande') as HTMLInputElement).checked).toBe(true);
    expect((view.control('Caffè') as HTMLInputElement).checked).toBe(false);
    expect(CAT).toBeTruthy();
  });
});

describe('ProductPage: what the user may change', () => {
  const disabled = (view: Awaited<ReturnType<typeof renderProduct>>, label: string) => (view.control(label) as HTMLInputElement).disabled;

  it('changes the whole product when the server says it is theirs', async () => {
    const view = await renderProduct(EDIT);
    expect(disabled(view, L.code)).toBe(false);
    expect(disabled(view, 'Negozio uno')).toBe(false);
    expect(view.el().querySelector('[role=note]')).toBeNull();
    expect(view.button('PRODUCTS.RESTORE.ACTION')).toBeUndefined();
  });

  it('lets a company administrator change only their stores on a product shared with others, and says so', async () => {
    const view = await renderProduct(EDIT, { profile: { role: 'CA' }, reads: { item: { editable: false, placeEditable: true } } });
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain('PRODUCTS.READ_ONLY_PARTIAL');
    expect(disabled(view, L.code)).toBe(true);
    expect(disabled(view, nameLabel('it'))).toBe(true);
    expect(disabled(view, 'Negozio uno')).toBe(false);
    expect(view.save()).toBeTruthy();
    await view.type(L.code, 'IGNORED');
    expect(view.save()!.disabled).toBe(true);
  });

  it('sends only the stores, the stations and the stock of a product that is shared', async () => {
    const view = await renderProduct(EDIT, { profile: { role: 'CA' }, reads: { item: { editable: false, placeEditable: true } } });
    await view.setCore({ code: 'CHANGED' });
    await view.setLocal({
      places: [
        { placeId: P1, favorite: true, favoriteHandheld: false, position: '2', productionCenterId: '' },
        { placeId: P2, favorite: false, favoriteHandheld: false, position: '', productionCenterId: '' },
      ],
      stations: { rooms: { [P1]: ['st1'] }, counter: {} },
      stock: [{ placeId: P1, storageId: 'sg1', min: '2', max: '10', location: 'A1' }],
    });
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('PATCH');
    expect(Object.keys(req.request.body as object).sort()).toEqual(['places', 'printStations', 'stock']);
    expect((req.request.body as { stock: unknown }).stock).toEqual({ [P1]: { sg1: { min: 2, max: 10, location: 'A1' } } });
    req.flush({ data: { ...PRODUCT, editable: false, placeEditable: true, code: 'C1' } }, { headers: { ETag: '"v2"' } });
    await view.view();
    expect(view.toasts()).toEqual(['success: PRODUCTS.FORM.SAVED']);
  });

  it('locks the availability of a product for every store to whoever manages only their stores', async () => {
    const view = await renderProduct(EDIT, { profile: { role: 'CA' }, reads: { item: { editable: false, placeEditable: true, places: [] } } });
    expect(view.el().querySelector('#product-panel-availability [role=note]')?.textContent).toContain('PRODUCTS.AVAILABILITY.LOCKED');
    expect(disabled(view, 'Negozio uno')).toBe(true);
    expect(view.form().local.places().valid()).toBe(true);
  });

  it('does not lock the availability of a product for every store to whoever may change it as a whole', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { places: [] } } });
    expect(disabled(view, 'Negozio uno')).toBe(false);
    expect(view.el().querySelector('#product-panel-availability [role=note]')).toBeNull();
  });

  it('is read only when the product is not theirs at all, and says so', async () => {
    const view = await renderProduct(EDIT, { profile: { role: 'CA' }, reads: { item: { editable: false, placeEditable: false } } });
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain('PRODUCTS.READ_ONLY_SHARED');
    expect(view.save()).toBeNull();
    expect(disabled(view, L.code)).toBe(true);
    expect(disabled(view, 'Negozio uno')).toBe(true);
    expect(view.button('PRODUCTS.RESTORE.ACTION')).toBeUndefined();
  });

  it('is read only without the permission to change products, with no note and no save', async () => {
    const view = await renderProduct(EDIT, { profile: { permissions: READ_ONLY } });
    expect(view.save()).toBeNull();
    expect(view.el().querySelector('.note[role=note]')).toBeNull();
    expect(disabled(view, L.code)).toBe(true);
    expect(view.viewButton('QUICK')).toBeTruthy();
  });

  it('shows a product in the trash read only, with restore and delete for good', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { trashed: true, trashedAt: '2026-11-12T10:00:00.000Z' } } });
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain('PRODUCTS.TRASHED_NOTE');
    expect(view.save()).toBeNull();
    expect(disabled(view, L.code)).toBe(true);
    expect(view.button('PRODUCTS.RESTORE.ACTION')).toBeTruthy();
    expect(view.button('PRODUCTS.DELETE.ACTION')).toBeTruthy();
  });

  it('offers neither restore nor delete for good for a product in the trash that is not theirs', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { trashed: true, editable: false, placeEditable: true } } });
    expect(view.button('PRODUCTS.RESTORE.ACTION')).toBeUndefined();
    expect(view.button('PRODUCTS.DELETE.ACTION')).toBeUndefined();
    expect(view.save()).toBeNull();
  });

  it('offers neither restore nor delete for good for a product in the trash without the permission to change products', async () => {
    const view = await renderProduct(EDIT, { profile: { permissions: READ_ONLY }, reads: { item: { trashed: true } } });
    expect(view.button('PRODUCTS.RESTORE.ACTION')).toBeUndefined();
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain('PRODUCTS.TRASHED_NOTE');
  });
});
