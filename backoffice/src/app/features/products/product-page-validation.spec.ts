import { backend } from '../../../testing/api';
import { BASE, EDIT, ITEM, L, NEW, P1, PROD1, PROD2, SUPPLIER, descriptionLabel, nameLabel, renderProduct, shortNameLabel } from '../../../testing/product-page';
import {
  BarcodeRow,
  ComponentRow,
  CoreModel,
  LocalModel,
  MenuRow,
  ProductPlaceRow,
  StockRow,
  SupplierRow,
} from './product-model';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

type View = Awaited<ReturnType<typeof renderProduct>>;
type Core = Partial<CoreModel>;

const barcode = (value: string): BarcodeRow => ({ value, loadQuantity: '', saleQuantity: '1' });
const component = (productId: string, quantity = '1'): ComponentRow => ({ productId, quantity, waste: '' });
const supplier = (contactId: string, extra: Partial<SupplierRow> = {}): SupplierRow => ({
  contactId,
  code: '',
  name: '',
  minQuantity: '',
  deliveryTime: '',
  deliveryTimeUnit: '',
  favorite: false,
  priceLists: [],
  ...extra,
});

/** Renders a product with a change in its model and tries to save it. */
async function tryToSave(core: Core | ((model: CoreModel) => Core), local: Partial<LocalModel> = {}, url = EDIT, profile = {}) {
  const view = await renderProduct(url, { profile });
  await view.setCore(typeof core === 'function' ? core(view.model().core) : core);
  if (Object.keys(local).length > 0) {
    await view.setLocal(local);
  }
  await view.submit();
  return view;
}

const count = (view: View, tab: string, errors: number) => {
  const text = view.tab(tab)!.textContent ?? '';
  if (errors === 0) {
    expect(text, tab).not.toContain('TAB_LIST.ERRORS');
  } else {
    expect(text, tab).toContain(`TAB_LIST.ERRORS {"count":${errors}}`);
  }
};

