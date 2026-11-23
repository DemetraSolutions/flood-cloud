import { TestBed } from '@angular/core/testing';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import {
  ALL_FEATURES,
  BASE,
  CATEGORY,
  CHILD,
  EDIT,
  FOOD,
  GROUP,
  ID,
  L,
  NEW,
  OTHER,
  OUTSIDE,
  P1,
  P2,
  PROD1,
  READ_ONLY,
  ROOT,
  descriptionLabel,
  fail,
  nameLabel,
  positionLabel,
  renderCategory,
} from '../../../testing/category-page';
import { backend, errorBody, settle } from '../../../testing/api';
import { QUICK_COLORS } from './category.types';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CategoryPage: a new category', () => {
  it('shows the empty form, the required language and a save disabled while the form is clean', async () => {
    const { el, save, control, visible, tab } = await renderCategory(NEW);
    expect(el().querySelector('h1')?.textContent).toContain('PRODUCT_CATEGORIES.FORM.NEW_TITLE');
    expect(el().querySelector('.meta')).toBeNull();
    expect(save()!.disabled).toBe(true);
    expect(save()!.textContent).toContain('PRODUCT_CATEGORIES.FORM.CREATE');
    expect(el().querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/product-categories`);
    expect((control(L.enabled) as HTMLInputElement).checked).toBe(true);
    expect(el().textContent).toContain('PRODUCT_CATALOG.FIELD.REQUIRED_LANGUAGE');
    expect(control(nameLabel('en'))).toBeTruthy();
    expect(visible()).toEqual(['category-panel-general']);
    expect(['general', 'variants', 'stations', 'availability', 'media'].map((id) => !!tab(id))).toEqual([true, true, true, true, true]);
    expect(el().textContent).not.toContain('PRODUCT_CATEGORIES.CYCLIC_NOTE');
  });

  it('shows the loading state until the languages arrive', async () => {
    const { el, answer } = await renderCategory(NEW, { reads: null });
    await settle();
    expect(el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    await answer();
    expect(el().querySelector('h1')).toBeTruthy();
  });

  it('opens the tab the user chooses', async () => {
    const { openTab, visible } = await renderCategory(NEW);
    await openTab('availability');
    expect(visible()).toEqual(['category-panel-availability']);
  });

  it('has every field and tab when the group has every feature', async () => {
    const { el, control } = await renderCategory(NEW);
    for (const label of [L.pos, L.ecommerce, L.featured, L.printer, L.fee, L.printGroup, L.diningType, L.tobacco, L.background, L.fileName, L.url]) {
      expect(control(label), label).toBeTruthy();
    }
    expect(el().querySelectorAll('.swatch')).toHaveLength(12);
    expect(el().querySelector('#category-panel-variants')).toBeTruthy();
    expect(el().querySelector('#category-panel-stations')).toBeTruthy();
    expect(el().querySelector('#category-panel-media')).toBeTruthy();
  });

  it('has only the general and availability tabs, and no field of a feature, when the group has none', async () => {
    const { el, tab } = await renderCategory(NEW, {
      features: Object.fromEntries(Object.keys(ALL_FEATURES).map((name) => [name, false])),
    });
    expect([...el().querySelectorAll('[role=tab]')].map((t) => t.id)).toEqual(['category-tab-general', 'category-tab-availability']);
    expect(tab('general')).toBeTruthy();
    const labels = [...el().querySelectorAll('label')].map((l) => l.textContent?.trim());
    for (const label of [L.pos, L.ecommerce, L.featured, L.printer, L.fee, L.tobacco, L.background]) {
      expect(labels).not.toContain(label);
    }
    expect(el().querySelector('.swatch')).toBeNull();
    expect(el().querySelector('#category-panel-variants')).toBeNull();
    expect(el().querySelector('#category-panel-stations')).toBeNull();
    expect(el().querySelector('#category-panel-media')).toBeNull();
  });

  it('creates it with an Idempotency-Key, only the fields of the features, and goes to its page', async () => {
    const { type, check, submit, toasts, router, view, save, answer, referenceStore, openTab, control, slots } = await renderCategory(NEW);
    await type(nameLabel('it'), '  Caffè  ');
    await type(nameLabel('en'), 'Coffee');
    await type(descriptionLabel('it'), 'Calde');
    await type(L.parent, ROOT);
    await type(L.position, ' 3 ');
    await type(L.production, '10');
    await check(L.enabled, false);
    await check(L.pos, true);
    await check(L.featured, true);
    await check(L.printer, true);
    await check(L.tobacco, true);
    await type(L.fee, '5');
    await type(L.printGroup, '2');
    await type(L.diningType, 'beverage');
    await type(L.background, '#ff0000');
    await openTab('media');
    await type(L.fileName, ' cafe.png ');
    await type(L.url, 'https://example.com/cafe');
    slots()[0].logoChange.emit({ descriptor: null, imageId: '665f1c2e9b1d4a0012ab3601', label: 'foto.png', previewUrl: null });
    await view();
    expect(save()!.disabled).toBe(false);
    expect((control(L.parent) as HTMLSelectElement).value).toBe(ROOT);
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.body).toEqual({
      name: { it: 'Caffè', en: 'Coffee' },
      description: { it: 'Calde' },
      enabled: false,
      noDiscount: false,
      requiresLegalAge: false,
      integrations: { floodOrders: false, yellgo: false, leggimenu: false },
      textColor: '#000000',
      parentId: ROOT,
      position: 3,
      productionValue: 10,
      availability: { pos: true, ecommerce: false },
      featured: true,
      secondaryFiscalPrinter: true,
      tobacco: true,
      dining: {
        endOfMeal: false,
        hiddenOnHandheld: false,
        feePercentage: 5,
        printGroup: 2,
        alwaysFirstCourse: false,
        notAffiliatedMenu: false,
        type: 'beverage',
      },
      backgroundColor: '#ff0000',
      modifierIds: [],
      modifierCategoryIds: [],
      printStations: {},
      counterPrintStations: {},
      image: { imageId: '665f1c2e9b1d4a0012ab3601' },
      internalFileName: 'cafe.png',
      externalUrl: 'https://example.com/cafe',
    });
    req.flush({ data: CATEGORY }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view();
    expect(toasts()).toEqual(['success: PRODUCT_CATEGORIES.FORM.CREATED']);
    expect(referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'product-categories');
    expect(router.url).toBe(EDIT);
    await answer({ edit: true });
  });

  it('sends only what the group has when it has no feature', async () => {
    const { type, submit, view } = await renderCategory(NEW, {
      features: Object.fromEntries(Object.keys(ALL_FEATURES).map((name) => [name, false])),
    });
    await type(nameLabel('it'), 'Caffè');
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual({
      name: { it: 'Caffè' },
      enabled: true,
      noDiscount: false,
      requiresLegalAge: false,
      integrations: { floodOrders: false, yellgo: false, leggimenu: false },
      textColor: '#000000',
    });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('retries with the same key while the body is the same and with another when it changed', async () => {
    const { type, submit, view, formError } = await renderCategory(NEW);
    await type(nameLabel('it'), 'A');
    await submit();
    const first = backend().expectOne(BASE);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(...fail('INTERNAL_ERROR'));
    await view();
    expect(formError()).toContain('ERRORS.API.INTERNAL_ERROR');
    await submit();
    const second = backend().expectOne(BASE);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush(...fail('INTERNAL_ERROR'));
    await view();
    await type(nameLabel('it'), 'B');
    await submit();
    const third = backend().expectOne(BASE);
    expect(third.request.headers.get('Idempotency-Key')).not.toBe(key);
    third.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('asks for the name in the language required, says so on the tab and opens it', async () => {
    const { el, submit, error, tab, type, visible, openTab } = await renderCategory(NEW);
    await openTab('media');
    await type(nameLabel('en'), 'Only english');
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('en'))).toBe('');
    expect(tab('general').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(tab('availability').textContent).not.toContain('TAB_LIST.ERRORS');
    expect(visible()).toEqual(['category-panel-general']);
    expect(document.activeElement).toBe(el().querySelector('#' + (document.activeElement as HTMLElement).id));
    expect((document.activeElement as HTMLElement).tagName).toBe('INPUT');
  });

  it('checks the numbers of the general tab', async () => {
    const { submit, error, type, blur } = await renderCategory(NEW);
    await type(nameLabel('it'), 'A');
    await type(L.position, 'abc');
    expect(error(L.position)).toBe('');
    await blur(L.position);
    expect(error(L.position)).toBe('FORM.ISSUE.TYPE');
    await type(L.position, '-1');
    expect(error(L.position)).toBe('FORM.ISSUE.MINIMUM');
    await type(L.position, '1000001');
    expect(error(L.position)).toBe('FORM.ISSUE.MAXIMUM');
    await type(L.position, '1.5');
    expect(error(L.position)).toBe('FORM.ISSUE.TYPE');
    await type(L.position, '1000000');
    expect(error(L.position)).toBe('');
    await type(L.fee, '5.5');
    expect(error(L.fee)).toBe('');
    await type(L.printGroup, '1.5');
    await blur(L.printGroup);
    expect(error(L.printGroup)).toBe('FORM.ISSUE.TYPE');
    await type(L.production, '2000000');
    await type(L.fee, '101');
    await type(L.printGroup, 'abc');
    await submit();
    expect(error(L.production)).toBe('FORM.ISSUE.MAXIMUM');
    expect(error(L.fee)).toBe('FORM.ISSUE.MAXIMUM');
    expect(error(L.printGroup)).toBe('FORM.ISSUE.TYPE');
    await type(L.fee, '99');
    expect(error(L.fee)).toBe('');
  });

  it('shows the error of a field once the user leaves it', async () => {
    const { error, type, blur, el, view } = await renderCategory(NEW);
    const bad: [string, string, string][] = [
      [L.position, 'abc', 'FORM.ISSUE.TYPE'],
      [L.production, '-5', 'FORM.ISSUE.MINIMUM'],
      [L.fee, '101', 'FORM.ISSUE.MAXIMUM'],
      [L.printGroup, 'abc', 'FORM.ISSUE.TYPE'],
      [L.fileName, 'x'.repeat(256), 'FORM.ISSUE.MAX_LENGTH'],
      [L.url, 'http://example.com', 'FORM.ISSUE.FORMAT'],
      [nameLabel('it'), 'x'.repeat(151), 'FORM.ISSUE.MAX_LENGTH'],
      [descriptionLabel('it'), 'y'.repeat(1001), 'FORM.ISSUE.MAX_LENGTH'],
    ];
    for (const [label, value, issue] of bad) {
      await type(label, value);
      expect(error(label), label).toBe('');
      await blur(label);
      expect(error(label), label).toBe(issue);
    }
    await blur(L.parent);
    expect(error(L.parent)).toBe('');
    el().querySelector('#category-panel-variants input[type=checkbox]')!.dispatchEvent(new Event('blur'));
    await view();
  });

  it('checks the link: https only, no user or password, not longer than the server accepts', async () => {
    const { submit, error, type, tab, visible } = await renderCategory(NEW);
    await type(nameLabel('it'), 'A');
    await type(L.url, 'http://example.com');
    await submit();
    expect(error(L.url)).toBe('FORM.ISSUE.FORMAT');
    expect(tab('media').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(visible()).toEqual(['category-panel-media']);
    await type(L.url, 'https://user:secret@example.com');
    expect(error(L.url)).toBe('FORM.ISSUE.FORMAT');
    await type(L.url, 'https://user@example.com');
    expect(error(L.url)).toBe('FORM.ISSUE.FORMAT');
    await type(L.url, 'not a link');
    expect(error(L.url)).toBe('FORM.ISSUE.FORMAT');
    await type(L.url, `https://example.com/${'a'.repeat(2048)}`);
    expect(error(L.url)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(L.url, '   ');
    expect(error(L.url)).toBe('');
    await type(L.url, 'https://example.com/ok');
    expect(error(L.url)).toBe('');
  });

  it('checks the internal file name: one line, not longer than the server accepts', async () => {
    const { submit, error, type } = await renderCategory(NEW);
    await type(nameLabel('it'), 'A');
    await type(L.fileName, 'x'.repeat(256));
    await submit();
    expect(error(L.fileName)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(L.fileName, 'a\u0001b');
    expect(error(L.fileName)).toBe('FORM.ISSUE.PATTERN');
    await type(L.fileName, 'x'.repeat(255));
    expect(error(L.fileName)).toBe('');
  });

  it('checks the length and the characters of the texts', async () => {
    const { submit, error, type } = await renderCategory(NEW);
    await type(nameLabel('it'), 'x'.repeat(151));
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(nameLabel('it'), 'a\u0001b');
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.PATTERN');
    await type(nameLabel('it'), 'Nome');
    await type(descriptionLabel('it'), 'y'.repeat(1001));
    expect(error(descriptionLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
  });

  it('asks the stores of a company administrator, and only from there, and cannot upload an image', async () => {
    const { el, type, submit, error, visible, view, tab, slots } = await renderCategory(NEW, { profile: { role: 'CA' } });
    expect(el().querySelector('#category-panel-availability [role=note]')?.textContent).toContain('PRODUCT_CATEGORIES.AVAILABILITY.RESTRICTED');
    expect(slots().map((s) => s.canUpload())).toEqual([false, false]);
    await type(nameLabel('it'), 'A');
    await submit();
    expect(visible()).toEqual(['category-panel-availability']);
    expect(tab('availability').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(error('Negozio uno')).toBe('');
    (el().querySelector('#category-panel-availability input[type=checkbox]') as HTMLInputElement).click();
    await view();
    expect(el().querySelector('#category-panel-availability .problem')).toBeNull();
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toMatchObject({ places: [{ placeId: P1, position: null, productionCenterId: null }] });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('treats the store administrator as restricted and the group administrator as not', async () => {
    const pa = await renderCategory(NEW, { profile: { role: 'PA' } });
    expect(pa.el().querySelector('#category-panel-availability [role=note]')).toBeTruthy();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const sa = await renderCategory(NEW);
    expect(sa.el().querySelector('#category-panel-availability .note')?.textContent).toContain('PRODUCT_CATEGORIES.AVAILABILITY.HINT');
    expect(sa.el().querySelector('#category-panel-availability [role=note]')).toBeNull();
    expect(sa.slots().map((s) => s.canUpload())).toEqual([true, true]);
  });

  it('shows the quick colors and each one sets the background', async () => {
    const { el, view, control, submit, save, type } = await renderCategory(NEW);
    const swatches = [...el().querySelectorAll<HTMLButtonElement>('.swatch')];
    expect(swatches).toHaveLength(QUICK_COLORS.length);
    swatches.forEach((swatch, index) => expect(swatch.getAttribute('aria-label')).toContain(QUICK_COLORS[index]));
    swatches[3].click();
    await view();
    expect((control(L.background) as HTMLInputElement).value).toBe(QUICK_COLORS[3]);
    await type(nameLabel('it'), 'A');
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toMatchObject({ backgroundColor: QUICK_COLORS[3] });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('chooses the stations of a store', async () => {
    const { el, openStore, type, submit, view, placesApi } = await renderCategory(NEW);
    await type(nameLabel('it'), 'A');
    const stations = el().querySelector('#category-panel-stations')!;
    expect(stations.textContent).toContain('Negozio uno');
    await openStore('Negozio uno');
    expect(placesApi.read).toHaveBeenCalledWith(GROUP, P1);
    const labels = [...stations.querySelectorAll('fc-checkbox label')].map((l) => l.textContent?.trim());
    expect(labels).toEqual(['Bar', 'Sala', 'Bar', 'Sala']);
    (stations.querySelectorAll('input[type=checkbox]')[1] as HTMLInputElement).click();
    (stations.querySelectorAll('input[type=checkbox]')[2] as HTMLInputElement).click();
    await view();
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toMatchObject({
      printStations: { [P1]: ['st2'] },
      counterPrintStations: { [P1]: ['st1'] },
    });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('chooses the stores of the availability with position and production center', async () => {
    const { el, openTab, view, type, submit, control } = await renderCategory(NEW);
    await openTab('availability');
    await type(nameLabel('it'), 'A');
    (el().querySelector('#category-panel-availability input[type=checkbox]') as HTMLInputElement).click();
    await view();
    await view();
    await type(positionLabel('Negozio uno'), '4');
    await type('PRODUCT_CATEGORIES.AVAILABILITY.CENTER ' + JSON.stringify({ place: 'Negozio uno' }), 'pc1');
    expect((control(positionLabel('Negozio uno')) as HTMLInputElement).value).toBe('4');
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toMatchObject({ places: [{ placeId: P1, position: 4, productionCenterId: 'pc1' }] });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('checks the position of a store of the availability', async () => {
    const { el, openTab, view, type, submit, tab } = await renderCategory(NEW);
    await openTab('availability');
    await type(nameLabel('it'), 'A');
    (el().querySelector('#category-panel-availability input[type=checkbox]') as HTMLInputElement).click();
    await view();
    await type(positionLabel('Negozio uno'), 'xx');
    await submit();
    expect(tab('availability').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(el().querySelector('#category-panel-availability .problem')?.textContent).toContain('FORM.ISSUE.TYPE');
  });
});

describe('CategoryPage: reads', () => {
  it('shows the error state with a way back when the category cannot be read, and retries', async () => {
    const { el, view } = await renderCategory(EDIT, { reads: { item: 'skip' } });
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x', headers: { 'X-Request-Id': 'req-9' } });
    await view();
    const state = el().querySelector('fc-error-state')!;
    expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(state.textContent).toContain('req-9');
    expect(el().querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/product-categories`);
    expect(el().textContent).toContain('PRODUCT_CATEGORIES.FORM.BACK');
    state.querySelector('button')!.click();
    await view();
    backend().expectOne(`${BASE}/${ID}`).flush({ data: CATEGORY }, { headers: { ETag: '"v1"' } });
    await view();
    expect(el().querySelector('fc-error-state')).toBeNull();
    expect(el().querySelector('h1')?.textContent).toContain('EDIT_TITLE');
  });

  it('reports an unexpected failure to read generically', async () => {
    const { el, view } = await renderCategory(EDIT, { reads: null, extra: [{ provide: AppConfig, useValue: { apiBaseUrl: () => null } }] });
    await view();
    expect(el().querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('falls back to italian when the languages cannot be read', async () => {
    const { control, el } = await renderCategory(NEW, { reads: { languages: 'fail' } });
    expect(control(nameLabel('it'))).toBeTruthy();
    expect(el().textContent).not.toContain(nameLabel('en'));
  });

  it('shows the languages the category has besides the ones of the group', async () => {
    const { control, el } = await renderCategory(EDIT, {
      reads: { languages: ['it'], item: { ...CATEGORY, name: { it: 'Caffè', de: 'Kaffee' }, description: { fr: 'Chaud' } } },
    });
    expect((control(nameLabel('de')) as HTMLInputElement).value).toBe('Kaffee');
    expect((control(descriptionLabel('fr')) as HTMLInputElement).value).toBe('Chaud');
    expect(el().querySelectorAll('fc-textarea')).toHaveLength(3);
  });

  it('asks the name in the first language of the group when it has not the one of the user', async () => {
    const { submit, error } = await renderCategory(NEW, { reads: { languages: ['en', 'de'] } });
    await submit();
    expect(error(nameLabel('en'))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('de'))).toBe('');
  });

  it('uses the language of the interface as the required one when the group has it', async () => {
    const { submit, error, harness } = await renderCategory(NEW, { reads: { languages: ['en', 'it'] } });
    const loading = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({ TEST: 'x' });
    await loading;
    harness.detectChanges();
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('en'))).toBe('');
  });

  it('warns when the stores cannot be read', async () => {
    const { el } = await renderCategory(EDIT, { placesFail: true });
    expect([...el().querySelectorAll('[role=alert]')].map((a) => a.textContent?.trim()).filter(Boolean)).toEqual([
      'PRODUCT_CATEGORIES.PLACES_FAILED',
      'PRODUCT_CATEGORIES.PLACES_FAILED',
    ]);
  });

  it('reads the names of the modifier products and lists them as chosen', async () => {
    const { el, referenceApi } = await renderCategory(EDIT);
    expect(referenceApi.lookupNames).toHaveBeenCalledWith(GROUP, 'products', [PROD1], true);
    expect(referenceApi.lookup).toHaveBeenCalledWith(GROUP, 'products', expect.objectContaining({ modifier: true }));
    expect([...el().querySelectorAll('fc-reference-picker .chosen li')].map((li) => li.textContent?.trim())).toEqual(['Coca']);
  });

  it('changes the modifiers and the modifier categories', async () => {
    const { el, view, submit } = await renderCategory(EDIT);
    const panel = el().querySelector('#category-panel-variants')!;
    const product = [...panel.querySelectorAll('fc-reference-picker li label')].find((l) => l.textContent?.trim() === 'Fanta')!;
    (product.querySelector('input') as HTMLInputElement).click();
    const categories = [...panel.querySelectorAll('fc-category-check-list li')];
    const checked = (text: string) => categories.find((li) => li.textContent?.trim() === text)!.querySelector('input') as HTMLInputElement;
    expect(checked('Cibo').checked).toBe(true);
    checked('Cibo').click();
    checked('Bevande').click();
    await view();
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.body).toEqual({ modifierIds: [PROD1, '665f1c2e9b1d4a0012ab3702'], modifierCategoryIds: [ROOT] });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
    void FOOD;
  });
});

describe('CategoryPage: the parent', () => {
  it('lists the tree with its levels without the category and its descendants', async () => {
    const { optionsOf, control } = await renderCategory(EDIT);
    expect(optionsOf(L.parent)).toEqual(['PRODUCT_CATEGORIES.FIELD.PARENT_NONE', 'Bevande', '– PRODUCT_CATEGORIES.NO_NAME', 'Cibo']);
    expect((control(L.parent) as HTMLSelectElement).value).toBe(ROOT);
    void CHILD;
    void OTHER;
  });

  it('lists the whole tree for a new category', async () => {
    const { optionsOf } = await renderCategory(NEW);
    expect(optionsOf(L.parent)).toEqual(['PRODUCT_CATEGORIES.FIELD.PARENT_NONE', 'Bevande', '– Caffè', '– – Espresso', '– PRODUCT_CATEGORIES.NO_NAME', 'Cibo']);
  });

  it('keeps the current parent even when it is not in the tree', async () => {
    const { optionsOf, control } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, parentId: OUTSIDE } } });
    expect(optionsOf(L.parent)).toContain(OUTSIDE);
    expect((control(L.parent) as HTMLSelectElement).value).toBe(OUTSIDE);
  });

  it('warns when the tree cannot be read and keeps the parent of the category', async () => {
    const { el, optionsOf } = await renderCategory(EDIT, { reads: { tree: 'fail' } });
    expect(optionsOf(L.parent)).toEqual(['PRODUCT_CATEGORIES.FIELD.PARENT_NONE', ROOT]);
    expect(el().textContent).toContain('PRODUCT_CATEGORIES.FIELD.PARENT_FAILED');
    expect(el().querySelector('#category-panel-variants .note[role=note]')?.textContent).toContain('PRODUCT_CATEGORIES.FIELD.PARENT_FAILED');
  });

  it('does not warn when the tree is read', async () => {
    const { el } = await renderCategory(EDIT);
    expect(el().textContent).not.toContain('PRODUCT_CATEGORIES.FIELD.PARENT_FAILED');
  });

  it('shows a placeholder for a parent the user cannot see and does not send the parent until the user chooses', async () => {
    const { optionsOf, control, type, submit, view } = await renderCategory(EDIT, {
      profile: { role: 'CA' },
      reads: { item: { ...CATEGORY, parentId: null, parentHidden: true } },
    });
    expect(optionsOf(L.parent)[0]).toBe('PRODUCT_CATEGORIES.PARENT_HIDDEN');
    expect((control(L.parent) as HTMLSelectElement).value).toBe('');
    await type(nameLabel('it'), 'Moka');
    await submit();
    const first = backend().expectOne(`${BASE}/${ID}`);
    expect(first.request.body).toEqual({ name: { it: 'Moka' } });
    first.flush(...fail('INTERNAL_ERROR'));
    await view();
    await type(L.parent, FOOD);
    await submit();
    const second = backend().expectOne(`${BASE}/${ID}`);
    expect(second.request.body).toEqual({ name: { it: 'Moka' }, parentId: FOOD });
    second.flush(...fail('INTERNAL_ERROR'));
    await view();
  });
});

describe('CategoryPage: an existing category', () => {
  it('shows it with its date, a save that waits for a change and the cyclic warning when it has one', async () => {
    const { el, control, save } = await renderCategory(EDIT);
    expect(el().querySelector('h1')?.textContent).toContain('PRODUCT_CATEGORIES.FORM.EDIT_TITLE');
    expect(el().querySelector('.meta')?.textContent).toContain('PRODUCT_CATALOG.FORM.UPDATED');
    expect((control(nameLabel('it')) as HTMLInputElement).value).toBe('Caffè');
    expect((control(L.position) as HTMLInputElement).value).toBe('3');
    expect((control(L.fee) as HTMLInputElement).value).toBe('5');
    expect(save()!.textContent).toContain('COMMON.SAVE');
    expect(save()!.disabled).toBe(true);
    expect(el().querySelector('.note[role=note]')).toBeNull();
  });

  it('warns about a cycle of parents', async () => {
    const { el } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, cyclic: true } } });
    expect(el().textContent).toContain('PRODUCT_CATEGORIES.CYCLIC_NOTE');
  });

  it('shows no date for a category that has none', async () => {
    const { el } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, updatedAt: null } } });
    expect(el().querySelector('.meta')?.textContent).toContain('{"date":""}');
  });

  it('formats the date in the language of the interface', async () => {
    const { el, view } = await renderCategory(EDIT);
    const loading = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({ TEST: 'x' });
    await loading;
    await view();
    expect(el().querySelector('.meta')?.textContent).toContain('2026');
  });

  it('saves only what changed with the version in If-Match, and uses the new one for the next save', async () => {
    const { type, submit, save, view, toasts, router, drain } = await renderCategory(EDIT);
    await type(nameLabel('it'), 'Moka');
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toEqual({ name: { it: 'Moka' } });
    req.flush({ data: { ...CATEGORY, name: { it: 'Moka' } } }, { headers: { ETag: '"v2"' } });
    await view();
    drain();
    expect(toasts()).toEqual(['success: PRODUCT_CATEGORIES.FORM.SAVED']);
    expect(save()!.disabled).toBe(true);
    expect(router.url).toBe(EDIT);
    await type(L.position, '9');
    await submit();
    const second = backend().expectOne(`${BASE}/${ID}`);
    expect(second.request.headers.get('If-Match')).toBe('"v2"');
    expect(second.request.body).toEqual({ position: 9 });
    second.flush({ data: { ...CATEGORY, position: 9 } });
    await view();
    drain();
  });

  it('sends every field that changed, and nothing else', async () => {
    const { type, check, submit, view, openTab, slots } = await renderCategory(EDIT);
    await type(nameLabel('en'), 'Coffee');
    await type(descriptionLabel('it'), '');
    await type(L.parent, '');
    await type(L.position, '');
    await type(L.production, '11');
    await check(L.enabled, false);
    await check(L.noDiscount, true);
    await check(L.legalAge, true);
    await check(L.yellgo, true);
    await check(L.pos, false);
    await check(L.ecommerce, true);
    await check(L.featured, true);
    await check(L.printer, true);
    await check(L.tobacco, true);
    await check(L.endOfMeal, true);
    await type(L.fee, '');
    await type(L.printGroup, '4');
    await type(L.diningType, 'other');
    await type(L.background, '#000001');
    await openTab('media');
    await type(L.fileName, 'f.png');
    await type(L.url, 'https://example.com');
    slots()[1].logoChange.emit({ descriptor: null, imageId: '665f1c2e9b1d4a0012ab3601', label: 'x', previewUrl: null });
    await view();
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.body).toEqual({
      name: { en: 'Coffee' },
      description: { it: null },
      enabled: false,
      noDiscount: true,
      requiresLegalAge: true,
      parentId: null,
      position: null,
      productionValue: 11,
      integrations: { yellgo: true },
      availability: { pos: false, ecommerce: true },
      featured: true,
      secondaryFiscalPrinter: true,
      tobacco: true,
      dining: { endOfMeal: true, type: 'other', feePercentage: null, printGroup: 4 },
      backgroundColor: '#000001',
      icon: { imageId: '665f1c2e9b1d4a0012ab3601' },
      internalFileName: 'f.png',
      externalUrl: 'https://example.com',
    });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('does not ask for the name in the required language of a category that never had it', async () => {
    const { type, submit, error, view } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, name: { en: 'Coffee' } } } });
    await type(nameLabel('en'), 'Coffee 2');
    await submit();
    expect(error(nameLabel('it'))).toBe('');
    backend().expectOne(`${BASE}/${ID}`).flush(...fail('INTERNAL_ERROR'));
    await view();
    await type(nameLabel('en'), '');
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('removes the image in the media tab', async () => {
    const image = { _id: 'not-an-object-id', basename: 'foto', extension: 'png', filename: 'foto.png', mimetype: 'image/png', title: null, alt: null, dirname: '/', type: 'image', filectime: 1 };
    const { el, openTab, view, submit, save } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, image } } });
    await openTab('media');
    expect(el().querySelector('fc-logo-slot')?.textContent).toContain('foto.png');
    const remove = [...el().querySelectorAll<HTMLButtonElement>('fc-logo-slot button')].find((b) => b.textContent?.trim() === 'COMPANIES.MEDIA.REMOVE')!;
    remove.click();
    await view();
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.body).toEqual({ image: null });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('changes the stations of a store from the ones it had', async () => {
    const { el, openStore, view, submit } = await renderCategory(EDIT, {
      reads: { item: { ...CATEGORY, printStations: { [P1]: ['st1'] }, counterPrintStations: { [P1]: ['st2'], [P2]: [] } } },
    });
    const stations = el().querySelector('#category-panel-stations')!;
    await view();
    expect(stations.querySelector('details')!.open).toBe(true);
    expect(stations.textContent).toContain('PRODUCT_CATEGORIES.STATIONS.CHOSEN {"count":2}');
    const boxes = () => [...stations.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false, true]);
    boxes()[0].click();
    boxes()[3].click();
    await view();
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.body).toEqual({ printStations: { [P1]: null }, counterPrintStations: { [P1]: null } });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
    await openStore('Negozio due');
    expect(stations.textContent).toContain('PRODUCT_CATEGORIES.STATIONS.LOAD_ERROR');
  });

  it('changes the availability from the stores it had', async () => {
    const { el, openTab, view, submit } = await renderCategory(EDIT);
    await openTab('availability');
    const boxes = () => [...el().querySelectorAll<HTMLInputElement>('#category-panel-availability li > fc-checkbox input')];
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    boxes()[1].click();
    await view();
    boxes()[0].click();
    await view();
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.body).toEqual({ places: [{ placeId: P2, position: null, productionCenterId: null }] });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });
});

describe('CategoryPage: read only', () => {
  it('is read only without products:update', async () => {
    const { el, control, save, page, slots } = await renderCategory(EDIT, { profile: { permissions: READ_ONLY } });
    expect((control(nameLabel('it')) as HTMLInputElement).disabled).toBe(true);
    expect((control(L.position) as HTMLInputElement).disabled).toBe(true);
    expect(save()).toBeNull();
    expect(el().querySelector('.swatch')).toBeNull();
    expect(el().querySelector('p[role=note]')).toBeNull();
    expect(slots().every((s) => s.disabled())).toBe(true);
    expect(page().confirmLeave()).toBe(true);
  });

  it('is read only, with a warning, when the server says the category is not editable', async () => {
    const { el, control, save, page } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, editable: false } } });
    expect(el().querySelector('p[role=note]')?.textContent).toContain('PRODUCT_CATEGORIES.READ_ONLY_SHARED');
    expect((control(nameLabel('it')) as HTMLInputElement).disabled).toBe(true);
    expect(save()).toBeNull();
    expect(page().confirmLeave()).toBe(true);
  });

  it('stays editable when the server says it is', async () => {
    const { el, save } = await renderCategory(EDIT, { reads: { item: { ...CATEGORY, editable: true } } });
    expect(el().querySelector('p[role=note]')).toBeNull();
    expect(save()).not.toBeNull();
  });
});

describe('CategoryPage: leaving the page', () => {
  it('leaves at once when nothing changed', async () => {
    const { page } = await renderCategory(EDIT);
    expect(page().confirmLeave()).toBe(true);
  });

  it('asks first when something is unsaved: staying, or leaving', async () => {
    const { type, page, view, dialogButton, el } = await renderCategory(EDIT);
    await type(nameLabel('it'), 'Modificato');
    const stay = page().confirmLeave() as Promise<boolean>;
    await view();
    expect(el().querySelector('dialog[open]')?.textContent).toContain('PRODUCT_CATALOG.LEAVE.MESSAGE');
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(await stay).toBe(false);
    const leave = page().confirmLeave() as Promise<boolean>;
    await view();
    dialogButton('PRODUCT_CATALOG.LEAVE.CONFIRM').click();
    await view();
    expect(await leave).toBe(true);
    expect(el().querySelector('dialog[open]')).toBeNull();
  });

  it('asks on a new category that was started, through the guard of the route, and not after a save', async () => {
    const { type, submit, view, router, dialogButton, answer } = await renderCategory(NEW);
    await type(nameLabel('it'), 'Acme');
    const blocked = router.navigateByUrl('/elsewhere');
    await view();
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(await blocked).toBe(false);
    await submit();
    backend().expectOne(BASE).flush({ data: CATEGORY }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view();
    await answer({ edit: true });
    expect(router.url).toBe(EDIT);
    expect(await router.navigateByUrl('/elsewhere')).toBe(true);
  });

  it('does not ask on a new category left empty', async () => {
    const { page } = await renderCategory(NEW);
    expect(page().confirmLeave()).toBe(true);
  });
});
