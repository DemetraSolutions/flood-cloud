import {
  CATEGORY_1,
  COMPANY,
  LIST_1,
  LIST_2,
  fakePlace,
  renderPlace,
} from '../../../testing/places';
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
    const view = await renderPlace({ path: 'cash', features: ['rooms', 'productsVariants'] });
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
    const view = await renderPlace({ path: 'cash', features: ['rooms', 'productsVariants'] });
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
    const view = await renderPlace({ path: 'reservations' });
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
    const view = await renderPlace({ path: 'cash', place });
    const select = view.control(C('LOCAL_WAREHOUSE_OUT_OF_STOCK'));
    expect(select.value).toBe('legacy');
    expect(values(select)).toEqual(['disabled', 'enabled', 'alert', 'legacy']);
  });

  it('offers the empty choice only on a closed list that can be null', async () => {
    const view = await renderPlace({ path: 'cash' });
    expect(values(view.control(C('RECEIPTS_CANCELLATION')))).toEqual(['', 'sync', 'notSync']);
    expect(labelsOf(view.control(C('RECEIPTS_CANCELLATION')))[0]).toBe('PLACES.NONE');
    expect(values(view.control(C('LOCAL_WAREHOUSE_OUT_OF_STOCK')))).toEqual([
      'disabled',
      'enabled',
      'alert',
    ]);
    await view.type(C('RECEIPTS_CANCELLATION'), 'notSync');
    await view.type(C('RECEIPTS_CANCELLATION'), '');
    expect(view.control(C('RECEIPTS_CANCELLATION')).value).toBe('');
  });

  it('shows a font size without the empty choice', async () => {
    const view = await renderPlace({ path: 'printing' });
    const select = view.control('PLACES.F.PRINTING.RECEIPT.SUBTOTAL_FONT_SIZE');
    expect(values(select)).toHaveLength(9);
    expect(values(select)[0]).toBe('1-1');
  });

  it('offers the enabled price lists and the categories of the group', async () => {
    const kiosk = await renderPlace({ path: 'kiosk' });
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
    const tobacco = await renderPlace({ path: 'tobacco' });
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
      path: 'kiosk',
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
    const view = await renderPlace({ path: 'self-ordering' });
    expect(view.control('PLACES.F.SELF_ORDERING.FIXED_MESSAGE').tagName).toBe('TEXTAREA');
    await view.type('PLACES.F.SELF_ORDERING.FIXED_MESSAGE', 'Ciao');
    expect(isChecked(view, 'PLACES.F.SELF_ORDERING.STATUS')).toBe(false);
    await view.blurAll();
  });
});

describe('PlaceFieldsView visibility', () => {
  it('hides the keys of the groups without the module they need', async () => {
    const view = await renderPlace({ path: 'cash', features: [] });
    for (const key of [
      'LOGS',
      'WORKSHIFT',
      'PRODUCT_VARIANTS_QUANTITY',
      'CHARGE_DOCUMENT',
      'CHARGE_DOCUMENT_QT',
    ]) {
      expect(has(view, C(key))).toBe(false);
    }
    expect(view.text()).not.toContain('PLACES.G.CASH_SETTINGS.REPORT');
    expect(has(view, C('USERS_SHIFTS'))).toBe(true);
    expect(view.root.querySelector('fc-rows-editor')).toBeNull();
  });

  it('shows them with the modules', async () => {
    const view = await renderPlace({ path: 'cash', features: ['rooms', 'productsVariants'] });
    for (const key of [
      'LOGS',
      'WORKSHIFT',
      'PRODUCT_VARIANTS_QUANTITY',
      'CHARGE_DOCUMENT',
      'CHARGE_DOCUMENT_QT',
      'ADVANCED_REPORT_LOGS',
    ]) {
      expect(has(view, C(key))).toBe(true);
    }
  });

  it('shows the warehouse keys to a platform administrator even without the module', async () => {
    const view = await renderPlace({ path: 'cash', features: [] });
    expect(has(view, C('LOCAL_WAREHOUSE'))).toBe(true);
    expect(has(view, C('SIMPLE_WAREHOUSE'))).toBe(true);
  });

  it('shows the warehouse keys to a dealer even without the module', async () => {
    const view = await renderPlace({ path: 'cash', features: [], profile: { role: 'D' } });
    expect(has(view, C('LOCAL_WAREHOUSE'))).toBe(true);
  });

  it('hides the warehouse keys from a company administrator without the module', async () => {
    const view = await renderPlace({ path: 'cash', features: [], profile: CA });
    expect(has(view, C('LOCAL_WAREHOUSE'))).toBe(false);
    expect(has(view, C('SIMPLE_WAREHOUSE'))).toBe(false);
    expect(view.text()).toContain('PLACES.G.CASH_SETTINGS.WAREHOUSE');
  });

  it('shows the warehouse keys to a company administrator with the module', async () => {
    const view = await renderPlace({ path: 'cash', features: ['warehouse'], profile: CA });
    expect(has(view, C('LOCAL_WAREHOUSE'))).toBe(true);
  });

  it('hides a whole group when none of its keys is visible', async () => {
    const view = await renderPlace({ path: 'printing', features: [] });
    expect(view.text()).toContain('PLACES.G.PRINTING.RECEIPT_OPTIONS');
    for (const group of [
      'PREBILLING_OPTIONS',
      'PREBILLING_TEXTS',
      'PREBILLING_FONTS',
      'ORDERING_GENERAL',
      'ORDERING_FONTS',
      'ORDERING_TEXTS',
      'ORDERING_OPTIONS',
    ]) {
      expect(view.text()).not.toContain(`PLACES.G.PRINTING.${group}`);
    }
  });

  it('shows a reserved key read-only with a note to whoever is not a platform administrator or dealer', async () => {
    const ca = await renderPlace({ path: 'appointments', profile: CA });
    expect(ca.control(RESERVED).disabled).toBe(true);
    expect(ca.text()).toContain('PLACES.RESERVED_NOTE');
  });

  it('lets a platform administrator change a reserved key', async () => {
    const psa = await renderPlace({ path: 'appointments' });
    expect(psa.control(RESERVED).disabled).toBe(false);
    expect(psa.text()).not.toContain('PLACES.RESERVED_NOTE');
  });

  it('shows only the groups asked for', async () => {
    const view = await renderPlace({ path: 'reservations' });
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
