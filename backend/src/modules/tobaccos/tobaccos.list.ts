import type { ListConfig } from '../../shared/http/list.ts';
import { FIRST_BARCODE } from './tobaccos.mapper.ts';

/** Largest page of the price list. */
export const MAX_TOBACCOS_PAGE = 100;

/**
 * How the price list is sorted and searched, as the legacy table: by code, name, category, price per kilogram, price and first barcode. By code by default; `q` is looked for in the name and in the
 * code, case-insensitive, as literal text. A product without the sorted value (the legacy stored `null`) sorts first ascending.
 */
export const TOBACCOS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    code: Object.freeze({ field: 'code', kind: 'string' as const }),
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
    category: Object.freeze({ field: 'category', kind: 'string' as const }),
    priceKg: Object.freeze({ field: 'priceKg', kind: 'number' as const }),
    price: Object.freeze({ field: 'price', kind: 'number' as const }),
    barcode: Object.freeze({ field: 'barcodes', kind: 'string' as const, expression: FIRST_BARCODE }),
  }),
  defaultSort: 'code',
  searchFields: Object.freeze(['name', 'code']),
});
