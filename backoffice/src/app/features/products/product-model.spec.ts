import { LogoModel } from '../companies/company-model';
import { toLocalInput } from '../groups/catalogs/catalog-fields';
import { CatalogImage } from '../product-catalog/product-catalog.types';
import {
  anyIssue,
  barcodeIssues,
  BodyContext,
  choiceIssues,
  codeIssue,
  componentIssues,
  createBody,
  DEFAULT_BUTTON_COLOR,
  fileNameIssue,
  menuIssues,
  ModelDefaults,
  modelChanged,
  patchBody,
  placeIssues,
  placeRowOf,
  pluIssue,
  ProductModel,
  shortNameIssue,
  stockIssues,
  supplierIssues,
  supplierListIssues,
  toModel,
  urlIssue,
} from './product-model';
import { newPriceRow } from './product-prices';
import { Product, ProductFeatures, PRODUCT_FEATURES } from './product.types';

const LANGUAGES = ['it', 'en'];
const CONTACT = '665f1c2e9b1d4a0012ab34c1';

const IMAGE: CatalogImage = {
  _id: 'img1',
  basename: 'logo',
  extension: 'png',
  filename: 'logo.png',
  mimetype: 'image/png',
  title: 'Logo',
  alt: 'alt',
  dirname: '/d',
  type: 'image',
  filectime: 5,
};

const DEFAULTS: ModelDefaults = {
  type: 'tobaccos',
  prices: [newPriceRow('pl1', 'EUR', 't1', 22)],
  places: [{ placeId: 'p9', favorite: false, favoriteHandheld: true, position: '', productionCenterId: '' }],
};

function features(on: readonly (keyof ProductFeatures)[] = []): ProductFeatures {
  return Object.fromEntries(PRODUCT_FEATURES.map((name) => [name, on.includes(name)])) as unknown as ProductFeatures;
}

const ALL = features(PRODUCT_FEATURES);
const NONE = features();
const plain = (f: ProductFeatures = ALL): BodyContext => ({ features: f, modifier: false });
const modifier = (f: ProductFeatures = ALL): BodyContext => ({ features: f, modifier: true });

/** A product with every field filled. */
const FULL: Product = {
  id: 'p1',
  family: 'products',
  type: 'exempt',
  isModifier: false,
  enabled: false,
  code: 'C1',
  plu: '12',
  name: { it: 'Acqua' },
  shortName: { it: 'Ac' },
  description: { en: 'Water' },
  shortDescription: {},
  favorite: true,
  favoriteHandheld: true,
  generic: true,
  toCheck: true,
  noDiscount: true,
  brandId: 'b1',
  categoryIds: ['k1', 'k2'],
  attributeIds: ['a1'],
  position: 3,
  productionValue: 2,
  duration: '01:30',
  maxConcurrent: 4,
  availability: { pos: true, warehouse: true, scales: true, ecommerce: true },
  featured: true,
  integrations: { floodOrders: true, yellgo: true, leggimenu: true },
  validFrom: '2026-03-04T10:20:00.000Z',
  validTo: '2026-03-05T10:20:00.000Z',
  modifier: { type: 'add', pricePercentagePlus: 10, pricePercentageMinus: 5, description: { it: 'più' } },
  requiredModifierIds: ['m1'],
  modifierIds: ['m2'],
  excludedModifierIds: ['m3'],
  modifierCategoryIds: ['mc1'],
  scaleType: 'piece',
  loadUnit: 'kg',
  unloadUnit: 'g',
  conversionRatio: 2,
  colors: { text: '#111111', background: '#222222' },
  dining: { halfPortion: true, feePercentage: 7, hiddenOnHandheld: true, affiliatedMenu: true, reversePrint: true },
  barcodes: [{ value: '123', loadQuantity: 2, saleQuantity: 1 }],
  prices: [
    {
      id: 'r1',
      priceListId: 'pl1',
      currency: 'EUR',
      taxId: 't1',
      tax: null,
      net: 10,
      gross: 12.2,
      discount: 5,
      validFrom: null,
      validTo: null,
      dailyFrom: null,
      dailyTo: null,
      weekDays: [],
      fromQuantity: 1,
      maxSaleQuantity: null,
    },
  ],
  places: [
    { placeId: 'p1', favorite: true, favoriteHandheld: false, position: 2, productionCenterId: 'pc1' },
    { placeId: 'p2', favorite: false, favoriteHandheld: true, position: null, productionCenterId: null },
  ],
  printStations: { p1: ['s1', 's2'], p2: [] },
  counterPrintStations: { p1: ['s3'] },
  stock: {
    p1: {
      st1: { quantity: 5, min: 1, max: 10, location: 'A1' },
      st2: { quantity: null, min: null, max: null, location: null },
    },
  },
  costs: { last: 1, average: 1, weightedAverage: 1, lastSupplierId: null, bySupplier: {} },
  simpleCost: 1.5,
  suppliers: [
    {
      contactId: CONTACT,
      code: 'S1',
      name: 'Fornitore',
      minQuantity: 2,
      deliveryTime: 3,
      deliveryTimeUnit: 'days',
      favorite: true,
      priceLists: [{ id: 'l1', price: 1, discount1: 2, discount2: 3, discount3: 4 }],
    },
  ],
  shipping: { width: 1, height: 2, depth: 3, weight: 4 },
  components: [{ productId: 'c1', quantity: 2, waste: 5 }],
  menu: [{ categoryId: 'k1', quantity: 1, course: 2, productIds: ['a', 'b'] }],
  modifierChoices: [{ categoryId: 'k1', freeQuantity: 1, priceRule: 'lowest', productIds: ['a'] }],
  modularPriceRule: 'sum',
  image: IMAGE,
  gallery: [IMAGE, null as unknown as CatalogImage],
  internalFileName: 'a.pdf',
  externalUrl: 'https://example.com/x',
  editable: true,
  placeEditable: true,
  trashed: false,
  trashedAt: null,
  createdAt: null,
  updatedAt: null,
};

