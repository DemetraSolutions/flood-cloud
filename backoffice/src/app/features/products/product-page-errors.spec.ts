import { TestBed } from '@angular/core/testing';
import { ProductApi } from './product-api';
import { backend, errorBody } from '../../../testing/api';
import {
  CAT,
  EDIT,
  GROUP,
  ID,
  ITEM,
  L,
  LIST_ROUTE,
  NEW,
  PROD1,
  PRODUCT,
  READ_ONLY,
  Options,
  Reads,
  descriptionLabel,
  fail,
  nameLabel,
  renderProduct,
} from '../../../testing/product-page';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

type Details = { field: string; issue: string }[];
type View = Awaited<ReturnType<typeof renderProduct>>;

const TRASHED: Reads = { item: { trashed: true, trashedAt: '2026-11-12T10:00:00.000Z' } };

/** Renders the page of a product with a change ready to be saved. */
async function edited(options: Options = {}) {
  const view = await renderProduct(EDIT, options);
  await view.type(L.code, 'C2');
  return view;
}

/** Saves the product and answers the request with an error. */
async function saveWith(view: View, code: string, status: number, details?: Details) {
  await view.submit();
  backend().expectOne(ITEM).flush(errorBody(code, details), { status, statusText: 'x' });
  await view.view();
}

const count = (view: View, tab: string, errors: number) =>
  expect(view.tab(tab)!.textContent, tab).toContain(`TAB_LIST.ERRORS {"count":${errors}}`);

