import type { Document, ObjectId } from 'mongodb';

/** A product of the price list as the table shows it. */
export interface TobaccoRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly category: string;
  /** Price per kilogram, `null` when the list has none. */
  readonly priceKg: number | null;
  /** Price of the pack, `null` when the list has none. */
  readonly price: number | null;
  /** The first barcode of the product, `null` when it has none. */
  readonly barcode: string | null;
}

/** The first barcode of the product, computed by the database: `null` when `barcodes` is not an array of products (the legacy wrote what the file held), instead of an error. */
export const FIRST_BARCODE = Object.freeze({
  $cond: Object.freeze([Object.freeze({ $isArray: '$barcodes.barcode' }), Object.freeze({ $arrayElemAt: Object.freeze(['$barcodes.barcode', 0]) }), null]),
});

/** What the list reads of a stored product: the fields of the table, and the first barcode computed by the database (the other barcodes stay where they are). */
export const TOBACCO_PROJECTION = Object.freeze({
  code: 1,
  name: 1,
  shortName: 1,
  category: 1,
  priceKg: 1,
  price: 1,
  barcode: FIRST_BARCODE,
} as const);

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The public form of a stored product. The legacy wrote whatever the file held, so a field of the wrong type (text where a number goes, `NaN`) is shown as an empty text or no number.
 *
 * @param document The stored document, read with {@link TOBACCO_PROJECTION}.
 */
export function toTobaccoRow(document: Document): TobaccoRow {
  const barcode: unknown = document['barcode'];
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    code: textOf(document['code']),
    name: textOf(document['name']),
    shortName: textOf(document['shortName']),
    category: textOf(document['category']),
    priceKg: numberOf(document['priceKg']),
    price: numberOf(document['price']),
    barcode: typeof barcode === 'string' && barcode !== '' ? barcode : null,
  };
}