/** A product with only what the server always sends. */
const SPARSE: Product = {
  id: 'p2',
  family: 'products',
  type: null,
  isModifier: false,
  enabled: true,
  code: null,
  name: {},
  shortName: {},
  description: {},
  shortDescription: {},
  favorite: false,
  generic: false,
  toCheck: false,
  noDiscount: false,
  brandId: null,
  categoryIds: [],
  attributeIds: [],
  position: null,
  productionValue: null,
  integrations: { floodOrders: false, yellgo: false, leggimenu: false },
  validFrom: null,
  validTo: null,
  barcodes: [{ value: '9', saleQuantity: null }],
  prices: [],
  places: [],
  simpleCost: null,
  suppliers: [
    {
      contactId: null,
      code: null,
      name: null,
      minQuantity: null,
      deliveryTime: null,
      deliveryTimeUnit: null,
      favorite: false,
      priceLists: [{ id: null, price: null, discount1: null, discount2: null, discount3: null }],
    },
  ],
  shipping: { width: null, height: null, depth: null, weight: null },
  components: [{ productId: 'c1', quantity: null, waste: null }],
  menu: [{ categoryId: null, quantity: null, productIds: [] }],
  modifierChoices: [{ categoryId: null, freeQuantity: null, priceRule: null, productIds: [] }],
  modifier: { type: null, pricePercentagePlus: null, pricePercentageMinus: null, description: {} },
  editable: true,
  placeEditable: false,
  trashed: false,
  trashedAt: null,
  createdAt: null,
  updatedAt: null,
};

const fullModel = () => toModel(FULL, LANGUAGES, DEFAULTS);
const sparseModel = () => toModel(SPARSE, LANGUAGES, DEFAULTS);
const logo = (imageId: string | null): LogoModel => ({ descriptor: null, imageId, label: 'x', previewUrl: null });

type Draft<T> = { -readonly [K in keyof T]: Draft<T[K]> };

/** The model of a product with some fields changed (a deep copy, so that the original stays as it is). */
function edited(change: (model: Draft<ProductModel>) => void, from: ProductModel = fullModel()): ProductModel {
  const copy = structuredClone(from);
  change(copy as Draft<ProductModel>);
  return copy;
}

describe('toModel of a new product', () => {
  const model = toModel(null, LANGUAGES, DEFAULTS);

  it('starts with the defaults', () => {
    expect(model.core.type).toBe('tobaccos');
    expect(model.core).toMatchObject({
      enabled: true,
      favorite: false,
      generic: false,
      toCheck: false,
      noDiscount: false,
      featured: false,
      availability: { pos: true, warehouse: false, scales: false, ecommerce: false },
      integrations: { floodOrders: false, yellgo: false, leggimenu: false },
      code: '',
      plu: '',
      brandId: '',
      position: '',
      productionValue: '',
      duration: '',
      maxConcurrent: '',
      validFrom: '',
      validTo: '',
      loadUnit: '',
      unloadUnit: '',
      conversionRatio: '1',
      scaleType: 'weight',
      colors: { text: DEFAULT_BUTTON_COLOR, background: DEFAULT_BUTTON_COLOR },
      barcodes: [],
      categoryIds: [],
      attributeIds: [],
      components: [],
      menu: [],
      modifierChoices: [],
      modularPriceRule: '',
      image: null,
      gallery: [],
      internalFileName: '',
      externalUrl: '',
      simpleCost: '',
      suppliers: [],
      shipping: { width: '', height: '', depth: '', weight: '' },
      modifier: { type: 'addRemove', pricePercentagePlus: '', pricePercentageMinus: '', description: { it: '', en: '' } },
      dining: { halfPortion: false, feePercentage: '', hiddenOnHandheld: false, affiliatedMenu: false, reversePrint: false },
    });
    expect(model.core.name).toEqual({ it: '', en: '' });
    expect(model.core.shortName).toEqual({ it: '', en: '' });
  });

  it('copies the prices and the stores of the defaults', () => {
    expect(model.core.prices).toEqual(DEFAULTS.prices);
    expect(model.core.prices).not.toBe(DEFAULTS.prices);
    expect(model.local.places).toEqual(DEFAULTS.places);
    expect(model.local.places).not.toBe(DEFAULTS.places);
    expect(model.local.stations).toEqual({ rooms: {}, counter: {} });
    expect(model.local.stock).toEqual([]);
  });
});

