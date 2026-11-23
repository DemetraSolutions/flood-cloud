import type { ClientSession, Document, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { usableRate } from './products.pricing.ts';

/** Most products one block of the realignment of a tax rate writes. */
export const TAX_BLOCK_SIZE = 100;

/** Most blocks one realignment runs (twenty thousand products): a group with more is refused, not left half done. */
export const MAX_TAX_BLOCKS = 200;

/** Time limit of the read and of the write of one block, in milliseconds. */
export const TAX_BLOCK_MAX_TIME_MS = 30_000;

/** Most products reported as users of a tax rate (a refused deletion lists at most these). */
export const MAX_REPORTED_TAX_PRODUCTS = 20;

/** The products, as the tax rates of the group see them: the prices of a product hold a copy of the tax rate they were given. */
export interface TaxProducts {
  /**
   * The ids of the products, not in the trash, that have a price with a tax rate of the group.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param taxId Id of the tax rate.
   * @returns At most {@link MAX_REPORTED_TAX_PRODUCTS} products, hexadecimal.
   */
  usedBy(principal: AuthPrincipal, access: GroupAccess, taxId: string): Promise<string[]>;
  /**
   * Makes the copy of a tax rate in the prices that hold it equal to the rate (`tax` and the five keys of `taxData`, no other key of a price), and the date of the change of the products it touches new. When the
   * percentage changes, the gross price (`taxed`) stays fixed and the net one (`price`) is computed again, to eight decimals; a price whose gross amount is not a number keeps its net one. It writes only the products
   * that differ, a block at a time, so repeating it changes nothing: that is what makes the operation safe to repeat when the two databases cannot be written together.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param copy The tax rate in the stored form (`{ id, value, department, description, natura }`).
   * @param now The new date of the change.
   * @param session The transaction to write in, when there is one.
   * @returns Whether every product was realigned and, if not, how many blocks are left (only without a transaction: repeating the call goes on). A rate that is not usable (`NaN`, infinite, `-100` or less) is skipped, and the result says so (`skipped`, not complete).
   * @throws {AppError} `CONFLICT` (`products`/`tooMany`) when, inside a transaction, the group has more products to realign than {@link MAX_TAX_BLOCKS} blocks hold (the whole write is then undone).
   */
  realign(principal: AuthPrincipal, access: GroupAccess, copy: Document, now: Date, session?: ClientSession): Promise<Realignment>;
}

/** How far a realignment went. */
export interface Realignment {
  readonly complete: boolean;
  /** `true` when the prices were not realigned because the rate cannot be used (not finite, or -100 or less): the prices keep their copy. */
  readonly skipped?: true;
  /** How many blocks of products are left to realign; `null` when it is not known (the realignment failed). */
  readonly remainingBlocks: number | null;
}

/** Sets keys of an object in an aggregation expression, one `$setField` after the other (every other key stays). Every value that comes from the data is a `$literal` (a text that starts with `$` is a text, not a path); only an entry marked as an expression is one. */
function withFields(input: unknown, entries: ReadonlyArray<readonly [field: string, value: unknown, expression?: true]>): unknown {
  return entries.reduce<unknown>((current, [field, value, expression]) => ({ $setField: { field, input: current, value: expression === true ? value : { $literal: value } } }), input);
}

/**
 * The update that realigns the copy of a tax rate in the prices of a product: one pipeline stage that maps the prices, so every other key of a price and of the product stays, and no price is read and
 * written back by this process.
 */
function realignment(copy: Document, now: Date): Document[] {
  const rate = copy['value'] as number;
  const grossIsNumber = { $and: [{ $isNumber: '$$price.taxed' }, { $gte: ['$$price.taxed', -Number.MAX_VALUE] }, { $lte: ['$$price.taxed', Number.MAX_VALUE] }] };
  const net = { $cond: [{ $and: [{ $ne: ['$$price.taxData.value', { $literal: rate }] }, grossIsNumber] }, { $round: [{ $divide: ['$$price.taxed', { $literal: 1 + rate / 100 }] }, 8] }, '$$price.price'] };
  const taxData = withFields('$$price.taxData', [['id', copy['id']], ['value', rate], ['department', copy['department']], ['description', copy['description']], ['natura', copy['natura']]]);
  return [
    {
      $set: {
        prices: { $map: { input: '$prices', as: 'price', in: { $cond: [{ $eq: ['$$price.taxData.id', { $literal: copy['id'] }] }, withFields('$$price', [['tax', rate], ['taxData', taxData, true], ['price', net, true]]), '$$price'] } } },
        updateDate: now,
      },
    },
  ];
}

/** How the realignment is cut into blocks: how many products one block writes, and how many blocks one realignment runs. */
export interface TaxBlocks {
  readonly size: number;
  readonly max: number;
}

/**
 * Builds the port the tax rates of the group use to keep the prices of the products consistent.
 *
 * @param databases Database accessor.
 * @param blocks The size and the number of the blocks of a realignment ({@link TAX_BLOCK_SIZE} and {@link MAX_TAX_BLOCKS} by default).
 */
export function createTaxProducts(databases: Databases, blocks: TaxBlocks = { size: TAX_BLOCK_SIZE, max: MAX_TAX_BLOCKS }): TaxProducts {
  const products = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('products');
  return {
    usedBy: async (principal, access, taxId) => {
      const found = await bounded(() => products(principal, access).find({ trash: { $ne: true }, 'prices.taxData.id': taxId }, { projection: { _id: 1 }, limit: MAX_REPORTED_TAX_PRODUCTS, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      return found.map((product) => (product['_id'] as ObjectId).toHexString());
    },

    realign: async (principal, access, copy, now, session) => {
      if (!usableRate(copy['value'])) {
        return { complete: false, skipped: true, remainingBlocks: 0 };
      }
      // A comparison by value, not by type: a rate stored as an integer and the same rate as a double are the same rate.
      // Exactly what the pipeline can correct: a price whose `taxData` is an object (not a list) with an `id` that is a text (not a list) equal to the rate; the other shapes of the legacy are left alone.
      const differs = { prices: { $elemMatch: { taxData: { $type: 'object', $not: { $type: 'array' } }, 'taxData.id': { $eq: copy['id'], $not: { $type: 'array' } }, $or: [{ tax: { $ne: copy['value'] } }, ...['value', 'department', 'description', 'natura'].map((key) => ({ [`taxData.${key}`]: { $ne: copy[key] } }))] } } };
      const options = { maxTimeMS: TAX_BLOCK_MAX_TIME_MS, ...(session === undefined ? {} : { session }) };
      for (let block = 0; block < blocks.max; block += 1) {
        const ids = (await bounded(() => products(principal, access).find(differs, { projection: { _id: 1 }, limit: blocks.size, ...options }).toArray())).map((product) => product['_id'] as ObjectId);
        if (ids.length === 0) {
          return { complete: true, remainingBlocks: 0 };
        }
        await bounded(() => products(principal, access).updateMany({ _id: { $in: ids } }, realignment(copy, now), options));
      }
      if (session !== undefined) {
        throw new AppError('CONFLICT', { details: [{ field: 'products', issue: 'tooMany' }] });
      }
      // Without a transaction the rate is already written: say how much is left, a repeated request goes on.
      const left = await bounded(() => products(principal, access).countDocuments(differs, { limit: blocks.size * MAX_TAX_BLOCKS, maxTimeMS: TAX_BLOCK_MAX_TIME_MS }));
      return { complete: left === 0, remainingBlocks: Math.ceil(left / blocks.size) };
    },
  };
}
