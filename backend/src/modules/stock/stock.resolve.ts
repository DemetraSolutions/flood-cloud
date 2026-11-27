import type { ObjectId } from 'mongodb';

/** Deepest level of components the resolution follows: a product is level 0, its components are level 1, and so on. A component below this level is not followed. */
export const MAX_STOCK_DEPTH = 10;

/** Decimals a stock quantity is rounded to (the quantities of the warehouse are kept to the millionth). */
export const STOCK_DECIMALS = 6;

/** A component of a bill of materials (`bundleProducts[]` of the legacy product), as read from the database: the values are the stored ones and the resolution validates them. */
export interface StockComponent {
  /** The product the component is. */
  readonly _id: ObjectId;
  /** How many load units of the component one unit of the bill of the parent uses. */
  readonly quantity: unknown;
  /** The waste, in percent, to add to the quantity. */
  readonly waste: unknown;
}

/** A barcode of a product, as read from the database. */
export interface StockBarcode {
  readonly value: unknown;
  /** How many load units one reading of the barcode loads. */
  readonly qtLoad: unknown;
}

/**
 * The minimal view of a legacy `products` document the stock needs, always read from the database and never taken from a client. The values are the stored ones: the resolution checks them (`measureConversionRatio`,
 * `quantity` and `waste` of a component, `qtLoad`), so a corrupted document never turns a stock into `NaN`. The fields of the snapshot a movement keeps (`_id`, `code`, `name`, `type`,
 * `measureLoad`) are here as they are stored.
 */
export interface StockProduct {
  readonly _id: ObjectId;
  readonly type: unknown;
  /** The stored `availability` container (`warehouse` is the flag that says the product is kept in stock). */
  readonly availability: Readonly<Record<string, unknown>>;
  /** How many sale units make one load unit (the stock is kept in load units). */
  readonly measureConversionRatio: unknown;
  readonly bundleProducts: readonly StockComponent[];
  readonly barcode: readonly StockBarcode[];
  readonly code: unknown;
  readonly name: unknown;
  readonly measureLoad: unknown;
  /** `lastAveragePrice.total.weightedAveragePrice` as stored, `null` when absent. */
  readonly weightedAveragePrice: unknown;
}

/** A line to move: a product, how much, and in which unit. */
export interface StockLine {
  /** The product (hexadecimal id). */
  readonly productId: string;
  /** How much, greater than zero. */
  readonly quantity: number;
  /** `sale`: the quantity is in sale units, which the stock converts to load units; `load`: it is in load units (a manual load or unload, with the barcode that was read, if any). */
  readonly unit: 'sale' | 'load';
  /** The value of the barcode that was read: with the `load` unit its `qtLoad` multiplies the quantity. With the `sale` unit it changes nothing (the till has applied `qtSale` already). */
  readonly barcode?: string;
  /** The choices of a modular menu (only for a product that is not kept in stock): each is a product with the quantity the till has already scaled. */
  readonly modularSelections?: readonly { readonly productId: string; readonly quantity: number }[];
}

/** Which way a set of lines moves the stock. */
export type StockDirection = 'unload' | 'load';

/**
 * Something the stock found wrong in the data and went on without. An anomaly is never an error: a sale of the till is never refused for it.
 * `productMissing`: the product is not in the database; `invalidRatio`: its conversion ratio was not a positive number, `1` was used; `cycle`: the bill of materials contains itself, the branch was skipped;
 * `tooDeep`: the bill goes deeper than {@link MAX_STOCK_DEPTH}, the branch was skipped; `tooManyProducts`: the lines need more products than one call reads, nothing was moved;
 * `noCashStorage`: the point of sale has no storage of the cash desks, nothing was moved; `multipleCashStorages`: it has more than one, the last was used;
 * `invalidQuantity`: the quantity of a product, converted to its load unit and added up, is not a finite number (a huge quantity over a tiny ratio): that product is not moved;
 * `ruleMissing`: the group has no warehouse rule for the cash desk of that type (or its sign is not the right one), the movement of that type was not written.
 */
export type StockAnomaly =
  | { readonly code: 'productMissing' | 'invalidRatio' | 'cycle' | 'tooDeep' | 'invalidQuantity'; readonly productId: string }
  | { readonly code: 'tooManyProducts' | 'noCashStorage' | 'multipleCashStorages' }
  | { readonly code: 'ruleMissing'; readonly type: 'L' | 'D' };

/** What {@link resolveStockLines} returns. */
export interface StockResolution {
  /** The change of the stock of each product (hexadecimal id), in load units, signed (an unload is negative), rounded to {@link STOCK_DECIMALS} decimals; no entry is zero. */
  readonly deltas: Map<string, number>;
  readonly anomalies: StockAnomaly[];
}

/**
 * Rounds a quantity to {@link STOCK_DECIMALS} decimals and turns `-0` into `0`.
 *
 * @param value The quantity.
 * @returns The rounded quantity.
 */
export function roundStock(value: number): number {
  const rounded = Math.round(value * 10 ** STOCK_DECIMALS) / 10 ** STOCK_DECIMALS;
  return rounded === 0 ? 0 : rounded;
}

/** A finite number greater than zero, or `null`. */
const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/**
 * The ids of the products a resolution could not find, so that the caller reads them from the database and resolves again: the walk of the bill of materials is the one of the resolution itself, so there is a single set of rules.
 *
 * @param anomalies The anomalies of a resolution.
 * @returns The ids of the products that were missing, without duplicates.
 */
export function collectCatalogIds(anomalies: readonly StockAnomaly[]): string[] {
  return [...new Set(anomalies.flatMap((anomaly) => (anomaly.code === 'productMissing' ? [anomaly.productId] : [])))];
}