describe('toModel of a stored product', () => {
  it('turns every field into the text the form edits', () => {
    const { core, local } = fullModel();
    expect(core).toMatchObject({
      type: 'exempt',
      enabled: false,
      favorite: true,
      favoriteHandheld: true,
      generic: true,
      toCheck: true,
      noDiscount: true,
      featured: true,
      availability: { pos: true, warehouse: true, scales: true, ecommerce: true },
      integrations: { floodOrders: true, yellgo: true, leggimenu: true },
      code: 'C1',
      plu: '12',
      name: { it: 'Acqua', en: '' },
      shortName: { it: 'Ac', en: '' },
      description: { it: '', en: 'Water' },
      shortDescription: { it: '', en: '' },
      brandId: 'b1',
      position: '3',
      productionValue: '2',
      duration: '01:30',
      maxConcurrent: '4',
      validFrom: toLocalInput('2026-03-04T10:20:00.000Z'),
      validTo: toLocalInput('2026-03-05T10:20:00.000Z'),
      modifier: { type: 'add', pricePercentagePlus: '10', pricePercentageMinus: '5', description: { it: 'più', en: '' } },
      loadUnit: 'kg',
      unloadUnit: 'g',
      conversionRatio: '2',
      scaleType: 'piece',
      colors: { text: '#111111', background: '#222222' },
      dining: { halfPortion: true, feePercentage: '7', hiddenOnHandheld: true, affiliatedMenu: true, reversePrint: true },
      barcodes: [{ value: '123', loadQuantity: '2', saleQuantity: '1' }],
      categoryIds: ['k1', 'k2'],
      attributeIds: ['a1'],
      requiredModifierIds: ['m1'],
      modifierIds: ['m2'],
      excludedModifierIds: ['m3'],
      modifierCategoryIds: ['mc1'],
      components: [{ productId: 'c1', quantity: '2', waste: '5' }],
      menu: [{ categoryId: 'k1', quantity: '1', course: '2', productIds: ['a', 'b'] }],
      modifierChoices: [{ categoryId: 'k1', freeQuantity: '1', priceRule: 'lowest', productIds: ['a'] }],
      modularPriceRule: 'sum',
      internalFileName: 'a.pdf',
      externalUrl: 'https://example.com/x',
      simpleCost: '1.5',
      suppliers: [
        {
          contactId: CONTACT,
          code: 'S1',
          name: 'Fornitore',
          minQuantity: '2',
          deliveryTime: '3',
          deliveryTimeUnit: 'days',
          favorite: true,
          priceLists: [{ id: 'l1', price: '1', discount1: '2', discount2: '3', discount3: '4' }],
        },
      ],
      shipping: { width: '1', height: '2', depth: '3', weight: '4' },
    });
    expect(core.prices).toHaveLength(1);
    expect(core.prices[0]).toMatchObject({ id: 'r1', net: '10', gross: '12.2', written: 'net' });
    expect(core.image).toMatchObject({ imageId: null, descriptor: IMAGE });
    expect(core.gallery).toHaveLength(1);
    expect(core.gallery[0].descriptor).toEqual(IMAGE);
    expect(local.places).toEqual([
      { placeId: 'p1', favorite: true, favoriteHandheld: false, position: '2', productionCenterId: 'pc1' },
      { placeId: 'p2', favorite: false, favoriteHandheld: true, position: '', productionCenterId: '' },
    ]);
    expect(local.stations).toEqual({ rooms: { p1: ['s1', 's2'] }, counter: { p1: ['s3'] } });
    expect(local.stock).toEqual([
      { placeId: 'p1', storageId: 'st1', min: '1', max: '10', location: 'A1' },
      { placeId: 'p1', storageId: 'st2', min: '', max: '', location: '' },
    ]);
  });

  it('fills what a product lacks', () => {
    const { core, local } = sparseModel();
    expect(core).toMatchObject({
      type: 'tobaccos',
      availability: { pos: false, warehouse: false, scales: false, ecommerce: false },
      code: '',
      plu: '',
      modifier: { type: 'addRemove', pricePercentagePlus: '', pricePercentageMinus: '' },
      conversionRatio: '',
      scaleType: 'weight',
      colors: { text: DEFAULT_BUTTON_COLOR, background: DEFAULT_BUTTON_COLOR },
      barcodes: [{ value: '9', loadQuantity: '', saleQuantity: '' }],
      components: [{ productId: 'c1', quantity: '', waste: '' }],
      menu: [{ categoryId: '', quantity: '', course: '', productIds: [] }],
      modifierChoices: [{ categoryId: '', freeQuantity: '', priceRule: 'highest', productIds: [] }],
      modularPriceRule: '',
      image: null,
      gallery: [],
      suppliers: [
        {
          contactId: '',
          code: '',
          name: '',
          minQuantity: '',
          deliveryTime: '',
          deliveryTimeUnit: '',
          favorite: false,
          priceLists: [{ id: '', price: '', discount1: '', discount2: '', discount3: '' }],
        },
      ],
    });
    expect(core.prices).toEqual([]);
    expect(local).toEqual({ places: [], stations: { rooms: {}, counter: {} }, stock: [] });
  });

  it('does not share the lists with the product', () => {
    const model = fullModel();
    expect(model.core.categoryIds).not.toBe(FULL.categoryIds);
    expect(model.core.menu[0].productIds).not.toBe(FULL.menu?.[0].productIds);
  });
});

