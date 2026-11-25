import { numberOrNull, textOrNull } from '../groups/catalogs/catalog-fields';
import { CardType } from '../groups/catalogs/catalog.types';
import { FIDELITY_CARD_LIMITS, FidelityCard } from './fidelity-card.types';

/** A customer chosen for a new card. */
export interface CustomerChoice {
  id: string;
  name: string;
}

/** The points a new card starts with on one collection of its type. */
export interface InitialPoints {
  collectionId: string;
  name: string;
  points: string;
}

/** The form of a card. */
export interface CardModel {
  code: string;
  cardTypeId: string;
  enabled: boolean;
  /** Only for a new card of a prepaid type. */
  initialBalance: string;
  /** Only for a new card of a type that collects points: one row for each collection of the type. */
  initialPoints: InitialPoints[];
  /** Only for a new card. */
  customers: CustomerChoice[];
}

/**
 * The form of a card.
 *
 * @param item The card as the server has it; `null` for a new one (active, nothing else).
 */
export function toModel(item: FidelityCard | null): CardModel {
  return {
    code: item?.code ?? '',
    cardTypeId: item?.cardTypeId ?? '',
    enabled: item?.enabled ?? true,
    initialBalance: '',
    initialPoints: [],
    customers: [],
  };
}

/** Control characters, refused in a code. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/** The issue of the code of a new card: required, at most 64 characters, one line, never only dots, no `|`. */
export function codeIssue(
  text: string,
): 'required' | 'maxLength' | 'pattern' | 'format' | 'pipe' | undefined {
  const value = text.trim();
  if (value === '') {
    return 'required';
  }
  if (value.length > FIDELITY_CARD_LIMITS.code) {
    return 'maxLength';
  }
  if (value.includes('|')) {
    return 'pipe';
  }
  if (CONTROL.test(value)) {
    return 'pattern';
  }
  return /^\.+$/.test(value) ? 'format' : undefined;
}

/** The issue of an initial credit: empty, or a number above zero with a dot and two decimals at most, up to a million. */
export function balanceIssue(text: string): 'type' | 'incorrect' | 'maximum' | undefined {
  const value = text.trim();
  if (value === '') {
    return undefined;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return 'type';
  }
  const number = Number(value);
  if (number === 0) {
    return 'incorrect';
  }
  return number > FIDELITY_CARD_LIMITS.amount ? 'maximum' : undefined;
}

/** The issue of initial points: empty, or a whole number from 1 to a million. */
export function pointsIssue(text: string): 'type' | 'incorrect' | 'maximum' | undefined {
  const value = text.trim();
  if (value === '') {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return 'type';
  }
  const number = Number(value);
  if (number === 0) {
    return 'incorrect';
  }
  return number > FIDELITY_CARD_LIMITS.points ? 'maximum' : undefined;
}

/** The rows of initial points a type allows: one for each collection of the type that exists (with its name). */
export function initialRows(
  type: CardType | undefined,
  names: ReadonlyMap<string, string>,
): InitialPoints[] {
  if (type === undefined || !type.pointsCollect.enabled) {
    return [];
  }
  return type.pointsCollect.collectionIds
    .filter((id) => names.has(id))
    .map((id) => ({ collectionId: id, name: names.get(id) as string, points: '' }));
}

/**
 * The body of a creation: the code, the type and the state, and only what the type allows (the
 * credit of a prepaid type, the points of the collections of a type that collects them) and the
 * customers chosen.
 *
 * @param model The form.
 * @param type The type chosen.
 */
export function createBody(model: CardModel, type: CardType | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    code: model.code.trim(),
    cardTypeId: model.cardTypeId,
    enabled: model.enabled,
  };
  const balance = numberOrNull(model.initialBalance);
  if (type?.prepaid.enabled === true && balance !== null) {
    body['initialBalance'] = balance;
  }
  const points = model.initialPoints
    .filter((row) => textOrNull(row.points) !== null)
    .map((row) => ({ collectionId: row.collectionId, points: Number(row.points) }));
  if (type?.pointsCollect.enabled === true && points.length > 0) {
    body['initialPoints'] = points;
  }
  if (model.customers.length > 0) {
    body['contactIds'] = model.customers.map((customer) => customer.id);
  }
  return body;
}

/** The body of a modification: the type and the state, when they changed (empty when nothing did). */
export function patchBody(model: CardModel, before: CardModel): Record<string, unknown> {
  return {
    ...(model.cardTypeId === before.cardTypeId ? {} : { cardTypeId: model.cardTypeId }),
    ...(model.enabled === before.enabled ? {} : { enabled: model.enabled }),
  };
}

/** Whether a new card's form differs from the empty one. */
export function modelChanged(model: CardModel, original: CardModel): boolean {
  return JSON.stringify(model) !== JSON.stringify(original);
}
