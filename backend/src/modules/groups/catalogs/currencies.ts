import { object, optional, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import type { ContainerChange } from './catalog.ts';
import { isRecord, textOf } from './kit.ts';

/** Most currencies a group may have. */
export const MAX_CURRENCIES = 10;

/**
 * The symbols the legacy stores as HTML entities, with the character the API shows. Only a symbol that is exactly one of these is converted,
 * in both directions; any other symbol (`$`, `CHF`, an entity not listed) is stored and shown as it is. The entity written is the first one of the pair.
 */
export const CURRENCY_SYMBOLS: ReadonlyArray<readonly [entity: string, character: string]> = Object.freeze([
  ['&euro;', '€'],
  ['&pound;', '£'],
  ['&yen;', '¥'],
  ['&cent;', '¢'],
  ['&curren;', '¤'],
  ['&#8377;', '₹'],
  ['&#8381;', '₽'],
  ['&#8364;', '€'],
]);

/**
 * The symbol as the API shows it: the character for a known entity, the stored text otherwise.
 *
 * @param stored The symbol as the legacy stores it.
 * @returns The symbol shown by the API.
 */
export function symbolFromLegacy(stored: string): string {
  return CURRENCY_SYMBOLS.find(([entity]) => entity === stored)?.[1] ?? stored;
}

/**
 * The symbol as the legacy stores it: the entity for a known character, the text otherwise.
 *
 * @param symbol The symbol as the API shows it.
 * @returns The symbol as the legacy stores it.
 */
export function symbolToLegacy(symbol: string): string {
  return CURRENCY_SYMBOLS.find(([, character]) => character === symbol)?.[0] ?? symbol;
}

/** A currency of a group (legacy `currencies.<code>`, a map keyed by the ISO 4217 code: `{ code, symbol }`). The symbol is shown as a character (`€`), not as the stored entity (`&euro;`). */
export interface Currency {
  readonly code: string;
  readonly symbol: string;
}

const symbolSchema = string({ min: 1, max: 8, trim: true, pattern: /^[^<>&"'\u0000-\u001F\u007F-\u009F]+$/ });

/** Body of the creation of a currency: its three-letter ISO 4217 code (syntax only, the registry is not checked) and its symbol. */
export const createCurrencyBody = object({ code: string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }), symbol: symbolSchema });

/** Body of the modification of a currency (JSON Merge Patch): the symbol; the code is the id. */
export const patchCurrencyBody = object({ symbol: optional(symbolSchema) });

type CreateBody = Infer<typeof createCurrencyBody>;
type PatchBody = Infer<typeof patchCurrencyBody>;

/** The loyalty rule a new currency starts with: no point value, no discount. */
const emptyRule = (code: string): Record<string, unknown> => ({ code, value: null, discountPercentage: null });

/**
 * The currencies (`/currencies`, the id is the code). Creating a currency also creates its loyalty rule (`fidelityCardRules.<code>`, both values `null`)
 * and deleting it removes the rule, in the same write.
 */
export const currencies = defineCatalog<Currency, CreateBody, PatchBody>({
  name: 'currency',
  segment: 'currencies',
  path: 'currencies',
  kind: 'map',
  limit: MAX_CURRENCIES,
  extraPaths: ['fidelityCardRules'],
  idKey: 'code',
  readPermission: 'groups:read',
  updatePermission: 'groups:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createCurrencyBody,
  patchSchema: patchCurrencyBody,
  idOf: (body) => body.code,
  toElement: (id, raw) => ({ code: id, symbol: symbolFromLegacy(textOf(raw['symbol']) ?? '') }),
  defaults: (id) => ({ code: id, symbol: '' }),
  toRaw: (element, raw) => ({ ...raw, code: element.code, symbol: symbolToLegacy(element.symbol) }),
  extra: (op, before, after, state): ContainerChange[] => {
    const stored = state.raw('fidelityCardRules');
    const rules = isRecord(stored) ? stored : {};
    if (op === 'create') {
      const code = after!.code;
      return [{ path: 'fidelityCardRules', kind: 'map', old: stored, next: { ...rules, [code]: rules[code] ?? emptyRule(code) } }];
    }
    if (op === 'remove') {
      const { [before!.code]: _removed, ...rest } = rules;
      return [{ path: 'fidelityCardRules', kind: 'map', old: stored, next: rest }];
    }
    return [];
  },
});