describe('ProductPage: what is checked before a save', () => {
  it.each<[string, (model: CoreModel) => Core, string, number]>([
    ['a position that is not a number', () => ({ position: 'abc' }), 'general', 1],
    ['a negative production value', () => ({ productionValue: '-1' }), 'general', 1],
    ['a number of concurrent services that is not whole', () => ({ maxConcurrent: '1.5' }), 'general', 1],
    ['a conversion ratio of zero', () => ({ conversionRatio: '0' }), 'general', 1],
    ['a service fee above 100', (m) => ({ dining: { ...m.dining, feePercentage: '101' } }), 'general', 1],
    ['a modifier surcharge above 1000 and a discount above 100', (m) => ({ modifier: { ...m.modifier, pricePercentagePlus: '1001', pricePercentageMinus: '101' } }), 'general', 2],
    ['a code that is too long', () => ({ code: 'x'.repeat(65) }), 'general', 1],
    ['a code with a control character', () => ({ code: 'a\u0001b' }), 'general', 1],
    ['a PLU with a leading zero', () => ({ plu: '012' }), 'general', 1],
    ['a start that is not a date', () => ({ validFrom: 'ieri' }), 'general', 1],
    ['an end that is not a date', () => ({ validTo: 'domani' }), 'general', 1],
    ['an end before the start', () => ({ validFrom: '2026-12-02T10:00', validTo: '2026-12-01T10:00' }), 'general', 1],
    ['an internal file name that is too long', () => ({ internalFileName: 'x'.repeat(256) }), 'media', 1],
    ['a link that is not https', () => ({ externalUrl: 'http://example.com' }), 'media', 1],
    ['a cost that is negative', () => ({ simpleCost: '-1' }), 'margin', 1],
    ['a measure that is not a number', (m) => ({ shipping: { ...m.shipping, width: 'a', height: 'b', depth: 'c', weight: 'd' } }), 'shipping', 4],
    ['a barcode without a value', () => ({ barcodes: [barcode('')] }), 'barcodes', 1],
    ['a barcode that is too long', () => ({ barcodes: [barcode('9'.repeat(65))] }), 'barcodes', 1],
    ['a barcode with a control character', () => ({ barcodes: [barcode('9\u0001')] }), 'barcodes', 1],
    ['a barcode with a quantity that is not a number', () => ({ barcodes: [{ ...barcode('1'), saleQuantity: 'x', loadQuantity: 'y' }] }), 'barcodes', 1],
    ['a barcode that is repeated', () => ({ barcodes: [barcode('1'), barcode('2'), barcode(' 1 ')] }), 'barcodes', 1],
    ['too many barcodes', () => ({ barcodes: Array.from({ length: 101 }, (_, index) => barcode(String(index + 1))) }), 'barcodes', 1],
    ['a price without a list', (m) => ({ prices: [{ ...m.prices[0], priceListId: '' }] }), 'prices', 1],
    ['a price that is not a number', (m) => ({ prices: [{ ...m.prices[0], net: 'x', gross: '' }] }), 'prices', 1],
    ['too many price rules', (m) => ({ prices: Array.from({ length: 51 }, () => m.prices[0]) }), 'prices', 1],
    ['a component without a product', () => ({ components: [component('')] }), 'composition', 1],
    ['a component with a quantity of zero', () => ({ components: [component(PROD1, '0')] }), 'composition', 1],
    ['a component that is repeated', () => ({ components: [component(PROD1), component(PROD2), component(PROD1)] }), 'composition', 1],
    ['a menu group without a category', () => ({ menu: [{ categoryId: '', quantity: '1', course: '', productIds: [] } satisfies MenuRow] }), 'composition', 1],
    ['a group of choices without a category', () => ({ modifierChoices: [{ categoryId: '', freeQuantity: '1', priceRule: 'highest', productIds: [] }] }), 'composition', 1],
    ['a supplier that is not a contact', () => ({ suppliers: [supplier('x')] }), 'suppliers', 1],
    ['a supplier without a contact', () => ({ suppliers: [supplier('')] }), 'suppliers', 1],
    ['a supplier that is too long a name', () => ({ suppliers: [supplier(SUPPLIER, { name: 'n'.repeat(151), code: 'c'.repeat(65), minQuantity: 'a' })] }), 'suppliers', 1],
    ['a supplier that is repeated', () => ({ suppliers: [supplier(SUPPLIER), supplier(SUPPLIER)] }), 'suppliers', 1],
    ['a price list of a supplier with a discount above 100', () => ({ suppliers: [supplier(SUPPLIER, { priceLists: [{ id: 'l', price: '1', discount1: '101', discount2: '', discount3: '' }] })] }), 'suppliers', 1],
  ])('does not send %s, counts it in its tab and opens the tab', async (_name, core, tab, errors) => {
    const view = await tryToSave(core);
    expect(backend().match(ITEM)).toHaveLength(0);
    count(view, tab, errors);
    expect(view.visible()).toEqual([tab]);
    expect(view.formError()).toBeNull();
  });

  it('accepts the limits of the numbers, the dates in order, an https link and a repeated barcode only once', async () => {
    const view = await tryToSave({
      position: '1000000',
      productionValue: '0',
      conversionRatio: '0.000001',
      plu: '0',
      validFrom: '2026-12-01T10:00',
      validTo: '2026-12-01T10:00',
      externalUrl: 'https://example.com/a',
      barcodes: [barcode('1'), barcode('2'), barcode('')].slice(0, 2),
    });
    expect(backend().expectOne(ITEM).request.method).toBe('PATCH');
    expect(view.formError()).toBeNull();
  });

  it('shows the error of a field once the user leaves it, and the message under it', async () => {
    const view = await renderProduct(EDIT);
    await view.type(L.position, 'abc');
    expect(view.error(L.position)).toBe('');
    await view.blur(L.position);
    expect(view.error(L.position)).toBe('FORM.ISSUE.TYPE');
    count(view, 'general', 1);
    await view.type(L.position, '5');
    expect(view.error(L.position)).toBe('');
    count(view, 'general', 0);
    await view.type(L.code, 'x'.repeat(65));
    await view.blur(L.code);
    expect(view.error(L.code)).toBe('FORM.ISSUE.MAX_LENGTH');
    await view.type(L.plu, '01');
    await view.blur(L.plu);
    expect(view.error(L.plu)).toBe('FORM.ISSUE.FORMAT');
  });

  it('moves the focus to the first field with an error', async () => {
    const view = await tryToSave({ code: 'x'.repeat(65) });
    expect(document.activeElement).toBe(view.control(L.code));
  });

  it('opens the first tab with an error and counts the errors of each', async () => {
    const view = await tryToSave((m) => ({ position: 'a', shipping: { ...m.shipping, width: 'a' }, barcodes: [barcode('')] }));
    expect(view.visible()).toEqual(['general']);
    count(view, 'general', 1);
    count(view, 'barcodes', 1);
    count(view, 'shipping', 1);
    count(view, 'prices', 0);
    await view.type(L.position, '1');
    expect(view.tab('general')!.textContent).not.toContain('TAB_LIST.ERRORS');
  });

  it('opens the tab with the error from another tab', async () => {
    const view = await renderProduct(EDIT);
    await view.setCore({ simpleCost: '-5' });
    await view.openTab('shipping');
    await view.submit();
    expect(view.visible()).toEqual(['margin']);
    expect(view.error(L.cost)).toBe('FORM.ISSUE.MINIMUM');
  });

  it('switches to the full view when the first error is in a tab the quick view does not have', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`);
    await view.setCore({ simpleCost: '-5' });
    await view.submit();
    expect(view.tabs()).toHaveLength(14);
    expect(view.visible()).toEqual(['margin']);
  });

  it('keeps the quick view when the error is in a tab it has', async () => {
    const view = await renderProduct(`${EDIT}?view=quick`);
    await view.setCore({ position: 'abc' });
    await view.submit();
    expect(view.tabs()).toHaveLength(5);
    expect(view.visible()).toEqual(['general']);
    count(view, 'general', 1);
  });
});

describe('ProductPage: the texts', () => {
  it('asks for the name in the language required, says so on the tab and opens it', async () => {
    const view = await renderProduct(NEW);
    await view.openTab('shipping');
    await view.type(nameLabel('en'), 'Only english');
    await view.submit();
    expect(view.error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(view.error(nameLabel('en'))).toBe('');
    count(view, 'general', 1);
    expect(view.visible()).toEqual(['general']);
    expect((document.activeElement as HTMLElement).tagName).toBe('INPUT');
  });

  it('asks for the name of a product that had it in the language required', async () => {
    const view = await renderProduct(EDIT);
    await view.type(nameLabel('it'), '   ');
    await view.submit();
    expect(view.error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(backend().match(ITEM)).toHaveLength(0);
  });

  it('does not ask for the name in the required language of a product that never had it', async () => {
    const view = await renderProduct(EDIT, { reads: { item: { name: { en: 'Coffee' } } } });
    await view.type(L.code, 'C2');
    await view.submit();
    expect(backend().expectOne(ITEM).request.body).toEqual({ code: 'C2' });
  });

  it('checks the length and the characters of the names and the descriptions', async () => {
    const view = await renderProduct(NEW);
    await view.type(nameLabel('it'), 'x'.repeat(151));
    await view.type(descriptionLabel('it'), 'y'.repeat(1001));
    await view.submit();
    expect(view.error(nameLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.error(descriptionLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    count(view, 'general', 2);
    await view.type(nameLabel('it'), 'a\u0001b');
    expect(view.error(nameLabel('it'))).toBe('FORM.ISSUE.PATTERN');
    await view.type(nameLabel('it'), 'Nome');
    await view.type(descriptionLabel('it'), 'a\u0001b');
    expect(view.error(descriptionLabel('it'))).toBe('FORM.ISSUE.PATTERN');
  });

  it('checks the short name: not longer than the server accepts, one line', async () => {
    const view = await renderProduct(NEW);
    await view.type(nameLabel('it'), 'A');
    await view.type(shortNameLabel('it'), 'x'.repeat(19));
    await view.submit();
    expect(view.error(shortNameLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    count(view, 'general', 1);
    await view.type(shortNameLabel('it'), 'a\u0001b');
    expect(view.error(shortNameLabel('it'))).toBe('FORM.ISSUE.PATTERN');
    await view.type(shortNameLabel('it'), 'x'.repeat(18));
    expect(view.error(shortNameLabel('it'))).toBe('');
    await view.type(shortNameLabel('en'), '   ');
    expect(view.error(shortNameLabel('en'))).toBe('');
  });
});

describe('ProductPage: the stores and the stock', () => {
  const row = (extra: Partial<ProductPlaceRow>): ProductPlaceRow => ({
    placeId: P1,
    favorite: false,
    favoriteHandheld: false,
    position: '',
    productionCenterId: '',
    ...extra,
  });
  const stock = (extra: Partial<StockRow>): StockRow => ({ placeId: P1, storageId: 'sg1', min: '', max: '', location: '', ...extra });

  it('does not send a position of a store that is not a number', async () => {
    const view = await tryToSave({}, { places: [row({ position: 'abc' })] });
    expect(backend().match(ITEM)).toHaveLength(0);
    count(view, 'availability', 1);
    expect(view.visible()).toEqual(['availability']);
  });

  it('asks a company administrator for at least one store, and says so on the tab', async () => {
    const view = await tryToSave((m) => ({ name: { ...m.name, it: 'Nome' } }), { places: [] }, NEW, { role: 'CA' });
    expect(backend().match(BASE)).toHaveLength(0);
    count(view, 'availability', 1);
    expect(view.visible()).toEqual(['availability']);
    expect(view.el().querySelector('#product-panel-availability .problem')?.textContent).toContain('FORM.ISSUE.REQUIRED');
  });

  it('does not ask a platform administrator for a store: the product is for every store', async () => {
    const view = await renderProduct(NEW, { profile: { role: 'PSA' } });
    expect(view.form().local.places().valid()).toBe(true);
  });

  it('checks the limits of the stock', async () => {
    const view = await tryToSave({}, { stock: [stock({ min: 'abc' }), stock({ storageId: 'sg2', location: 'x'.repeat(65) })] });
    expect(backend().match(ITEM)).toHaveLength(0);
    count(view, 'stock', 1);
    expect(view.visible()).toEqual(['stock']);
  });
});
