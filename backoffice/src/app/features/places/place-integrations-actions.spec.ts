import { backend, errorBody } from '../../../testing/api';
import {
  CATEGORY_1,
  CATEGORY_2,
  ETAG,
  PLACE_URL,
  fakePlace,
  renderPlace,
} from '../../../testing/places';
import { cleanUp, READ_ONLY, storedBlock, withValue } from '../../../testing/places-tabs';

const URL_OF = (path: string) => `${PLACE_URL}/integrations/${path}`;
const ON = { dojo: true, satispay: true, tsh: true, geocoding: true };
const KEY_ID = 'PLACES.F.INTEGRATIONS.SATISPAY.KEY_ID';
const SYNC = 'INTEGRATIONS.TSH.SYNC';
const ACTIVATE = 'INTEGRATIONS.SATISPAY.ACTIVATE';
const LOAD = 'INTEGRATIONS.DOJO.LOAD';
const COPY = [
  { id: 'T1', name: 'Bar' },
  { id: 'T2', name: 'Cucina' },
];

afterEach(cleanUp);

const open = (options: Parameters<typeof renderPlace>[0] = {}) =>
  renderPlace({ path: 'integrations', lookupData: { providers: ON }, ...options });
type View = Awaited<ReturnType<typeof open>>;

function withTsh(copy: unknown, map: Record<string, string> = {}) {
  let block = withValue(storedBlock('integrations'), 'tsh.categories', copy);
  block = withValue(block, 'tsh.categoriesMap', map);
  return fakePlace({ integrations: block });
}

async function typeCode(view: View, code: string) {
  const input = view.root.querySelector<HTMLInputElement>('input[autocomplete="off"]')!;
  input.value = code;
  input.dispatchEvent(new Event('input'));
  await view.view();
}

const stateOf = (view: View, label: string) =>
  view.root
    .querySelector(`[role="group"][aria-label="${label}"] .credential-state`)
    ?.textContent?.trim();

/** Presses save and returns the integrations the page sent. */
async function savedIntegrations(view: View): Promise<Record<string, any>> {
  await view.click('COMMON.SAVE');
  const request = backend().expectOne(PLACE_URL);
  const body = request.request.body as { integrations: Record<string, any> };
  expect(request.request.headers.get('If-Match')).not.toBeNull();
  request.flush({ data: fakePlace() }, { headers: { ETag: '"v9"' } });
  await view.view();
  return body.integrations;
}