describe('placeRowOf', () => {
  it('fills what a store lacks', () => {
    expect(placeRowOf({ placeId: 'p', favorite: false, favoriteHandheld: false, position: null, productionCenterId: null })).toEqual({
      placeId: 'p',
      favorite: false,
      favoriteHandheld: false,
      position: '',
      productionCenterId: '',
    });
  });
});

describe('issues of the rows', () => {
  it('checks a barcode', () => {
    expect(barcodeIssues({ value: '123', loadQuantity: '', saleQuantity: '1' })).toEqual({});
    expect(barcodeIssues({ value: ' ', loadQuantity: 'x', saleQuantity: '-1' })).toEqual({
      value: 'required',
      loadQuantity: 'type',
      saleQuantity: 'minimum',
    });
    expect(barcodeIssues({ value: 'a'.repeat(65), loadQuantity: '', saleQuantity: '' }).value).toBe('maxLength');
    expect(barcodeIssues({ value: 'a\u0001', loadQuantity: '', saleQuantity: '' }).value).toBe('pattern');
    expect(barcodeIssues({ value: 'a'.repeat(64), loadQuantity: '', saleQuantity: '' })).toEqual({});
  });

  it('checks a component', () => {
    expect(componentIssues({ productId: 'p', quantity: '1', waste: '' })).toEqual({});
    expect(componentIssues({ productId: '', quantity: '', waste: '101' })).toEqual({
      productId: 'required',
      quantity: 'required',
      waste: 'maximum',
    });
    expect(componentIssues({ productId: 'p', quantity: '0', waste: '' })).toEqual({ quantity: 'minimum' });
    expect(componentIssues({ productId: 'p', quantity: 'x', waste: '' })).toEqual({ quantity: 'type' });
  });

  it('checks a group of choices of a menu', () => {
    expect(menuIssues({ categoryId: 'k', quantity: '1', course: '', productIds: [] })).toEqual({});
    expect(menuIssues({ categoryId: '', quantity: '0', course: '100', productIds: [] })).toEqual({
      categoryId: 'required',
      quantity: 'minimum',
      course: 'maximum',
    });
    expect(menuIssues({ categoryId: 'k', quantity: '1.5', course: '1.5', productIds: [] })).toEqual({
      quantity: 'type',
      course: 'type',
    });
  });

  it('checks a group of choices of modifiers', () => {
    expect(choiceIssues({ categoryId: 'k', freeQuantity: '0', priceRule: 'highest', productIds: [] })).toEqual({});
    expect(choiceIssues({ categoryId: '', freeQuantity: '', priceRule: 'highest', productIds: [] })).toEqual({
      categoryId: 'required',
      freeQuantity: 'required',
    });
    expect(choiceIssues({ categoryId: 'k', freeQuantity: '101', priceRule: 'lowest', productIds: [] })).toEqual({ freeQuantity: 'maximum' });
  });

  it('checks a supplier', () => {
    const row = { contactId: CONTACT, code: '', name: '', minQuantity: '', deliveryTime: '', deliveryTimeUnit: '' as const, favorite: false, priceLists: [] };
    expect(supplierIssues(row)).toEqual({});
    expect(supplierIssues({ ...row, contactId: ` ${CONTACT} ` })).toEqual({});
    expect(supplierIssues({ ...row, contactId: ' ' }).contactId).toBe('required');
    expect(supplierIssues({ ...row, contactId: 'zz' }).contactId).toBe('format');
    expect(supplierIssues({ ...row, code: 'a'.repeat(65), name: 'a'.repeat(151), minQuantity: '-1', deliveryTime: 'x' })).toEqual({
      code: 'maxLength',
      name: 'maxLength',
      minQuantity: 'minimum',
      deliveryTime: 'type',
    });
    expect(supplierIssues({ ...row, code: 'a'.repeat(64), name: 'a'.repeat(150) })).toEqual({});
  });

  it('checks a price list of a supplier', () => {
    expect(supplierListIssues({ id: 'l', price: '1', discount1: '', discount2: '50', discount3: '100' })).toEqual({});
    expect(supplierListIssues({ id: 'l', price: 'x', discount1: '101', discount2: '-1', discount3: 'y' })).toEqual({
      price: 'type',
      discount1: 'maximum',
      discount2: 'minimum',
      discount3: 'type',
    });
  });

  it('checks the position of a store', () => {
    expect(placeIssues({ placeId: 'p', favorite: false, favoriteHandheld: false, position: '', productionCenterId: '' })).toEqual({});
    expect(placeIssues({ placeId: 'p', favorite: false, favoriteHandheld: false, position: '1.5', productionCenterId: '' })).toEqual({ position: 'type' });
  });

  it('checks the limits of a storage', () => {
    expect(stockIssues({ placeId: 'p', storageId: 's', min: '', max: '1', location: 'A' })).toEqual({});
    expect(stockIssues({ placeId: 'p', storageId: 's', min: '-1', max: 'x', location: 'a'.repeat(65) })).toEqual({
      min: 'minimum',
      max: 'type',
      location: 'maxLength',
    });
  });

  it('tells whether any row has an issue', () => {
    const issues = (row: { value: string }) => (row.value === '' ? { value: 'required' } : {});
    expect(anyIssue([{ value: 'a' }, { value: '' }], issues)).toBe(true);
    expect(anyIssue([{ value: 'a' }], issues)).toBe(false);
    expect(anyIssue([], issues)).toBe(false);
  });
});