describe('ProductPage: errors of the server on a save', () => {
  it('puts the 422 issues on their fields and counts them in the tabs', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'code', issue: 'maxLength' },
      { field: 'name', issue: 'taken' },
      { field: 'isModifier', issue: 'notAllowed' },
      { field: 'barcodes.0.value', issue: 'pattern' },
      { field: 'prices.0.net', issue: 'minimum' },
      { field: 'categoryIds', issue: 'notAllowed' },
      { field: 'places.0.placeId', issue: 'notAllowed' },
      { field: 'modifierIds', issue: 'notAllowed' },
      { field: 'printStations.x', issue: 'notAllowed' },
      { field: 'stock.p.s.min', issue: 'minimum' },
      { field: 'attributeIds', issue: 'notAllowed' },
      { field: 'components.0.productId', issue: 'incorrect' },
      { field: 'menu.0.categoryId', issue: 'notAllowed' },
      { field: 'modifierChoices.0', issue: 'notAllowed' },
      { field: 'modularPriceRule', issue: 'unknown' },
      { field: 'image', issue: 'format' },
      { field: 'gallery.1', issue: 'format' },
      { field: 'internalFileName', issue: 'maxLength' },
      { field: 'externalUrl', issue: 'format' },
      { field: 'simpleCost', issue: 'maximum' },
      { field: 'suppliers.0.contactId', issue: 'notAllowed' },
      { field: 'shipping.width', issue: 'maximum' },
    ]);
    expect(view.error(L.code)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.error(nameLabel('it'))).toBe('FORM.ISSUE.TAKEN');
    expect(view.error(L.fileName)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.error(L.url)).toBe('FORM.ISSUE.FORMAT');
    expect(view.error(L.cost)).toBe('FORM.ISSUE.MAXIMUM');
    expect(view.error(L.width)).toBe('FORM.ISSUE.MAXIMUM');
    for (const [tab, errors] of [
      ['general', 3],
      ['barcodes', 1],
      ['prices', 1],
      ['categories', 1],
      ['availability', 1],
      ['variants', 1],
      ['stations', 1],
      ['stock', 1],
      ['attributes', 1],
      ['composition', 4],
      ['media', 4],
      ['margin', 1],
      ['suppliers', 1],
      ['shipping', 1],
    ] as const) {
      count(view, tab, errors);
    }
    expect(view.visible()).toEqual(['general']);
    expect(view.formError()).toBeNull();
    expect(view.reload()).toBeUndefined();
  });

  it.each([
    ['barcodes.0.value', 'barcodes'],
    ['prices.0.net', 'prices'],
    ['categoryIds.0', 'categories'],
    ['places.0.placeId', 'availability'],
    ['requiredModifierIds', 'variants'],
    ['printStations.x', 'stations'],
    ['stock.p.s.min', 'stock'],
    ['attributeIds.0', 'attributes'],
    ['components.0.productId', 'composition'],
    ['image', 'media'],
    ['simpleCost', 'margin'],
    ['suppliers.0.contactId', 'suppliers'],
    ['shipping.width', 'shipping'],
    ['position', 'general'],
  ])('opens the tab of the field %s', async (field, section) => {
    const view = await edited();
    await view.openTab('shipping');
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field, issue: 'notAllowed' }]);
    expect(view.visible()).toEqual([section]);
  });

  it('opens the first tab that has an error, in the order of the tabs', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'shipping.width', issue: 'maximum' },
      { field: 'prices.0.net', issue: 'minimum' },
    ]);
    expect(view.visible()).toEqual(['prices']);
  });

  it('switches to the full view when the error is in a tab the quick view does not have', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`);
    await view.type(L.code, 'C2');
    expect(view.tabs()).toHaveLength(5);
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'shipping.width', issue: 'maximum' }]);
    expect(view.tabs()).toHaveLength(14);
    expect(view.visible()).toEqual(['shipping']);
    expect(view.viewButton('FULL').getAttribute('aria-pressed')).toBe('true');
  });

  it('stays in the quick view when the error is in a tab it has', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`);
    await view.type(L.code, 'C2');
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'categoryIds.0', issue: 'notAllowed' }]);
    expect(view.tabs()).toHaveLength(5);
    expect(view.visible()).toEqual(['categories']);
  });

  it('answers a 422 without details with the message of the code', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    expect(view.reload()).toBeUndefined();
  });

  it('shows an issue on an element of a list of ids on the list (tab count and message)', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'categoryIds.0', issue: 'notAllowed' }]);
    count(view, 'categories', 1);
    expect(view.el().querySelector('#product-panel-categories .problem')?.textContent).toContain('FORM.ISSUE.NOT_ALLOWED');
  });

  it('puts an issue on a field the form does not have where the user can see it', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'extra', issue: 'unknown' }]);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    expect(view.visible()).toEqual(['general']);
  });

  it('tells there are too many items to follow (422 tooMany)', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'products', issue: 'tooMany' }]);
    expect(view.formError()).toContain('PRODUCTS.ERROR.TOO_MANY');
  });

  it('puts a cycle in the bill of materials (409 with details) on the components', async () => {
    const view = await edited();
    await saveWith(view, 'CONFLICT', 409, [{ field: 'components', issue: 'incorrect' }]);
    expect(view.visible()).toEqual(['composition']);
    count(view, 'composition', 1);
    expect(view.formError()).toBeNull();
    expect(view.reload()).toBeUndefined();
  });

  it('asks to read the product again on a 412, and reads it on request', async () => {
    const view = await edited();
    await saveWith(view, 'PRECONDITION_FAILED', 412);
    expect(view.formError()).toContain('PRODUCTS.FORM.STALE');
    view.reload()!.click();
    await view.view();
    backend().expectOne(ITEM).flush({ data: { ...PRODUCT, code: 'ALTRUI' } }, { headers: { ETag: '"v9"' } });
    await view.answer({ edit: true });
    expect(view.formError()).toBeNull();
    expect((view.control(L.code) as HTMLInputElement).value).toBe('ALTRUI');
    await view.type(L.code, 'NUOVO');
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.headers.get('If-Match')).toBe('"v9"');
    req.flush(...fail('INTERNAL_ERROR'));
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(view.reload()).toBeUndefined();
  });

  it('asks to read again on a 409 without details', async () => {
    const view = await edited();
    await saveWith(view, 'CONFLICT', 409);
    expect(view.formError()).toContain('PRODUCTS.FORM.STALE');
    expect(view.reload()).toBeTruthy();
  });

  it('answers a 403 on the stores in the availability tab, on the stores field', async () => {
    const view = await edited();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'places.0.placeId', issue: 'notAllowed' }]);
    expect(view.visible()).toEqual(['availability']);
    expect(view.el().querySelector('#product-panel-availability .problem')?.textContent).toContain('PRODUCTS.ERROR.PLACES_FORBIDDEN');
    expect(view.formError()).toBeNull();
  });

  it('answers a 403 on the print stations in the stations tab, on the stations field', async () => {
    const view = await edited();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'counterPrintStations.x', issue: 'notAllowed' }]);
    expect(view.visible()).toEqual(['stations']);
    expect(view.el().querySelector('#product-panel-stations .problem')?.textContent).toContain('PRODUCTS.ERROR.PLACES_FORBIDDEN');
  });

  it('answers a 403 on the stores and the stations with the stores', async () => {
    const view = await edited();
    await saveWith(view, 'FORBIDDEN', 403, [
      { field: 'printStations.x', issue: 'notAllowed' },
      { field: 'places.0.placeId', issue: 'notAllowed' },
    ]);
    expect(view.visible()).toEqual(['availability']);
    expect(view.el().querySelector('#product-panel-stations .problem')).toBeNull();
  });

  it('answers a 403 on something else, or without details, with a general message', async () => {
    const view = await edited();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'position', issue: 'notAllowed' }]);
    expect(view.formError()).toContain('PRODUCT_CATALOG.ERROR.FORBIDDEN');
    expect(view.visible()).toEqual(['general']);
    await saveWith(view, 'FORBIDDEN', 403);
    expect(view.formError()).toContain('PRODUCT_CATALOG.ERROR.FORBIDDEN');
    expect(view.reload()).toBeUndefined();
  });

  it('reports another error of the API, with or without details, by its code', async () => {
    const view = await edited();
    await saveWith(view, 'RATE_LIMITED', 429);
    expect(view.formError()).toContain('ERRORS.API.RATE_LIMITED');
    await saveWith(view, 'NOT_FOUND', 404, [{ field: 'position', issue: 'x' }]);
    expect(view.formError()).toContain('ERRORS.API.NOT_FOUND');
  });

  it('reports a failure that is not from the API generically and logs it', async () => {
    const view = await edited();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(TestBed.inject(ProductApi), 'update').mockRejectedValueOnce(new TypeError('boom'));
    await view.submit();
    expect(view.formError()).toContain('ERRORS.GENERIC.MESSAGE');
    expect(log).toHaveBeenCalled();
  });

  it('keeps the stores of a restricted user on the 403 of the stores', async () => {
    const view = await renderProduct(EDIT, { profile: { role: 'CA' }, reads: { item: { editable: false, placeEditable: true } } });
    await view.setLocal({ stations: { rooms: { x: ['st1'] }, counter: {} } });
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'places.0.placeId', issue: 'notAllowed' }]);
    expect(view.el().querySelector('#product-panel-availability .problem')?.textContent).toContain('PRODUCTS.ERROR.PLACES_FORBIDDEN');
  });
});

