import { Double, ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import type { PlacesWorld } from './places.ts';
import type { TestDatabases } from './mongo.ts';

/** The date of the documents the legacy wrote. */
export const LEGACY_DATE = new Date('2024-03-01T09:00:00.000Z');

/** The collections of the product catalog of the group database `index` of a world. */
export interface CatalogCollections {
  readonly departments: Collection<Document>;
  readonly brands: Collection<Document>;
  readonly attributes: Collection<Document>;
  readonly categories: Collection<Document>;
  /** The copies of the places in the common database. */
  readonly places: Collection<Document>;
  readonly products: Collection<Document>;
  readonly files: Collection<Document>;
}

/**
 * The collections of the product catalog of a group of the world.
 *
 * @param ctx Throw-away databases.
 * @param world The running world.
 * @param index Index of the group of the isolation cluster.
 */
export function catalogCollections(ctx: TestDatabases, world: Pick<PlacesWorld, 'group'>, index = 0): CatalogCollections {
  const db = ctx.databases.group(world.group(index).groupId, 'cluster0');
  return {
    departments: db.collection('products_departments'),
    brands: db.collection('products_brands'),
    attributes: db.collection('products_attributes'),
    categories: db.collection('products_categories'),
    places: ctx.databases.common().collection('places'),
    products: db.collection('products'),
    files: db.collection('files'),
  };
}

/** The tax rate a department of the fixtures holds. */
export const TAX_COPY = Object.freeze({ id: 'tax-001', value: 22, department: 1, description: null, natura: null });

/** A department as the legacy stores it; `overrides` break it in the way a test needs. */
export function legacyDepartment(overrides: Document = {}): Document {
  return {
    _id: new ObjectId(),
    code: 5,
    tax: { ...TAX_COPY },
    name: { it: 'Reparto legacy' },
    description: { it: '' },
    medias: { images: {} },
    placesAvailability: [],
    status: true,
    insertDate: LEGACY_DATE,
    updateDate: LEGACY_DATE,
    ...overrides,
  };
}

/** A brand as the legacy stores it. */
export function legacyBrand(overrides: Document = {}): Document {
  return { _id: new ObjectId(), name: { it: 'Marca legacy' }, description: { it: '' }, placesAvailability: [], medias: { images: {} }, status: true, insertDate: LEGACY_DATE, updateDate: LEGACY_DATE, ...overrides };
}

/** A group of attributes as the legacy stores it (its upsert never wrote `insertDate`). */
export function legacyAttributeGroup(overrides: Document = {}): Document {
  return { _id: new ObjectId(), name: { it: 'Gruppo legacy' }, attributes: [{ id: 'attr-1', name: { it: 'Rosso' } }, { id: 'attr-2', name: { it: 'Blu' } }], updateDate: LEGACY_DATE, ...overrides };
}

/** A product with the fields the catalog rules read. */
export function legacyProduct(overrides: Document = {}): Document {
  return { _id: new ObjectId(), name: { it: 'Prodotto' }, trash: false, brandId: null, attributes: [], prices: [], ...overrides };
}

/** A price of a product with the copy of a tax rate that has a fiscal department number. */
export const priceWithDepartment = (department: number): Document => ({ id: 'price-1', listId: 'list-1', price: 1, taxed: 1.22, tax: 22, taxData: { ...TAX_COPY, department } });

/** A stored image of a group, as the upload writes it; `overrides` break it in the way a test needs. */
export async function seedImage(collections: Pick<CatalogCollections, 'files'>, groupId: ObjectId, overrides: Document = {}): Promise<ObjectId> {
  const _id = new ObjectId();
  await collections.files.insertOne({
    _id,
    groupId,
    basename: 'insegna-1a2b3c4d.png',
    name: 'Insegna',
    extension: 'png',
    dirname: '/media/image',
    type: 'image',
    mimetype: 'image/png',
    filectime: new Double(1_731_490_000_123),
    alt: 'Insegna alt',
    title: 'Insegna title',
    trash: false,
    insertDate: LEGACY_DATE,
    updateDate: LEGACY_DATE,
    ...overrides,
  });
  return _id;
}

/** A category as the legacy stores it; `overrides` break it in the way a test needs. */
export function legacyCategory(overrides: Document = {}): Document {
  return {
    _id: new ObjectId(),
    parentId: null,
    name: { it: 'Categoria legacy' },
    description: { it: '' },
    position: 1,
    productionValue: null,
    availability: { pos: true, ecommerce: false },
    noDiscount: false,
    requiresGreaterAge: false,
    secondaryFiscalPrinter: false,
    featured: false,
    backgroundColor: '#000000',
    textColor: '#000000',
    medias: { images: {} },
    placesAvailability: [],
    variants: [],
    variantsCategories: [],
    printStations: {},
    printStationsNoRooms: {},
    roomsSettings: { endMeal: false, handheldHidden: false, percentageFee: null, printGroup: null, alwaysFirstExit: false, notAffiliatedMenu: false, type: 'other' },
    tgm: { type: false },
    integrations: { floodOrders: false, easyappear: false, yellgo: false, leggimenu: false },
    status: true,
    insertDate: LEGACY_DATE,
    updateDate: LEGACY_DATE,
    ...overrides,
  };
}
