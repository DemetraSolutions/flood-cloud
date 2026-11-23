import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { LEGACY_DATE } from './product-catalog.ts';

/** The tax rate the products of the fixtures hold in their prices. */
export const PRICE_TAX = Object.freeze({ id: 'tax-001', value: 22, department: 1, description: 'Ordinaria', natura: null });

/** A price rule as the legacy backoffice stores it. */
export function legacyPrice(overrides: Document = {}): Document {
  return {
    id: 'price-1',
    listId: 'list-1',
    price: new Double(10),
    taxed: new Double(12.2),
    tax: 22,
    taxData: { ...PRICE_TAX },
    discount: 0,
    currency: 'EUR',
    startDate: null,
    endDate: null,
    startTimeDaily: null,
    endTimeDaily: null,
    weekDays: [],
    fromQt: 1,
    maxQtSell: null,
    ...overrides,
  };
}

/**
 * A complete product as the legacy backoffice writes it (every key of an insert), for the tests that read and change the whole of it. `overrides` replace keys; a key given as `undefined` is missing from the
 * stored document (the driver would write `null`).
 *
 * @param overrides The keys to change.
 */
export function legacyFullProduct(overrides: Document = {}): Document {
  const document: Document = {
    _id: new ObjectId(),
    type: 'product',
    time: '',
    max: null,
    code: 'C-1',
    barcode: [{ value: '8000000000001', qtLoad: null, qtSale: 1 }],
    brandId: null,
    name: { it: 'Prodotto legacy' },
    shortName: { it: 'Legacy' },
    description: { it: '' },
    shortDescription: { it: '' },
    favorite: false,
    favoriteHandheld: false,
    generic: false,
    toCheck: false,
    noDiscount: false,
    printStations: {},
    printStationsNoRooms: {},
    availability: { pos: true, warehouse: false, scales: false, ecommerce: false },
    plu: '',
    scaleType: new Int32(0),
    variant: { status: false, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } },
    variantsRequired: [],
    variants: [],
    variantsExcluded: [],
    variantsCategories: [],
    bundleProducts: [],
    selectableBundleProducts: [],
    selectableVariantsBundleProducts: [],
    modularBundle: { priceRule: null },
    measureLoad: 'pz',
    measureDownload: 'pz',
    measureConversionRatio: new Double(1),
    quantity: {},
    lastAveragePrice: {
      lastSupplierId: null,
      total: { year: null, lastPrice: 0, totalN: 0, totalCost: 0, averagePrice: 0, totalQuantity: 0, totalCostQt: 0, weightedAveragePrice: 0 },
      suppliers: {},
    },
    simpleCost: null,
    colors: { pos: { text: '#000000', background: '#000000' } },
    startDate: null,
    endDate: null,
    categories: [],
    placesAvailability: [],
    medias: { images: {} },
    shippingInfo: { width: null, height: null, depth: null, weight: null },
    tags: [],
    related: [],
    attributes: [],
    suppliers: [],
    parentId: null,
    prices: [legacyPrice()],
    position: null,
    productionValue: null,
    roomsSettings: { halfPortion: false, percentageFee: null, handheldHidden: false, affiliatedMenu: false, reversePrint: false },
    integrations: { floodOrders: false, easyappear: false, yellgo: false, leggimenu: false },
    featured: false,
    status: true,
    trash: false,
    insertDate: LEGACY_DATE,
    updateDate: LEGACY_DATE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
}

/** The place entry of a product as the legacy stores it. */
export const placeEntry = (id: ObjectId, overrides: Document = {}): Document => ({ id, favorite: false, favoriteHandheld: false, position: null, productionCenterId: null, ...overrides });