describe('ProductPage: a product in the trash', () => {
  it('restores it with the version read and goes on with the new one', async () => {
    const view = await renderProduct(EDIT, { reads: TRASHED });
    view.button('PRODUCTS.RESTORE.ACTION')!.click();
    await view.view();
    expect(view.button('PRODUCTS.RESTORE.ACTION')!.disabled).toBe(true);
    const req = backend().expectOne(`${ITEM}/restore`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toBeNull();
    req.flush({ data: { ...PRODUCT, trashed: false } }, { headers: { ETag: '"v2"' } });
    await view.view();
    expect(view.toasts()).toEqual(['success: PRODUCTS.RESTORE.DONE']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'products');
    expect(view.el().querySelector('.note[role=note]')).toBeNull();
    expect(view.button('PRODUCTS.RESTORE.ACTION')).toBeUndefined();
    expect(view.save()).toBeTruthy();
    await view.type(L.code, 'C3');
    await view.submit();
    expect(backend().expectOne(ITEM).request.headers.get('If-Match')).toBe('"v2"');
  });

  it.each([
    [409, 'CONFLICT', 'PRODUCTS.FORM.STALE', true],
    [412, 'PRECONDITION_FAILED', 'PRODUCTS.FORM.STALE', true],
    [403, 'FORBIDDEN', 'PRODUCT_CATALOG.ERROR.FORBIDDEN', false],
    [500, 'INTERNAL_ERROR', 'ERRORS.API.INTERNAL_ERROR', false],
  ])('says why it cannot be restored (%s)', async (status, code, message, stale) => {
    const view = await renderProduct(EDIT, { reads: TRASHED });
    view.button('PRODUCTS.RESTORE.ACTION')!.click();
    await view.view();
    backend().expectOne(`${ITEM}/restore`).flush(errorBody(code), { status, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain(message);
    expect(!!view.reload()).toBe(stale);
    expect(view.button('PRODUCTS.RESTORE.ACTION')!.disabled).toBe(false);
    expect(view.toasts()).toEqual([]);
  });

  it('asks to confirm the deletion for good, and the cancel leaves it alone', async () => {
    const view = await renderProduct(EDIT, { reads: TRASHED });
    view.button('PRODUCTS.DELETE.ACTION')!.click();
    await view.view();
    expect(view.dialogButton('PRODUCTS.DELETE.ACTION')).toBeTruthy();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(backend().match(ITEM)).toHaveLength(0);
  });

  it('deletes it for good with the version read, says so and goes back to the list', async () => {
    const view = await renderProduct(EDIT, { reads: TRASHED });
    view.button('PRODUCTS.DELETE.ACTION')!.click();
    await view.view();
    view.dialogButton('PRODUCTS.DELETE.ACTION').click();
    await view.view();
    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await view.view();
    expect(view.toasts()).toEqual(['success: PRODUCTS.DELETE.DONE {"name":"Caffè"}']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'products');
    expect(view.router.url).toBe(LIST_ROUTE);
  });

  it('deletes a product that has no name in the language of the user by the first it has', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { trashed: true, name: { fr: 'Café' } } } });
    view.button('PRODUCTS.DELETE.ACTION')!.click();
    await view.view();
    view.dialogButton('PRODUCTS.DELETE.ACTION').click();
    await view.view();
    backend().expectOne(ITEM).flush(null, { status: 204, statusText: 'No Content' });
    await view.view();
    expect(view.toasts()).toEqual(['success: PRODUCTS.DELETE.DONE {"name":"Café"}']);
  });

  it('says what refers to the product when the server refuses to delete it, with the names of the references', async () => {
    const view = await renderProduct(EDIT, { reads: TRASHED });
    view.button('PRODUCTS.DELETE.ACTION')!.click();
    await view.view();
    view.dialogButton('PRODUCTS.DELETE.ACTION').click();
    await view.view();
    backend().expectOne(ITEM).flush(
      errorBody('CONFLICT', [
        { field: `productBundles.${PROD1}`, issue: 'referenced' },
        { field: `categoryModifiers.${CAT}`, issue: 'referenced' },
        { field: 'productBundles', issue: 'referenced' },
        { field: 'favorites.abc', issue: 'referenced' },
        { field: 'serviceUsers', issue: 'referenced' },
        { field: 'whatever.1', issue: 'referenced' },
      ]),
      { status: 409, statusText: 'x' },
    );
    await view.view();
    await view.view();
    const block = view.el().querySelector('fc-product-reference-block')!;
    expect(block.querySelector('h2')?.textContent).toContain('PRODUCTS.DELETE.BLOCKED_TITLE {"name":"Caffè"}');
    expect([...block.querySelectorAll('h3')].map((h) => h.textContent?.trim())).toEqual([
      'PRODUCTS.REFERENCE.productBundles',
      'PRODUCTS.REFERENCE.categoryModifiers',
      'PRODUCTS.REFERENCE.serviceUsers',
      'PRODUCTS.REFERENCE.favorites',
    ]);
    expect([...block.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([
      'Coca',
      'PRODUCTS.DELETE.HIDDEN',
      'Bevande',
      'PRODUCTS.DELETE.HIDDEN',
      'abc',
    ]);
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.formError()).toBeNull();
    expect(view.toasts()).toEqual([]);
    (view.button('COMMON.CLOSE') as HTMLButtonElement).click();
    await view.view();
    expect(view.el().querySelector('fc-product-reference-block')).toBeNull();
  });

  it('shows the ids of the references whose names cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = await renderProduct(EDIT, { reads: TRASHED, namesFail: true });
    view.button('PRODUCTS.DELETE.ACTION')!.click();
    await view.view();
    view.dialogButton('PRODUCTS.DELETE.ACTION').click();
    await view.view();
    backend().expectOne(ITEM).flush(errorBody('CONFLICT', [{ field: `productMenus.${PROD1}`, issue: 'referenced' }]), { status: 409, statusText: 'x' });
    await view.view();
    await view.view();
    expect(view.el().querySelector('fc-product-reference-block li')?.textContent?.trim()).toBe(PROD1);
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    [409, 'CONFLICT', 'PRODUCTS.FORM.STALE', true],
    [412, 'PRECONDITION_FAILED', 'PRODUCTS.FORM.STALE', true],
    [403, 'FORBIDDEN', 'PRODUCT_CATALOG.ERROR.FORBIDDEN', false],
    [500, 'INTERNAL_ERROR', 'ERRORS.API.INTERNAL_ERROR', false],
  ])('says why it cannot be deleted (%s) and closes the dialog', async (status, code, message, stale) => {
    const view = await renderProduct(EDIT, { reads: TRASHED });
    view.button('PRODUCTS.DELETE.ACTION')!.click();
    await view.view();
    view.dialogButton('PRODUCTS.DELETE.ACTION').click();
    await view.view();
    backend().expectOne(ITEM).flush(errorBody(code), { status, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain(message);
    expect(!!view.reload()).toBe(stale);
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.el().querySelector('fc-product-reference-block')).toBeNull();
    expect(view.router.url).toBe(EDIT);
  });
});