describe('the actions of the integrations tab', () => {
  describe('availability', () => {
    it('shows no action when no provider is configured on the platform', async () => {
      const view = await renderPlace({ path: 'integrations' });
      for (const text of [LOAD, ACTIVATE, SYNC]) {
        expect(view.button(text)).toBeUndefined();
      }
    });

    it('shows the actions of the configured providers', async () => {
      const view = await open();
      expect(view.button(LOAD)).toBeDefined();
      expect(view.button(ACTIVATE)).toBeDefined();
      expect(view.button(SYNC)).toBeDefined();
    });

    it('shows no action to a user who cannot update the place', async () => {
      const view = await open({ permissions: READ_ONLY });
      expect(view.button(LOAD)).toBeUndefined();
      expect(view.button(ACTIVATE)).toBeUndefined();
      expect(view.button(SYNC)).toBeUndefined();
    });

    it('shows Satispay to platform administrators and dealers only', async () => {
      expect((await open({ profile: { role: 'D' } })).button(ACTIVATE)).toBeDefined();
    });
  });

  it('shows Dojo to a store administrator but not Satispay', async () => {
    const view = await open({ profile: { role: 'PA' } });
    expect(view.button(LOAD)).toBeDefined();
    expect(view.button(ACTIVATE)).toBeUndefined();
  });

  it('waits for the unsaved changes of the tab to be saved', async () => {
    const view = await open();
    expect(view.button(LOAD)?.disabled).toBe(false);
    await view.toggle('PLACES.F.INTEGRATIONS.DOJO.STATUS', true);
    for (const text of [LOAD, ACTIVATE, SYNC]) {
      expect(view.button(text)?.disabled).toBe(true);
    }
    expect(view.text()).toContain('INTEGRATIONS.UNSAVED');
  });

  describe('Dojo', () => {
    it('lists the terminals of the saved account', async () => {
      const view = await open();
      await view.click(LOAD);
      backend()
        .expectOne(URL_OF('dojo/terminals'))
        .flush({ data: [{ id: 'abc', tid: 'T1', status: 'Active' }] });
      await view.view();
      expect(view.text()).toContain('abc');
      expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
    });
  });

  describe('Satispay', () => {
    it('sets the key, adopts the new version and keeps the form clean', async () => {
      const view = await open();
      expect(stateOf(view, KEY_ID)).toBe('PLACES.CREDENTIAL.NOT_SET');
      await typeCode(view, 'AB12CD');
      await view.click(ACTIVATE);
      const request = backend().expectOne(URL_OF('satispay/activation'));
      expect(request.request.headers.get('If-Match')).toBe(ETAG);
      request.flush({ data: { keyIdSet: true } }, { headers: { ETag: '"v2"' } });
      await view.view();
      expect(stateOf(view, KEY_ID)).toBe('PLACES.CREDENTIAL.SET');
      expect(view.toasts()).toContain('INTEGRATIONS.SATISPAY.DONE');
      expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
      // The next save carries the new version.
      await view.toggle('PLACES.F.INTEGRATIONS.DOJO.STATUS', true);
      await view.click('COMMON.SAVE');
      const save = backend().expectOne(PLACE_URL);
      expect(save.request.headers.get('If-Match')).toBe('"v2"');
      save.flush({ data: fakePlace() }, { headers: { ETag: '"v3"' } });
      await view.view();
    });

    it('reads the place again when the answer has no version', async () => {
      const view = await open();
      await typeCode(view, 'AB12CD');
      await view.click(ACTIVATE);
      backend().expectOne(URL_OF('satispay/activation')).flush({ data: { keyIdSet: true } });
      await view.view();
      expect(view.toasts()).toContain('INTEGRATIONS.SATISPAY.REREAD');
      backend()
        .expectOne(PLACE_URL)
        .flush(
          { data: fakePlace({ integrations: withValue(storedBlock('integrations'), 'satispay.keyIdSet', true) }) },
          { headers: { ETag: '"v5"' } },
        );
      await view.view();
      expect(stateOf(view, KEY_ID)).toBe('PLACES.CREDENTIAL.SET');
    });

    it('invites to read the place again when it changed meanwhile', async () => {
      const view = await open();
      await typeCode(view, 'AB12CD');
      await view.click(ACTIVATE);
      backend()
        .expectOne(URL_OF('satispay/activation'))
        .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
      await view.view();
      expect(view.text()).toContain('PLACES.CONFLICT');
      await view.click('PLACES.RELOAD');
      backend().expectOne(PLACE_URL).flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
      await view.view();
    });
  });

  describe('TS Hospitality', () => {
    it('adopts the copy and the version, and offers the copy for the mapping', async () => {
      const view = await open();
      expect(view.text()).toContain('INTEGRATIONS.TSH_MAP.NO_CATEGORIES');
      await view.click(SYNC);
      const request = backend().expectOne(URL_OF('tsh/charge-categories/sync'));
      expect(request.request.headers.get('If-Match')).toBe(ETAG);
      request.flush({ data: COPY }, { headers: { ETag: '"v2"' } });
      await view.view();
      expect(view.text()).not.toContain('INTEGRATIONS.TSH_MAP.NO_CATEGORIES');
      const options = [...view.control('Bevande').querySelectorAll('option')].map((o) => o.textContent?.trim());
      expect(options).toEqual(['INTEGRATIONS.TSH_MAP.NONE', 'Bar', 'Cucina']);
      expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
      await view.type('Bevande', 'T2');
      const sent = await savedIntegrations(view);
      expect(sent['tsh']['categoriesMap']).toEqual({ [CATEGORY_1]: 'T2' });
      expect(sent['tsh']['categories']).toBeUndefined();
    });

    it('reads the place again when the answer has no version', async () => {
      const view = await open();
      await view.click(SYNC);
      backend().expectOne(URL_OF('tsh/charge-categories/sync')).flush({ data: COPY });
      await view.view();
      expect(view.toasts()).toContain('INTEGRATIONS.TSH.REREAD');
      backend().expectOne(PLACE_URL).flush({ data: withTsh(COPY) }, { headers: { ETag: '"v5"' } });
      await view.view();
      expect(view.control('Bevande').querySelectorAll('option')).toHaveLength(3);
    });

    it('invites to read the place again when it changed meanwhile', async () => {
      const view = await open();
      await view.click(SYNC);
      backend()
        .expectOne(URL_OF('tsh/charge-categories/sync'))
        .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
      await view.view();
      expect(view.text()).toContain('PLACES.CONFLICT');
      expect(view.button('PLACES.RELOAD')).toBeDefined();
    });
  });

  describe('the map of the categories', () => {
    it('shows the stored choices and keeps the entries of categories it does not list', async () => {
      const view = await open({ place: withTsh(COPY, { [CATEGORY_1]: 'T1', other: 'T2' }) });
      expect((view.control('Bevande') as HTMLSelectElement).value).toBe('T1');
      expect((view.control('Dolci') as HTMLSelectElement).value).toBe('');
      await view.type('Dolci', 'T2');
      const sent = await savedIntegrations(view);
      expect(sent['tsh']['categoriesMap']).toEqual({ [CATEGORY_1]: 'T1', other: 'T2', [CATEGORY_2]: 'T2' });
    });

    it('removes the entry of a category set back to none, and is not changed by it', async () => {
      const view = await open({ place: withTsh(COPY, { [CATEGORY_1]: 'T1' }) });
      await view.type('Bevande', '');
      expect(view.button('COMMON.SAVE')?.disabled).toBe(false);
      await view.type('Bevande', 'T1');
      expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
      await view.type('Bevande', '');
      const sent = await savedIntegrations(view);
      expect(sent['tsh']['categoriesMap']).toEqual({});
    });

    it('still shows a stored value that is no longer in the copy', async () => {
      const view = await open({ place: withTsh(COPY, { [CATEGORY_1]: 'GONE' }) });
      const select = view.control('Bevande') as HTMLSelectElement;
      expect(select.value).toBe('GONE');
      expect(select.options[select.selectedIndex].textContent).toContain('INTEGRATIONS.TSH_MAP.UNKNOWN');
    });

    it('says the group has no product categories', async () => {
      const view = await open({
        place: withTsh(COPY),
        lookupData: { providers: ON, categories: { data: [], page: { limit: 100, next: null } } },
      });
      expect(view.text()).toContain('INTEGRATIONS.TSH_MAP.NO_PRODUCT_CATEGORIES');
    });

    it('is read only for a user who cannot update', async () => {
      const view = await open({ place: withTsh(COPY), permissions: READ_ONLY });
      expect((view.control('Bevande') as HTMLSelectElement).disabled).toBe(true);
    });
  });
});
