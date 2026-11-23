import { TestBed } from '@angular/core/testing';
import {
  BASE,
  CATEGORY,
  EDIT,
  FOOD,
  ID,
  L,
  NEW,
  descriptionLabel,
  nameLabel,
  renderCategory,
} from '../../../testing/category-page';
import { backend, errorBody } from '../../../testing/api';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

type Details = { field: string; issue: string }[];

/** Renders the page of a new category with a valid name, ready to be saved. */
async function ready() {
  const view = await renderCategory(NEW);
  await view.type(nameLabel('it'), 'A');
  return view;
}

/** Saves the new category and answers the request with an error. */
async function saveWith(view: Awaited<ReturnType<typeof ready>>, code: string, status: number, details?: Details) {
  await view.submit();
  backend().expectOne(BASE).flush(errorBody(code, details), { status, statusText: 'x' });
  await view.view();
}

describe('CategoryPage: errors of the server', () => {
  it('puts the 422 issues on their fields, opens the first tab with an error and says so in the tabs', async () => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'name', issue: 'taken' },
      { field: 'description', issue: 'maxLength' },
      { field: 'position', issue: 'maximum' },
      { field: 'modifierIds.1', issue: 'notAllowed' },
      { field: 'modifierCategoryIds', issue: 'notAllowed' },
      { field: 'printStations.665f1c2e9b1d4a0012ab3401', issue: 'notAllowed' },
      { field: 'counterPrintStations.665f1c2e9b1d4a0012ab3401.0', issue: 'notAllowed' },
      { field: 'places.0.placeId', issue: 'notAllowed' },
      { field: 'image', issue: 'format' },
      { field: 'icon', issue: 'format' },
      { field: 'internalFileName', issue: 'maxLength' },
      { field: 'externalUrl', issue: 'format' },
    ]);
    const { error, tab, visible, el, formError } = view;
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.TAKEN');
    expect(error(descriptionLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(error(L.position)).toBe('FORM.ISSUE.MAXIMUM');
    expect(error(L.fileName)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(error(L.url)).toBe('FORM.ISSUE.FORMAT');
    expect(el().querySelector('#category-panel-variants .problem')?.textContent).toContain('FORM.ISSUE.NOT_ALLOWED');
    expect(el().querySelector('#category-panel-stations .problem')?.textContent).toContain('FORM.ISSUE.NOT_ALLOWED');
    expect(el().querySelector('#category-panel-availability .problem')?.textContent).toContain('FORM.ISSUE.NOT_ALLOWED');
    expect(el().querySelectorAll('#category-panel-media > .problem')).toHaveLength(2);
    expect(tab('general').textContent).toContain('TAB_LIST.ERRORS {"count":3}');
    expect(tab('variants').textContent).toContain('TAB_LIST.ERRORS {"count":2}');
    expect(tab('stations').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(tab('availability').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(tab('media').textContent).toContain('TAB_LIST.ERRORS {"count":4}');
    expect(visible()).toEqual(['category-panel-general']);
    expect(formError()).toBeNull();
  });

  it('opens the tab of the errors when the first one is not in the general tab', async () => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'externalUrl', issue: 'format' },
      { field: 'places.0.placeId', issue: 'notAllowed' },
    ]);
    expect(view.visible()).toEqual(['category-panel-availability']);
  });

  it('opens the variants tab when its fields are the only ones with an error', async () => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'modifierIds.0', issue: 'notAllowed' }]);
    expect(view.visible()).toEqual(['category-panel-variants']);
  });

  it.each([
    ['modifierCategoryIds.0', 'variants'],
    ['counterPrintStations.x.0', 'stations'],
    ['printStations.x', 'stations'],
    ['places.0.placeId', 'availability'],
    ['image', 'media'],
    ['icon', 'media'],
    ['internalFileName', 'media'],
    ['externalUrl', 'media'],
    ['textColor', 'general'],
  ])('shows the tab of the field %s', async (field, section) => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field, issue: 'notAllowed' }]);
    expect(view.visible()).toEqual([`category-panel-${section}`]);
  });

  it('does not leave a tab when a server error is on a field no tab counts', async () => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'textColor', issue: 'format' }]);
    await view.openTab('media');
    await view.submit();
    expect(backend().match(BASE)).toHaveLength(0);
    expect(view.visible()).toEqual(['category-panel-media']);
  });

  it('puts an issue it cannot place in a message of the form, and keeps the tab', async () => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'extra', issue: 'unknown' }]);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    expect(view.visible()).toEqual(['category-panel-general']);
  });

  it('answers a 422 without details with the message of the code', async () => {
    const view = await ready();
    await saveWith(view, 'VALIDATION_ERROR', 422);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
  });

  it('puts a parent that would close a cycle (409 with details) on the parent field', async () => {
    const view = await renderCategory(EDIT);
    await view.type(L.parent, FOOD);
    await view.submit();
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('CONFLICT', [{ field: 'parentId', issue: 'incorrect' }]), { status: 409, statusText: 'x' });
    await view.view();
    expect(view.error(L.parent)).toBe('FORM.ISSUE.INCORRECT');
    expect(view.formError()).toBeNull();
    expect(view.reload()).toBeUndefined();
  });

  it('tells the group has too many categories (409 tooMany)', async () => {
    const view = await ready();
    await saveWith(view, 'CONFLICT', 409, [{ field: 'categories', issue: 'tooMany' }]);
    expect(view.formError()).toContain('PRODUCT_CATEGORIES.ERROR.TOO_MANY');
  });

  it('asks to read the category again on a 412, and reads it on request', async () => {
    const view = await renderCategory(EDIT);
    await view.type(nameLabel('it'), 'Mio');
    await view.submit();
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('PRODUCT_CATEGORIES.FORM.STALE');
    view.reload()!.click();
    await view.view();
    backend().expectOne(`${BASE}/${ID}`).flush({ data: { ...CATEGORY, name: { it: 'Di un altro' } } }, { headers: { ETag: '"v9"' } });
    await view.view();
    expect(view.formError()).toBeNull();
    expect((view.control(nameLabel('it')) as HTMLInputElement).value).toBe('Di un altro');
    await view.type(nameLabel('it'), 'Nuovo');
    await view.submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.headers.get('If-Match')).toBe('"v9"');
    req.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(view.reload()).toBeUndefined();
  });

  it('asks to read again on a 409 without details', async () => {
    const view = await renderCategory(EDIT);
    await view.type(nameLabel('it'), 'Mio');
    await view.submit();
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('PRODUCT_CATALOG.ERROR.CONCURRENT');
    expect(view.reload()).toBeTruthy();
  });

  it('answers a 403 on the stores in the availability tab, on the stores field', async () => {
    const view = await ready();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'places.0.placeId', issue: 'notAllowed' }]);
    expect(view.visible()).toEqual(['category-panel-availability']);
    expect(view.el().querySelector('#category-panel-availability .problem')?.textContent).toContain('PRODUCT_CATEGORIES.ERROR.PLACES_FORBIDDEN');
    expect(view.formError()).toBeNull();
  });

  it('answers a 403 on the print stations in the stations tab, on the stations field', async () => {
    const view = await ready();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'printStations.x', issue: 'notAllowed' }]);
    expect(view.visible()).toEqual(['category-panel-stations']);
    expect(view.el().querySelector('#category-panel-stations .problem')?.textContent).toContain('PRODUCT_CATEGORIES.ERROR.PLACES_FORBIDDEN');
  });

  it('answers a 403 on something else, or without details, with a general message', async () => {
    const view = await ready();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'position', issue: 'notAllowed' }]);
    expect(view.formError()).toContain('PRODUCT_CATALOG.ERROR.FORBIDDEN');
    expect(view.visible()).toEqual(['category-panel-general']);
    await saveWith(view, 'FORBIDDEN', 403);
    expect(view.formError()).toContain('PRODUCT_CATALOG.ERROR.FORBIDDEN');
    expect(view.reload()).toBeUndefined();
  });

  it('reports another error of the API, with or without details, by its code', async () => {
    const view = await ready();
    await saveWith(view, 'RATE_LIMITED', 429);
    expect(view.formError()).toContain('ERRORS.API.RATE_LIMITED');
    await saveWith(view, 'NOT_FOUND', 404, [{ field: 'position', issue: 'x' }]);
    expect(view.formError()).toContain('ERRORS.API.NOT_FOUND');
  });

  it('reports a failure that is not from the API generically and logs it', async () => {
    const view = await ready();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(TestBed.inject(ProductCatalogApi), 'create').mockRejectedValueOnce(new TypeError('boom'));
    await view.submit();
    expect(view.formError()).toContain('ERRORS.GENERIC.MESSAGE');
    expect(log).toHaveBeenCalled();
  });

  it('does not send a form with an error of the client and opens the tab that has it, moving the focus', async () => {
    const view = await ready();
    await view.type(L.url, 'http://example.com');
    await view.openTab('availability');
    await view.submit();
    expect(backend().match(BASE)).toHaveLength(0);
    expect(view.visible()).toEqual(['category-panel-media']);
    expect(document.activeElement).toBe(view.control(L.url));
  });

  it('keeps the stores of a restricted user in the 403 of the stores', async () => {
    const view = await renderCategory(NEW, { profile: { role: 'CA' } });
    await view.type(nameLabel('it'), 'A');
    (view.el().querySelector('#category-panel-availability input[type=checkbox]') as HTMLInputElement).click();
    await view.view();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: `places.0.placeId`, issue: 'notAllowed' }]);
    expect(view.el().querySelector('#category-panel-availability .problem')?.textContent).toContain('PRODUCT_CATEGORIES.ERROR.PLACES_FORBIDDEN');
  });
});
