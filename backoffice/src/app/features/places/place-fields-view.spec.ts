import {
  CATEGORY_1,
  COMPANY,
  LIST_1,
  LIST_2,
  fakePlace,
  PLACE_URL,
  renderPlace,
} from '../../../testing/places';
import { backend } from '../../../testing/api';
import { cleanUp, isChecked, savePut, storedBlock, withValue } from '../../../testing/places-tabs';

const C = (key: string) => `PLACES.F.CASH_SETTINGS.${key}`;
const labelsOf = (select: HTMLElement) =>
  [...select.querySelectorAll('option')].map((o) => o.textContent?.trim());
const values = (select: HTMLElement) =>
  [...select.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
/** Whether the tab has a control with exactly this label. */
const has = (view: Awaited<ReturnType<typeof renderPlace>>, label: string) =>
  [...view.root.querySelectorAll('label')].some((l) => l.textContent?.trim() === label);
const RESERVED = 'PLACES.F.APPOINTMENTS.WEB_WIDGET_STATUS';
const CA = { role: 'CA', groupId: '665f1c2e9b1d4a0012ab34a1' } as const;

afterEach(cleanUp);

describe('PlaceFieldsView controls', () => {
  it('renders a switch, a text, a number and a time with the right input types', async () => {
    const view = await renderPlace({ path: 'settings/general', features: ['rooms', 'productsVariants'] });
    expect(view.control(C('FAST_LOGIN')).type).toBe('checkbox');
    expect(view.control(C('CUSTOM_DISCOUNT')).type).toBe('text');
    expect(view.control(C('CUSTOM_DISCOUNT')).getAttribute('inputmode')).toBeNull();
    const rounding = view.control(C('TOTAL_ROUNDING'));
    expect(rounding.type).toBe('number');
    expect(rounding.getAttribute('inputmode')).toBe('decimal');
    const whole = view.control(C('CHARGE_DOCUMENT_QT'));
    expect(whole.type).toBe('number');
    expect(whole.getAttribute('inputmode')).toBe('numeric');
    expect(whole.value).toBe('1');
    expect(view.control(C('OPERATING_TIME')).type).toBe('time');
    await view.blurAll();
  });

  it('keeps an emptied number as null and an emptied whole number as its default', async () => {
    const view = await renderPlace({ path: 'settings/general', features: ['rooms', 'productsVariants'] });
    await view.type(C('CHARGE_DOCUMENT_QT'), '');
    await view.type(C('TOTAL_ROUNDING'), '0.1');
    await view.type(C('TOTAL_ROUNDING'), '');
    await view.type(C('OPERATING_TIME'), '04:30');
    await view.type(C('CUSTOM_DISCOUNT'), 'x');
    await view.type(C('CUSTOM_DISCOUNT'), '');
    await savePut(view, 'settings/cash', {
      ...withValue(storedBlock('cashSettings'), 'operatingTime', '04:30'),
      workshiftNames: ['Pranzo', 'Cena'],
    });
  });

  it('shows a duration in minutes with a hint, a color as a color input and a time as a time input', async () => {
    const view = await renderPlace({ path: 'settings/reservations' });
    expect(view.control('PLACES.F.RESERVATIONS.STEP').getAttribute('inputmode')).toBe('decimal');
    expect(view.text()).toContain('PLACES.MINUTES_HINT');
    expect(view.control('PLACES.F.RESERVATIONS.WEB_WIDGET.COLOR').type).toBe('color');
    expect(view.control('PLACES.F.RESERVATIONS.UNTIL_HOURS').type).toBe('time');
  });

  it('keeps the stored value of a closed list that no longer has it', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      cashSettings: { ...stored.cashSettings, localWarehouseOutOfStock: 'legacy' },
    });
    const view = await renderPlace({ path: 'settings/general', place });
    const select = view.control(C('LOCAL_WAREHOUSE_OUT_OF_STOCK'));
    expect(select.value).toBe('legacy');
    expect(values(select)).toEqual(['disabled', 'enabled', 'alert', 'legacy']);
  });

  it('offers the empty choice only on a closed list that can be null', async () => {
    const view = await renderPlace({ path: 'settings/other' });
    expect(values(view.control(C('RECEIPTS_CANCELLATION')))).toEqual(['', 'sync', 'notSync']);
    await view.type(C('RECEIPTS_CANCELLATION'), 'notSync');
    await view.type(C('RECEIPTS_CANCELLATION'), '');
    expect(view.control(C('RECEIPTS_CANCELLATION')).value).toBe('');
  });

  it('offers no empty choice on a closed list that cannot be null', async () => {
    const view = await renderPlace({ path: 'settings/general' });
    expect(values(view.control(C('LOCAL_WAREHOUSE_OUT_OF_STOCK')))).toEqual([
      'disabled',
      'enabled',
      'alert',
    ]);
  });

  it('labels the empty choice with its own text when the key has one', async () => {
    const view = await renderPlace({ path: 'settings/fidelity' });
    expect(labelsOf(view.control('PLACES.F.FIDELITY.TYPE'))[0]).toBe('PLACES.NONE_OF.FIDELITY_TYPE');
  });

  it('shows a font size without the empty choice', async () => {
    const view = await renderPlace({ path: 'settings/print' });
    const select = view.control('PLACES.F.PRINTING.RECEIPT.SUBTOTAL_FONT_SIZE');
    expect(values(select)).toHaveLength(9);
    expect(values(select)[0]).toBe('1-1');
  });

  it('offers the enabled price lists and the categories of the group', async () => {
    const kiosk = await renderPlace({ path: 'settings/kiosk' });
    expect(labelsOf(kiosk.control('PLACES.F.KIOSK.LIST_ID'))).toEqual([
      'PLACES.NONE',
      'Listino 1',
      'Listino 2',
    ]);
    expect(values(kiosk.control('PLACES.F.KIOSK.LIST_ID'))).toEqual(['', LIST_1, LIST_2]);
    expect(labelsOf(kiosk.control('PLACES.F.KIOSK.UPSELLING_CATEGORY_ID'))).toEqual([
      'PLACES.NONE',
      'Bevande',
      'Dolci',
    ]);
  });

  it('offers the companies and the places of the group', async () => {
    const tobacco = await renderPlace({ path: 'settings/tobacco' });
    expect(labelsOf(tobacco.control('PLACES.F.TOBACCO.COMPANY_ID'))).toContain('Altra Azienda');
    expect(labelsOf(tobacco.control('PLACES.F.TOBACCO.PLACE_ID'))).toContain('Bar Milano');
  });

  it('keeps a stored price list, category and company the lookups do not have', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      kiosk: { ...stored.kiosk, listId: LIST_2, upsellingCategoryId: CATEGORY_1 },
      tobacco: { ...stored.tobacco, companyId: COMPANY },
    });
    const kiosk = await renderPlace({
      path: 'settings/kiosk',
      place,
      lookupData: {
        priceLists: { data: [] },
        categories: { data: [], page: { limit: 100, next: null } },
      },
    });
    expect(kiosk.control('PLACES.F.KIOSK.LIST_ID').value).toBe(LIST_2);
    expect(kiosk.control('PLACES.F.KIOSK.UPSELLING_CATEGORY_ID').value).toBe(CATEGORY_1);
  });

  it('renders the url keys of the media tab as url inputs and the others as text', async () => {
    const stored = fakePlace();
    const place = fakePlace({ media: { ...stored.media, logoLight: null } });
    const view = await renderPlace({ path: 'media', place });
    expect(view.control('PLACES.F.MEDIA.EXTERNAL_URL').type).toBe('url');
    expect(view.control('PLACES.F.MEDIA.EXTERNAL_URL_LOGO').type).toBe('url');
    expect(view.control('PLACES.F.MEDIA.INTERNAL_FILE_NAME').type).toBe('text');
    expect(view.control('PLACES.F.MEDIA.INTERNAL_FILE_NAME_LOGO').type).toBe('text');
  });

  it('renders a long text as a textarea', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    expect(view.control('PLACES.F.SELF_ORDERING.FIXED_MESSAGE').tagName).toBe('TEXTAREA');
    await view.type('PLACES.F.SELF_ORDERING.FIXED_MESSAGE', 'Ciao');
    expect(isChecked(view, 'PLACES.F.SELF_ORDERING.STATUS')).toBe(false);
    await view.blurAll();
  });
});