describe('issues of the texts and links', () => {
  it('checks a code and a short name', () => {
    for (const issue of [codeIssue, shortNameIssue]) {
      expect(issue('')).toBeUndefined();
      expect(issue(' ok ')).toBeUndefined();
      expect(issue('a\u007F')).toBe('pattern');
    }
    expect(codeIssue('a'.repeat(64))).toBeUndefined();
    expect(codeIssue(`${'a'.repeat(64)}b`)).toBe('maxLength');
    expect(shortNameIssue('a'.repeat(18))).toBeUndefined();
    expect(shortNameIssue('a'.repeat(19))).toBe('maxLength');
  });

  it('checks a PLU', () => {
    for (const valid of ['', ' ', '0', '7', ' 123456 ']) {
      expect(pluIssue(valid)).toBeUndefined();
    }
    for (const invalid of ['00', '012', '1234567', 'a', '-1', '1.5']) {
      expect(pluIssue(invalid)).toBe('format');
    }
  });

  it('checks a link', () => {
    expect(urlIssue('')).toBeUndefined();
    expect(urlIssue('  ')).toBeUndefined();
    expect(urlIssue(' https://example.com/a?b=c ')).toBeUndefined();
    expect(urlIssue(`https://example.com/${'a'.repeat(2048)}`)).toBe('maxLength');
    for (const invalid of ['example.com', 'http://example.com', 'https://user@example.com', 'https://:secret@example.com', 'javascript:alert(1)']) {
      expect(urlIssue(invalid)).toBe('format');
    }
  });

  it('checks an internal file name', () => {
    expect(fileNameIssue('')).toBeUndefined();
    expect(fileNameIssue(' a b.pdf ')).toBeUndefined();
    expect(fileNameIssue('a'.repeat(255))).toBeUndefined();
    expect(fileNameIssue('a'.repeat(256))).toBe('maxLength');
    expect(fileNameIssue('a\nb')).toBe('pattern');
  });
});

describe('modelChanged', () => {
  it('compares the whole form', () => {
    expect(modelChanged(fullModel(), fullModel())).toBe(false);
    expect(modelChanged(edited((m) => (m.core.code = 'X')), fullModel())).toBe(true);
    expect(modelChanged(edited((m) => (m.local.places = [])), fullModel())).toBe(true);
  });
});