describe('ProductPage: leaving the page', () => {
  it('leaves at once when nothing changed', async () => {
    const view = await renderProduct(EDIT);
    expect(view.component().confirmLeave()).toBe(true);
    await view.router.navigateByUrl('/elsewhere');
    expect(view.router.url).toBe('/elsewhere');
  });

  it('leaves at once a page that cannot be written, changed or not', async () => {
    const view = await renderProduct(EDIT, { profile: { permissions: READ_ONLY } });
    expect(view.component().confirmLeave()).toBe(true);
  });

  it('leaves at once a new product that is still empty', async () => {
    const view = await renderProduct(NEW);
    expect(view.component().confirmLeave()).toBe(true);
  });

  it('asks to confirm when there are changes, and leaves when the user confirms', async () => {
    const view = await edited();
    const navigation = view.router.navigateByUrl('/elsewhere');
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeTruthy();
    expect(view.dialogButton('PRODUCT_CATALOG.LEAVE.CONFIRM')).toBeTruthy();
    view.dialogButton('PRODUCT_CATALOG.LEAVE.CONFIRM').click();
    await view.view();
    expect(await navigation).toBe(true);
    expect(view.router.url).toBe('/elsewhere');
  });

  it('stays when the user cancels, and asks again the next time', async () => {
    const view = await edited();
    const navigation = view.router.navigateByUrl('/elsewhere');
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(await navigation).toBe(false);
    expect(view.router.url).toBe(EDIT);
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    const again = view.router.navigateByUrl('/elsewhere');
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeTruthy();
    view.dialogButton('PRODUCT_CATALOG.LEAVE.CONFIRM').click();
    await view.view();
    expect(await again).toBe(true);
  });

  it('asks to confirm the leaving of a new product that has something in it', async () => {
    const view = await renderProduct(NEW);
    await view.type(nameLabel('it'), 'A');
    const result = view.component().confirmLeave();
    expect(result).toBeInstanceOf(Promise);
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(await result).toBe(false);
  });

  it('does not ask after the product was saved', async () => {
    const view = await edited();
    await view.submit();
    backend().expectOne(ITEM).flush({ data: { ...PRODUCT, code: 'C2' } }, { headers: { ETag: '"v2"' } });
    await view.view();
    expect(view.component().confirmLeave()).toBe(true);
  });

  it('answers the confirmation of the leaving that nobody waits for', async () => {
    const view = await edited();
    const page = view.component() as unknown as { onLeave(): void; onLeaveClosed(): void };
    page.onLeave();
    page.onLeaveClosed();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
  });
});