describe('PlaceFieldsView visibility', () => {
  const GATED = [
    'LOGS',
    'ADVANCED_REPORT_LOGS',
    'PRODUCT_VARIANTS_QUANTITY',
    'CHARGE_DOCUMENT',
    'CHARGE_DOCUMENT_QT',
    'LOCAL_WAREHOUSE',
    'SIMPLE_WAREHOUSE',
    'LOCAL_WAREHOUSE_OUT_OF_STOCK',
  ];

  it('hides the keys that need a module the group does not have from a company administrator', async () => {
    const view = await renderPlace({ path: 'settings/general', features: [], profile: CA });
    for (const key of GATED) {
      expect(has(view, C(key))).toBe(false);
    }
    expect(has(view, C('USERS_SHIFTS'))).toBe(true);
    expect(view.root.querySelector('fc-rows-editor')).not.toBeNull();
  });

  it('shows them with the modules', async () => {
    const view = await renderPlace({
      path: 'settings/general',
      features: ['rooms', 'productsVariants', 'warehouse'],
      profile: CA,
    });
    for (const key of GATED) {
      expect(has(view, C(key))).toBe(true);
    }
  });

  it('shows every key to a platform administrator even without the modules', async () => {
    const view = await renderPlace({ path: 'settings/general', features: [] });
    for (const key of GATED) {
      expect(has(view, C(key))).toBe(true);
    }
  });

  it('shows every key to a dealer even without the modules', async () => {
    const view = await renderPlace({
      path: 'settings/general',
      features: [],
      profile: { role: 'D' },
    });
    for (const key of GATED) {
      expect(has(view, C(key))).toBe(true);
    }
  });

  it('hides the printing keys of the rooms from a company administrator without the module', async () => {
    const hidden = await renderPlace({ path: 'settings/print', features: [], profile: CA });
    expect(has(hidden, 'PLACES.F.PRINTING.RECEIPT.SEATS_TOP')).toBe(false);
    expect(has(hidden, 'PLACES.F.PRINTING.RECEIPT.USER')).toBe(true);
  });

  it('titles the parts of the printing once, in order', async () => {
    const view = await renderPlace({ path: 'settings/print' });
    const parts = [...view.root.querySelectorAll('h3.part')].map((h) => h.textContent?.trim());
    expect(parts).toEqual(['PLACES.PART.PRINT_RECEIPT', 'PLACES.PART.PRINT_PREBILLING', 'PLACES.PART.PRINT_ORDERING']);
  });

  it('shows the groups of the other settings only', async () => {
    const view = await renderPlace({ path: 'settings/other' });
    const legends = [...view.root.querySelectorAll('fieldset > legend')].map((l) =>
      l.textContent?.trim(),
    );
    expect(legends).toEqual(['PLACES.G.CASH_SETTINGS.OTHER']);
    expect(labelsOf(view.control(C('RECEIPTS_CANCELLATION')))[0]).toBe(
      'PLACES.NONE_OF.RECEIPTS_CANCELLATION',
    );
  });

  it('shows a reserved key read-only with a note to whoever is not a platform administrator or dealer', async () => {
    const ca = await renderPlace({ path: 'settings/appointments', profile: CA });
    expect(ca.control(RESERVED).disabled).toBe(true);
    expect(ca.text()).toContain('PLACES.RESERVED_NOTE');
  });

  it('lets a platform administrator change a reserved key', async () => {
    const psa = await renderPlace({ path: 'settings/appointments' });
    expect(psa.control(RESERVED).disabled).toBe(false);
    expect(psa.text()).not.toContain('PLACES.RESERVED_NOTE');
  });

  it('shows only the groups asked for', async () => {
    const view = await renderPlace({ path: 'settings/reservations' });
    const legends = [...view.root.querySelectorAll('fieldset > legend')].map((l) =>
      l.textContent?.trim(),
    );
    const count = (legend: string) => legends.filter((text) => text === legend).length;
    expect(count('PLACES.G.RESERVATIONS.GENERAL')).toBe(1);
    expect(count('PLACES.G.RESERVATIONS.WEB_WIDGET')).toBe(1);
    expect(count('PLACES.G.RESERVATIONS.EMAIL_NOTIFICATION')).toBe(1);
    expect(legends.indexOf('PLACES.G.RESERVATIONS.GENERAL')).toBeLessThan(
      legends.indexOf('PLACES.RESERVATIONS.TIME_BLOCKS'),
    );
    expect(legends.indexOf('PLACES.RESERVATIONS.TIME_BLOCKS')).toBeLessThan(
      legends.indexOf('PLACES.G.RESERVATIONS.WEB_WIDGET'),
    );
  });
});