describe('createBody', () => {
  it('sends everything the user filled in for a group with every feature', () => {
    const model = edited((m) => {
      m.core.gallery = [logo('i2'), { descriptor: null, imageId: null, label: 'x', previewUrl: null }, ...m.core.gallery];
      m.core.image = logo('i1');
      m.core.shortDescription = { it: '  corta  ', en: ' ' };
      m.core.menu[0].course = '';
      m.local.stock.push({ placeId: 'p2', storageId: 'st9', min: '', max: '', location: '' });
    });
    const body = createBody(model, plain());
    expect(body).toMatchObject({
      type: 'exempt',
      enabled: false,
      code: 'C1',
      favorite: true,
      generic: true,
      toCheck: true,
      noDiscount: true,
      integrations: { floodOrders: true, yellgo: true, leggimenu: true },
      brandId: 'b1',
      position: 3,
      productionValue: 2,
      validFrom: '2026-03-04T10:20:00.000Z',
      validTo: '2026-03-05T10:20:00.000Z',
      categoryIds: ['k1', 'k2'],
      attributeIds: ['a1'],
      barcodes: [{ value: '123', loadQuantity: 2, saleQuantity: 1 }],
      simpleCost: 1.5,
      suppliers: [
        {
          contactId: CONTACT,
          code: 'S1',
          name: 'Fornitore',
          minQuantity: 2,
          deliveryTime: 3,
          deliveryTimeUnit: 'days',
          favorite: true,
          priceLists: [{ id: 'l1', price: 1, discount1: 2, discount2: 3, discount3: 4 }],
        },
      ],
      shipping: { width: 1, height: 2, depth: 3, weight: 4 },
      components: [{ productId: 'c1', quantity: 2, waste: 5 }],
      availability: { pos: true, warehouse: true, scales: true, ecommerce: true },
      favoriteHandheld: true,
      dining: { halfPortion: true, feePercentage: 7, hiddenOnHandheld: true, affiliatedMenu: true, reversePrint: true },
      featured: true,
      colors: { text: '#111111', background: '#222222' },
      plu: '12',
      scaleType: 'piece',
      duration: '01:30',
      maxConcurrent: 4,
      loadUnit: 'kg',
      unloadUnit: 'g',
      conversionRatio: 2,
      requiredModifierIds: ['m1'],
      modifierIds: ['m2'],
      excludedModifierIds: ['m3'],
      modifierCategoryIds: ['mc1'],
      modifierChoices: [{ categoryId: 'k1', freeQuantity: 1, priceRule: 'lowest', productIds: ['a'] }],
      menu: [{ categoryId: 'k1', quantity: 1, course: null, productIds: ['a', 'b'] }],
      modularPriceRule: 'sum',
      gallery: [{ imageId: 'i2' }, { imageId: undefined }, { imageId: 'img1' }],
      internalFileName: 'a.pdf',
      externalUrl: 'https://example.com/x',
      name: { it: 'Acqua' },
      shortName: { it: 'Ac' },
      shortDescription: { it: 'corta' },
      description: { en: 'Water' },
      image: { imageId: 'i1' },
      places: [
        { placeId: 'p1', favorite: true, favoriteHandheld: false, position: 2, productionCenterId: 'pc1' },
        { placeId: 'p2', favorite: false, favoriteHandheld: true, position: null, productionCenterId: null },
      ],
      printStations: { p1: ['s1', 's2'] },
      counterPrintStations: { p1: ['s3'] },
      stock: { p1: { st1: { min: 1, max: 10, location: 'A1' } } },
    });
    expect(body['prices']).toHaveLength(1);
    expect(body['prices']).toEqual([expect.objectContaining({ id: 'r1', net: 10, priceListId: 'pl1' })]);
    expect(body).not.toHaveProperty('isModifier');
    expect(body).not.toHaveProperty('modifier');
    expect(body['stock']).not.toHaveProperty('p2');
    expect((body['stock'] as Record<string, object>)['p1']).not.toHaveProperty('st2');
  });

  it('leaves out the empty texts, the stock without limits and the image that was already stored', () => {
    const body = createBody(
      edited((m) => {
        m.core.description = { it: '', en: '' };
        m.core.shortName = { it: '', en: '' };
        m.core.shortDescription = { it: '', en: '' };
        m.local.stock = [{ placeId: 'p1', storageId: 'st1', min: '', max: ' ', location: '' }];
      }),
      plain(),
    );
    for (const key of ['description', 'shortName', 'shortDescription', 'stock', 'image']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends only the fields of the features the group lacks nothing of: none for a group without features', () => {
    const body = createBody(
      edited((m) => {
        m.core.modularPriceRule = '';
        m.local.places = [];
      }),
      plain(NONE),
    );
    for (const key of [
      'availability',
      'favoriteHandheld',
      'dining',
      'featured',
      'colors',
      'plu',
      'scaleType',
      'duration',
      'maxConcurrent',
      'loadUnit',
      'unloadUnit',
      'conversionRatio',
      'requiredModifierIds',
      'modifierChoices',
      'gallery',
      'internalFileName',
      'externalUrl',
      'places',
      'printStations',
      'counterPrintStations',
      'stock',
      'image',
      'isModifier',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body['modularPriceRule']).toBeNull();
    expect(body['menu']).toEqual([{ categoryId: 'k1', quantity: 1, productIds: ['a', 'b'] }]);
  });

  it('sends the availability fields of the features that are on only', () => {
    const only = (name: keyof ProductFeatures) => createBody(fullModel(), plain(features([name])))['availability'];
    expect(only('cash')).toEqual({ pos: true });
    expect(only('warehouse')).toEqual({ warehouse: true });
    expect(only('scales')).toEqual({ scales: true });
    expect(only('customersApp')).toEqual({ ecommerce: true });
  });

  it('does not send a conversion ratio that is empty', () => {
    const body = createBody(edited((m) => (m.core.conversionRatio = ' ')), plain(features(['warehouse'])));
    expect(body).not.toHaveProperty('conversionRatio');
    expect(body['loadUnit']).toBe('kg');
  });

  it('sends a modifier with its settings and without the menu and the modifiers of its own', () => {
    const body = createBody(edited((m) => (m.core.modifier.description = { it: ' più ', en: '' })), modifier());
    expect(body).toMatchObject({
      isModifier: true,
      modifier: { type: 'add', pricePercentagePlus: 10, pricePercentageMinus: 5, description: { it: 'più' } },
    });
    for (const key of ['menu', 'modularPriceRule', 'requiredModifierIds', 'modifierIds', 'excludedModifierIds', 'modifierCategoryIds', 'modifierChoices']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends a modifier without a description when it has none', () => {
    const body = createBody(edited((m) => (m.core.modifier.description = { it: '', en: '' })), modifier());
    expect(body['modifier']).toEqual({ type: 'add', pricePercentagePlus: 10, pricePercentageMinus: 5 });
  });

  it('sends a modifier of a group without variants as a bare modifier', () => {
    const body = createBody(fullModel(), modifier(features(['cash'])));
    expect(body['isModifier']).toBe(true);
    expect(body).not.toHaveProperty('modifier');
  });

  it('sends the course of a menu only to a group with rooms, and the places of a group without them with no hand-held choice', () => {
    const rooms = createBody(fullModel(), plain(features(['rooms'])));
    expect(rooms['menu']).toEqual([{ categoryId: 'k1', quantity: 1, course: 2, productIds: ['a', 'b'] }]);
    expect((rooms['places'] as object[])[0]).toHaveProperty('favoriteHandheld', false);
    const rest = createBody(fullModel(), plain(features(['cash'])));
    expect((rest['places'] as object[])[0]).not.toHaveProperty('favoriteHandheld');
  });
});

describe('patchBody', () => {
  const same = () => patchBody(fullModel(), fullModel(), plain(), 'full');

  it('sends nothing for a form that did not change', () => {
    expect(same()).toEqual({});
    expect(patchBody(fullModel(), fullModel(), plain(), 'local')).toEqual({});
    expect(patchBody(sparseModel(), sparseModel(), modifier(), 'full')).toEqual({});
  });

  it('sends the fields that changed whole and the lists whole', () => {
    const now = edited((m) => {
      m.core.code = ' NEW ';
      m.core.enabled = true;
      m.core.categoryIds = ['k1'];
      m.core.barcodes[0].value = '999';
      m.core.menu[0].productIds = ['a'];
      m.core.brandId = '';
    });
    expect(patchBody(now, fullModel(), plain(), 'full')).toEqual({
      code: 'NEW',
      enabled: true,
      categoryIds: ['k1'],
      barcodes: [{ value: '999', loadQuantity: 2, saleQuantity: 1 }],
      menu: [{ categoryId: 'k1', quantity: 1, course: 2, productIds: ['a'] }],
      brandId: null,
    });
  });

  it('sends the settings leaf by leaf', () => {
    const now = edited((m) => {
      m.core.availability.pos = false;
      m.core.integrations.yellgo = false;
      m.core.colors.background = '#333333';
      m.core.dining.feePercentage = '9';
      m.core.shipping.weight = '8';
    });
    expect(patchBody(now, fullModel(), plain(), 'full')).toEqual({
      availability: { pos: false },
      integrations: { yellgo: false },
      colors: { background: '#333333' },
      dining: { feePercentage: 9 },
      shipping: { weight: 8 },
    });
  });

  it('ignores the settings of a feature the group lacks', () => {
    const now = edited((m) => {
      m.core.availability.pos = false;
      m.core.colors.text = '#999999';
      m.core.dining.halfPortion = false;
      m.core.plu = '5';
      m.core.gallery = [];
    });
    expect(patchBody(now, fullModel(), plain(NONE), 'full')).toEqual({});
  });

  it('sends the texts language by language, taking away the language of a text that was emptied', () => {
    const now = edited((m) => {
      m.core.name['it'] = ' Acqua minerale ';
      m.core.name['en'] = 'Water';
      m.core.shortName['it'] = '';
      m.core.description['en'] = 'Water';
      m.core.shortDescription['it'] = 'x';
    });
    expect(patchBody(now, fullModel(), plain(), 'full')).toEqual({
      name: { it: 'Acqua minerale', en: 'Water' },
      shortName: { it: null },
      shortDescription: { it: 'x' },
    });
  });

  it('sends the settings and the description of a modifier together, or the description alone', () => {
    const settings = edited((m) => {
      m.core.modifier.type = 'remove';
      m.core.modifier.description['it'] = 'meno';
    });
    expect(patchBody(settings, fullModel(), modifier(), 'full')).toEqual({
      modifier: { type: 'remove', description: { it: 'meno' } },
    });
    const text = edited((m) => (m.core.modifier.description['en'] = 'minus'));
    expect(patchBody(text, fullModel(), modifier(), 'full')).toEqual({ modifier: { description: { en: 'minus' } } });
  });

  it('does not send the description of a modifier when the product is not one or the group lacks the variants', () => {
    const now = edited((m) => (m.core.modifier.description['it'] = 'meno'));
    expect(patchBody(now, fullModel(), plain(), 'full')).toEqual({});
    expect(patchBody(now, fullModel(), modifier(features(['cash'])), 'full')).toEqual({});
  });

  it('takes the image away, replaces it or leaves it', () => {
    expect(patchBody(edited((m) => (m.core.image = null)), fullModel(), plain(), 'full')).toEqual({ image: null });
    expect(patchBody(edited((m) => (m.core.image = logo('i9'))), fullModel(), plain(), 'full')).toEqual({ image: { imageId: 'i9' } });
    expect(patchBody(fullModel(), fullModel(), plain(), 'full')).not.toHaveProperty('image');
    const none = edited((m) => (m.core.image = null), sparseModel());
    expect(patchBody(none, sparseModel(), plain(), 'full')).not.toHaveProperty('image');
    expect(patchBody(edited((m) => (m.core.image = null)), fullModel(), plain(NONE), 'full')).toEqual({});
  });

  it('sends the gallery and the links of a group with media when they change', () => {
    const now = edited((m) => {
      m.core.gallery = [logo('i1')];
      m.core.externalUrl = '';
      m.core.internalFileName = 'b.pdf';
    });
    expect(patchBody(now, fullModel(), plain(), 'full')).toEqual({
      gallery: [{ imageId: 'i1' }],
      externalUrl: null,
      internalFileName: 'b.pdf',
    });
  });

  it('sends a caller who manages only their own stores the fields of the stores alone', () => {
    const now = edited((m) => {
      m.core.code = 'IGNORED';
      m.core.name['it'] = 'Ignored';
      m.local.places[0].favorite = false;
    });
    expect(patchBody(now, fullModel(), plain(), 'local')).toEqual({
      places: [
        { placeId: 'p1', favorite: false, favoriteHandheld: false, position: 2, productionCenterId: 'pc1' },
        { placeId: 'p2', favorite: false, favoriteHandheld: true, position: null, productionCenterId: null },
      ],
    });
  });

  it('does not take a different order of the stores for a change', () => {
    const now = edited((m) => m.local.places.reverse());
    expect(patchBody(now, fullModel(), plain(), 'local')).toEqual({});
  });

  it('sends the stores whole when one is added or removed, without the hand-held choice for a group without rooms', () => {
    const added = edited((m) => m.local.places.push({ placeId: 'p3', favorite: true, favoriteHandheld: true, position: '', productionCenterId: '' }));
    const body = patchBody(added, fullModel(), plain(features(['cash'])), 'local');
    expect(body['places']).toHaveLength(3);
    expect((body['places'] as object[])[2]).toEqual({ placeId: 'p3', favorite: true, position: null, productionCenterId: null });
    const removed = edited((m) => m.local.places.pop());
    expect(patchBody(removed, fullModel(), plain(), 'local')['places']).toHaveLength(1);
  });

  it('sends the stations of the stores that changed, with null for a store left with none', () => {
    const now = edited((m) => {
      m.local.stations = { rooms: { p2: ['s9'] }, counter: { p1: ['s3'] } };
    });
    expect(patchBody(now, fullModel(), plain(), 'local')).toEqual({ printStations: { p1: null, p2: ['s9'] } });
    const counter = edited((m) => {
      m.local.stations = { rooms: m.local.stations.rooms, counter: {} };
    });
    expect(patchBody(counter, fullModel(), plain(), 'local')).toEqual({ counterPrintStations: { p1: null } });
  });

  it('ignores the stations of a group without ordering', () => {
    const now = edited((m) => (m.local.stations = { rooms: {}, counter: {} }));
    expect(patchBody(now, fullModel(), plain(features(['cash'])), 'local')).toEqual({});
  });

  it('sends the limits of the storages that changed, new ones included', () => {
    const now = edited((m) => {
      m.local.stock[0].min = '2';
      m.local.stock.push({ placeId: 'p2', storageId: 'st7', min: '', max: '4', location: ' B2 ' });
    });
    expect(patchBody(now, fullModel(), plain(), 'local')).toEqual({
      stock: {
        p1: { st1: { min: 2, max: 10, location: 'A1' } },
        p2: { st7: { min: null, max: 4, location: 'B2' } },
      },
    });
  });

  it('does not send a new storage whose limits are empty nor limits that only differ by spaces', () => {
    const now = edited((m) => {
      m.local.stock[0].location = ' A1 ';
      m.local.stock.push({ placeId: 'p2', storageId: 'st7', min: '', max: ' ', location: '' });
    });
    expect(patchBody(now, fullModel(), plain(), 'local')).toEqual({});
  });

  it('sends the emptied limits of a storage as null', () => {
    const now = edited((m) => {
      m.local.stock[0].min = '';
      m.local.stock[0].max = '';
      m.local.stock[0].location = '';
    });
    expect(patchBody(now, fullModel(), plain(), 'local')).toEqual({
      stock: { p1: { st1: { min: null, max: null, location: null } } },
    });
  });

  it('ignores the stock of a group without a warehouse', () => {
    const now = edited((m) => (m.local.stock[0].min = '2'));
    expect(patchBody(now, fullModel(), plain(features(['cash'])), 'local')).toEqual({});
  });

  it('sends the stores and the product fields together for a full scope', () => {
    const now = edited((m) => {
      m.core.code = 'N';
      m.local.places = [];
    });
    expect(patchBody(now, fullModel(), plain(), 'full')).toEqual({ places: [], code: 'N' });
  });
});