describe('ProductPage: the product cannot be read', () => {
  it('says so, with the code of the request and a link to the list, and reads again on request', async () => {
    const view = await renderProduct(EDIT, { reads: { item: 'fail' } });
    expect(view.el().querySelector('fc-error-state .title')?.textContent).toContain('PRODUCT_CATALOG.LOAD_ERROR');
    expect(view.el().querySelector('fc-error-state .message')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(LIST_ROUTE);
    expect(view.el().querySelector('form')).toBeNull();
    (view.el().querySelector('fc-error-state button') as HTMLButtonElement).click();
    await view.view();
    backend().expectOne(ITEM).flush({ data: PRODUCT }, { headers: { ETag: '"v1"' } });
    await view.view();
    expect(view.el().querySelector('fc-error-state')).toBeNull();
    expect(view.heading()).toBe('PRODUCTS.FAMILY.PRODUCTS.EDIT_TITLE');
  });

  it('shows the code of the request the server gave', async () => {
    const view = await renderProduct(EDIT, { reads: { item: 'fail', itemStatus: 404, requestId: 'req-1' } });
    expect(view.el().querySelector('fc-error-state .message')?.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(view.el().querySelector('fc-error-state .request-id')?.textContent).toContain('req-1');
  });

  it('says so generically when the failure is not from the API', async () => {
    const read = vi.fn().mockRejectedValue(new TypeError('boom'));
    const view = await renderProduct(EDIT, { reads: null, extra: [{ provide: ProductApi, useValue: { read } }] });
    await view.answer({ item: 'skip' });
    expect(view.el().querySelector('fc-error-state .message')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    expect(view.el().querySelector('fc-error-state .request-id')).toBeNull();
  });

  it('shows the loading state until the product is read', async () => {
    const view = await renderProduct(EDIT, { reads: null });
    await view.answer({ item: 'skip' });
    expect(view.el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    backend().expectOne(ITEM).flush({ data: PRODUCT }, { headers: { ETag: '"v1"' } });
    await view.view();
    expect(view.heading()).toBe('PRODUCTS.FAMILY.PRODUCTS.EDIT_TITLE');
  });
});