describe('PlaceFieldsView credentials', () => {
  const EASY = 'PLACES.F.INTEGRATIONS.EASYAPPEAR.APP_TOKEN';
  const STRIPE = 'PLACES.F.INTEGRATIONS.FLOOD_PAY.STRIPE.PRIVATE_KEY';
  const credential = (view: Awaited<ReturnType<typeof renderPlace>>, label: string) =>
    view.root.querySelector(`[role="group"][aria-label="${label}"]`) as HTMLElement;
  const press = async (
    view: Awaited<ReturnType<typeof renderPlace>>,
    label: string,
    text: string,
  ) => {
    const button = [...credential(view, label).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
    button.click();
    await view.view();
  };

  it('shows whether a credential is set, never its value', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      integrations: { ...stored.integrations, easyappear: { status: false, appTokenSet: true } },
    });
    const view = await renderPlace({ path: 'integrations', place });
    expect(credential(view, EASY).textContent).toContain('PLACES.CREDENTIAL.SET');
    expect(credential(view, STRIPE).textContent).toContain('PLACES.CREDENTIAL.NOT_SET');
    expect(view.root.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('sets, clears and keeps a credential, sending it only when typed or cleared', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      integrations: { ...stored.integrations, easyappear: { status: false, appTokenSet: true } },
    });
    const view = await renderPlace({ path: 'integrations', place });
    await press(view, EASY, 'PLACES.CREDENTIAL.CHANGE');
    await view.type('PLACES.CREDENTIAL.NEW_VALUE {"label":"' + EASY + '"}', 'tok-1');
    await press(view, EASY, 'COMMON.CANCEL');
    expect(view.root.querySelectorAll('input[type="password"]')).toHaveLength(0);
    await press(view, EASY, 'PLACES.CREDENTIAL.REMOVE');
    expect(credential(view, EASY).textContent).toContain('PLACES.CREDENTIAL.REMOVING');
    await press(view, EASY, 'PLACES.CREDENTIAL.KEEP');
    expect(credential(view, EASY).textContent).toContain('PLACES.CREDENTIAL.SET');
    await press(view, STRIPE, 'PLACES.CREDENTIAL.SET_NEW');
    await view.type('PLACES.CREDENTIAL.NEW_VALUE {"label":"' + STRIPE + '"}', 'sk_test_x');
    await press(view, EASY, 'PLACES.CREDENTIAL.REMOVE');
    await view.click('COMMON.SAVE');
    const request = backend().expectOne(PLACE_URL);
    const body = (request.request.body as { integrations: Record<string, any> }).integrations;
    expect(body['easyappear']).toEqual({ status: false, appToken: null });
    expect(body['floodPay'].stripe.privateKey).toBe('sk_test_x');
    expect(body['floodPay'].stripe).not.toHaveProperty('webhookPrivateKey');
    request.flush({ data: place }, { headers: { ETag: '"v2"' } });
    await view.view();
  });

  it('locks the payment credentials for who is not a platform administrator or dealer', async () => {
    const view = await renderPlace({ path: 'integrations', profile: CA });
    expect(credential(view, STRIPE).querySelectorAll('button')).toHaveLength(0);
    expect(credential(view, EASY).querySelectorAll('button').length).toBeGreaterThan(0);
  });
});