/**
 * Turns lines of products into the change of the stock of each product, in load units. It is a pure function over a catalog the caller has read from the database; it is the only place that knows how a sale unit, a load unit,
 * a bill of materials and a modular menu become a quantity of stock.
 *
 * - A product that is a service is skipped; a product that is not in the catalog is skipped with `productMissing`.
 * - **A product kept in stock** moves only itself (its components and its modular selections are ignored). A line in `sale` units moves `quantity / ratio`; a line in `load` units moves `quantity * qtLoad` of the barcode that was read when it has a
 *   positive `qtLoad`, otherwise `quantity`. A conversion ratio that is not a finite number greater than zero is `1`, with `invalidRatio`.
 * - **A product that is not kept in stock and has a bill of materials** moves its components. The quantity of the parent is expressed in units of its bill: `quantity` for a `sale` line, `quantity * ratio` of the parent for a `load` line. Each component
 *   moves `base * quantity * (1 + waste / 100)` **load units of the component** (never its ratio); a component that is itself not kept in stock and has a bill is expanded with that amount as the base. An invalid waste is `0`.
 * - **The modular selections** of a product that is not kept in stock are resolved as top level `sale` lines of their own quantity (already scaled by the till).
 * - A component that contains an ancestor is skipped with `cycle`; a component deeper than {@link MAX_STOCK_DEPTH} is skipped with `tooDeep`; a component that is not in the catalog is skipped with `productMissing`.
 * - The amounts of a product are summed as they are and rounded once at the end; the products whose change is zero are dropped.
 *
 * @param lines The lines to move (valid: positive quantities).
 * @param direction `unload` makes the change negative, `load` positive.
 * @param catalog The products the lines and their components refer to, by hexadecimal id.
 * @returns The changes and the anomalies found (each once).
 * @example
 * // Cases of 24 (ratio 24): 6 pieces sold unload 0.25, and 6 pieces returned load 0.25.
 * resolveStockLines([{ productId, quantity: 6, unit: 'sale' }], 'unload', catalog).deltas.get(productId); // -0.25
 */
export function resolveStockLines(lines: readonly StockLine[], direction: StockDirection, catalog: ReadonlyMap<string, StockProduct>): StockResolution {
  const sign = direction === 'unload' ? -1 : 1;
  const raw = new Map<string, number>();
  const anomalies = new Map<string, StockAnomaly>();
  const note = (anomaly: Extract<StockAnomaly, { readonly productId: string }>): void => {
    anomalies.set(`${anomaly.code}:${anomaly.productId}`, anomaly);
  };
  const add = (productId: string, amount: number): void => {
    raw.set(productId, (raw.get(productId) ?? 0) + sign * amount);
  };
  /** The conversion ratio of a product, `1` (with the anomaly) when it is not usable. */
  const ratioOf = (product: StockProduct, productId: string): number => {
    const ratio = positive(product.measureConversionRatio);
    if (ratio === null) {
      note({ code: 'invalidRatio', productId });
      return 1;
    }
    return ratio;
  };
  /** Moves the components of a product that is not kept in stock, `base` being the number of units of its bill. */
  const expand = (parent: StockProduct, base: number, ancestors: ReadonlySet<string>, depth: number): void => {
    for (const component of parent.bundleProducts) {
      const componentId = component._id.toHexString();
      const child = catalog.get(componentId);
      if (child === undefined) {
        note({ code: 'productMissing', productId: componentId });
      } else if (ancestors.has(componentId)) {
        note({ code: 'cycle', productId: componentId });
      } else if (depth + 1 > MAX_STOCK_DEPTH) {
        note({ code: 'tooDeep', productId: componentId });
      } else if (child.type !== 'service' && typeof component.quantity === 'number' && Number.isFinite(component.quantity)) {
        const waste = typeof component.waste === 'number' && Number.isFinite(component.waste) && component.waste >= 0 ? component.waste : 0;
        const amount = base * component.quantity * (1 + waste / 100);
        if (child.availability['warehouse'] === true) {
          add(componentId, amount);
        } else if (child.bundleProducts.length > 0) {
          expand(child, amount, new Set([...ancestors, componentId]), depth + 1);
        }
      }
    }
  };
  /** Moves a top level line. */
  const move = (line: StockLine): void => {
    const product = catalog.get(line.productId);
    if (product === undefined) {
      note({ code: 'productMissing', productId: line.productId });
    } else if (product.type !== 'service') {
      if (product.availability['warehouse'] === true) {
        if (line.unit === 'sale') {
          add(line.productId, line.quantity / ratioOf(product, line.productId));
        } else {
          const multiplier = line.barcode === undefined ? null : positive(product.barcode.find((entry) => entry.value === line.barcode)?.qtLoad);
          add(line.productId, line.quantity * (multiplier ?? 1));
        }
      } else {
        if (product.bundleProducts.length > 0) {
          expand(product, line.unit === 'sale' ? line.quantity : line.quantity * ratioOf(product, line.productId), new Set([line.productId]), 0);
        }
        for (const selection of line.modularSelections ?? []) {
          move({ productId: selection.productId, quantity: selection.quantity, unit: 'sale' });
        }
      }
    }
  };
  for (const line of lines) {
    move(line);
  }
  const deltas = new Map<string, number>();
  for (const [productId, amount] of raw) {
    const rounded = roundStock(amount);
    if (rounded !== 0) {
      deltas.set(productId, rounded);
    }
  }
  return { deltas, anomalies: [...anomalies.values()] };
}
