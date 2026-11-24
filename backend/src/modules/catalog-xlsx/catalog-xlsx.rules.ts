/**
 * The rules that recognize what a cell of the catalog workbook means: the ones of the legacy XLSX import (`ms-products-service`, `importXLSX`), written down one by one. Where the legacy tried an id and then a
 * name, so does this; what the legacy dropped in silence (a category, a price list or a tax rate it did not find) is a problem here.
 */

/** The result of recognizing a reference: found, not found, or more than one candidate (never guessed). */
export type Recognized<T> = { readonly kind: 'found'; readonly value: T } | { readonly kind: 'none' } | { readonly kind: 'ambiguous' };

/** Something that is named: a category, a price list. */
export interface Named {
  readonly id: string;
  readonly name: string;
}

/**
 * A reference that may be an id or a name (categories, parent, categories of modifiers, price lists): **first the id** (the whole text, compared exactly, after the trim), **then the name** (compared exactly:
 * case, inner spaces and accents count; the stored name is trimmed). A name two entries have is `ambiguous`: the legacy took the first one, silently.
 *
 * @param token The text of the cell (one reference).
 * @param items What can be referred to.
 */
export function recognizeByIdOrName<T extends Named>(token: string, items: readonly T[]): Recognized<T> {
  const wanted = token.trim();
  const byId = items.find((item) => item.id === wanted);
  if (byId !== undefined) {
    return { kind: 'found', value: byId };
  }
  const byName = items.filter((item) => item.name === wanted);
  return byName.length === 0 ? { kind: 'none' } : byName.length === 1 ? { kind: 'found', value: byName[0]! } : { kind: 'ambiguous' };
}

/** A tax rate of the group, as the recognition needs it. */
export interface RateOption {
  readonly id: string;
  readonly rate: number;
}

/** A percentage written in a cell: digits with an optional decimal part, a point or a comma as the separator. */
const DECIMAL = /^\d{1,9}([.,]\d{1,8})?$/;

/** The number a cell holds (`12`, `12.5`, `12,5`), `null` for anything else. */
export function decimalOf(token: string): number | null {
  const text = token.trim();
  return DECIMAL.test(text) ? Number(text.replace(',', '.')) : null;
}

/**
 * A tax rate: **first the id** (exact), **then the percentage** (`22`, `22,5`): the legacy took the first rate with that value, here two rates with the same value are `ambiguous` unless the price already has one of them
 * (`current`: the rate the price being updated has now), which is then kept.
 *
 * @param token The text of the cell.
 * @param rates The rates of the group.
 * @param current The id of the rate the price has now, `null` for a new price.
 */
export function recognizeRate(token: string, rates: readonly RateOption[], current: string | null): Recognized<RateOption> {
  const wanted = token.trim();
  const byId = rates.find((rate) => rate.id === wanted);
  if (byId !== undefined) {
    return { kind: 'found', value: byId };
  }
  const value = decimalOf(wanted);
  const byValue = value === null ? [] : rates.filter((rate) => rate.rate === value);
  const kept = byValue.find((rate) => rate.id === current);
  return kept !== undefined ? { kind: 'found', value: kept } : byValue.length === 0 ? { kind: 'none' } : byValue.length === 1 ? { kind: 'found', value: byValue[0]! } : { kind: 'ambiguous' };
}

/** The twelve colors of the palette of the legacy import (`getColor`), by number from 1. */
export const PALETTE: readonly string[] = Object.freeze(['#ff8064', '#ffbf77', '#c69aff', '#f7bed3', '#ff7c9f', '#a2624e', '#c6a599', '#ac9879', '#b0b279', '#91bcb4', '#407674', '#5c98b1']);

/**
 * A color: a number from 1 to 12 (the palette) or a hexadecimal `#rrggbb`. The legacy accepted any text as a color (a bug: its check read the wrong variable): anything else is `invalid` here.
 *
 * @param token The text of the cell.
 * @returns The color in lower case, `''` for an empty cell, `null` when it is not a color.
 */
export function recognizeColor(token: string): string | null {
  const text = token.trim();
  if (text === '') {
    return '';
  }
  if (/^\d{1,2}$/.test(text)) {
    return PALETTE[Number(text) - 1] ?? null;
  }
  return /^#[0-9A-Fa-f]{6}$/.test(text) ? text.toLowerCase() : null;
}

/** The text of a flag: `X` (any case) is on, an empty cell is off; the legacy took any text for on, here any other text is `null` (invalid). */
export function recognizeFlag(token: string): boolean | null {
  const text = token.trim();
  return text === '' ? false : /^x$/i.test(text) ? true : null;
}

/** A whole number of a cell (a position): digits only, up to a billion. */
export function recognizeWhole(token: string): number | null {
  const text = token.trim();
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/**
 * The values of a cell that holds several references, separated by `|`: each trimmed, the empty ones left out (the legacy did the same: an empty reference found nothing and was dropped).
 *
 * @param cell The text of the cell.
 */
export function referencesOf(cell: string): string[] {
  return cell
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The type of variant of the legacy codes (`pm`, `p`, `m`, `i`), by the name of the API. A `Map`: a text of the file such as `constructor` is never a key of it. */
export const VARIANT_TYPES: ReadonlyMap<string, 'addRemove' | 'add' | 'remove' | 'info'> = new Map([
  ['pm', 'addRemove'],
  ['p', 'add'],
  ['m', 'remove'],
  ['i', 'info'],
]);

/** The type of scale: `w` is by weight, `p` by piece (the legacy took any text but `w` for piece). `''` for an empty cell, `null` when it is neither. */
export function recognizeScaleType(token: string): 'weight' | 'piece' | '' | null {
  const text = token.trim().toLowerCase();
  return text === '' ? '' : text === 'w' ? 'weight' : text === 'p' ? 'piece' : null;
}
