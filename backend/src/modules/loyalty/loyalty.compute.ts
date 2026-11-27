import type { ObjectId } from 'mongodb';

/** Most lines of a sale the calculation takes: more is a programming error of the caller (who validates its input), never an anomaly. */
export const MAX_LOYALTY_LINES = 500;

/** The prefixes of the codes of the lines that load a prepaid card instead of selling something: the refills. */
const REFILL_PREFIXES = Object.freeze({ multi: '000-r-multi', mono: '000-r-mono' });

/**
 * Whether the code of a line is the one of a refill of a prepaid card (`000-r-multi…`, `000-r-mono…`).
 *
 * @param code The code of the line.
 */
export function isRefillCode(code: string): boolean {
  return code.startsWith(REFILL_PREFIXES.multi) || code.startsWith(REFILL_PREFIXES.mono);
}

/** What was found wrong while working out or applying the effects of a sale: never an error, the sale of the point of sale is always accepted (decision 13 of step VS) and the backoffice shows these. */
export type LoyaltyAnomalyCode =
  /** The advanced card is not active: the credit and the refills still apply (the till did it), no points are given. */
  | 'cardInactive'
  /** The card has a type the group no longer has. */
  | 'cardTypeMissing'
  /** The type of the card is disabled. */
  | 'cardTypeDisabled'
  /** Credit was used or loaded on a card whose type is not prepaid. */
  | 'notPrepaid'
  /** The type of the card is limited to some points of sale and this is not one of them. */
  | 'placeNotAllowed'
  /** The refills of the sale are of both kinds, or of a kind other than the one of the type of the card. */
  | 'refillMismatch'
  /** The group has no loyalty rule for the currency of the sale (or it is not a positive number): a simple card gets no points. */
  | 'simpleRuleMissing'
  /** No advanced card of the group has the code of the sale and it could not be looked for (more than one card matches the code). */
  | 'cardAmbiguous'
  /** The advanced card to update is gone (or its credit or points are not numbers): that part is not applied. */
  | 'cardNotFound'
  /** After the sale the credit of the card is below zero (a sale may do it, a manual adjustment may not). */
  | 'negativeBalance'
  /** After the sale the points of a collection (or of a simple card) are below zero. */
  | 'negativePoints'
  /** No contact has the simple card of the sale. */
  | 'simpleCardNotFound'
  /** More than one contact has the simple card of the sale and none is its customer. */
  | 'simpleCardAmbiguous'
  /** The advanced card of a sale of the legacy did not exist yet at the date of the sale (or its creation date is not known): no effect is assumed for it. */
  | 'legacyCardAfterSale';

/** An anomaly, with the collection it is about when there is one. */
export interface LoyaltyAnomaly {
  readonly code: LoyaltyAnomalyCode;
  /** The points collection a `negativePoints` is about; absent for a simple card. */
  readonly collectionId?: string;
}

/** The facts of a sale the effects depend on. The caller (the sale service) reads them from the sale it works out; none comes from a client except what the till says about the sale itself. */
export interface SaleFacts {
  /** The point of sale. */
  readonly placeId: ObjectId;
  /** The date of the sale (never "now": a sale that arrives late from an offline till is worked out as of its date). */
  readonly date: Date;
  /** What the customer paid, the credit of the card included. */
  readonly finalTotalCheckout: number;
  /** The credit of the card used to pay (`paymentDiscountAmount`). */
  readonly creditUsed: number;
  /** The lines: only the code, the price with taxes and the quantity count here. */
  readonly lines: readonly { readonly code: string; readonly taxedPrice: number; readonly quantity: number }[];
}

/** A card type in the shape of the legacy (`fidelity.cardsTypes[]`), with the ids of the places as `ObjectId`. */
export interface LegacyCardType {
  readonly status: boolean;
  readonly prepaid: { readonly status: boolean; readonly type: 'mono' | 'multi' | null };
  readonly pointsCollect: { readonly status: boolean; readonly collectionIds: readonly string[] };
  /** The points of sale the type is limited to; empty for all of them. */
  readonly placesAvailability: readonly ObjectId[];
}

/** A points collection in the shape of the legacy (`fidelity.pointsCollections[]`). */
export interface LegacyPointsCollection {
  readonly id: string;
  readonly status: boolean;
  /** The amount of money for one point. */
  readonly pointConversion: number | null;
  /** The least base for the sale to give points; absent or `null` means none. */
  readonly minAmount?: number | null;
  readonly dateFrom?: Date | null;
  readonly dateTo?: Date | null;
  readonly pointsExpirationDate?: Date | null;
}

/** The card of a sale: an advanced one (read from `fidelity_cards` with its type and the collections of the group) or a simple one (a code on a contact, with the rule of the currency). */
export type SaleCard =
  | {
      readonly kind: 'advanced';
      readonly card: { readonly id: ObjectId; readonly code: string; readonly status: boolean; readonly cardTypeId: string | null; readonly insertDate?: Date | null };
      /** The type of the card, `null` when the group no longer has it. */
      readonly cardType: LegacyCardType | null;
      readonly collections: readonly LegacyPointsCollection[];
    }
  | { readonly kind: 'simple'; readonly code: string; /** `groups.fidelityCardRules.<currency>.value`: the amount of money for one point. */ readonly ruleValue: number | null };

/** What a sale does to an advanced card: the credit (with its sign) and the points by collection. */
export interface AdvancedEffect {
  readonly cardId: ObjectId;
  readonly code: string;
  /** The credit: loaded by the refills minus the credit used, with the sign of the effect on the card. */
  readonly balance: number;
  /** The points by collection id, each a whole number. */
  readonly points: Readonly<Record<string, number>>;
}

/** What a sale does to a simple card: the points. */
export interface SimpleEffect {
  readonly code: string;
  readonly points: number;
  /** The contact the points went to, written by the reconciliation only (never by the calculation): a reversal goes back to the same contact. */
  readonly contactId?: ObjectId;
}

/** The effects of a sale on the loyalty cards: at most one card of each kind. It is also what a sale keeps as the state it has applied. */
export interface LoyaltyEffects {
  readonly advanced: AdvancedEffect | null;
  readonly simple: SimpleEffect | null;
}

/** The result of the calculation. */
export interface SaleLoyalty {
  readonly effects: LoyaltyEffects;
  readonly anomalies: LoyaltyAnomaly[];
}

/**
 * The state of a sale the effects are scaled to. A refunded sale carries the share returned (`refundedRatio`) and, for the refill lines returned, how much credit of the refills is taken back (`refillReturned`, cumulative, never above the refills of the sale: the caller
 * caps it); the credit used to pay is not touched by a refund.
 */
export type LoyaltyState = { readonly kind: 'active' } | { readonly kind: 'refunded'; readonly refundedRatio: number; readonly refillReturned?: number } | { readonly kind: 'canceled' };

/** Rounds half away from zero to some decimals, after cleaning the binary noise of the product (`10.004999999999999` is `10.005`). */
function roundTo(value: number, factor: number): number {
  return (Math.sign(value) * Math.round(Number((Math.abs(value) * factor).toPrecision(15)))) / factor + 0;
}

/** Rounds to two decimals (money), also for the values that sit just below the half in binary. */
export function round2(value: number): number {
  return roundTo(value, 100);
}

/** Rounds to six decimals: what removes the noise of a division (`0.3 / 0.1`) before the whole part is taken. */
function round6(value: number): number {
  return roundTo(value, 1e6);
}

/** Whole points of an amount over the price of a point; `0` when the amount is not positive. */
function pointsOf(base: number, conversion: number): number {
  return Math.floor(round6(base / conversion));
}

/** Checks what the caller guaranteed: numbers that are numbers and a bounded number of lines. */
function assertFacts(facts: SaleFacts): void {
  if (facts.lines.length > MAX_LOYALTY_LINES) {
    throw new RangeError(`A sale takes at most ${String(MAX_LOYALTY_LINES)} lines for its loyalty effects`);
  }
  if (!Number.isFinite(facts.finalTotalCheckout) || !Number.isFinite(facts.creditUsed) || !facts.lines.every((line) => Number.isFinite(line.taxedPrice) && Number.isFinite(line.quantity))) {
    throw new RangeError('The amounts of a sale must be finite numbers');
  }
}

/** Whether the sale date is inside the period of a collection: from `dateFrom` to `dateTo` included (a missing end is open) and before the expiration of the points when there is one. */
function collectionOpenAt(collection: LegacyPointsCollection, at: Date): boolean {
  const time = at.getTime();
  return (
    (collection.dateFrom == null || time >= collection.dateFrom.getTime()) &&
    (collection.dateTo == null || time <= collection.dateTo.getTime()) &&
    (collection.pointsExpirationDate == null || time < collection.pointsExpirationDate.getTime())
  );
}

/** The points of an advanced card by collection, as the rules of the server give them. */
function collectedPoints(sale: Extract<SaleCard, { kind: 'advanced' }>, facts: SaleFacts, base: number): Record<string, number> {
  const points: Record<string, number> = {};
  const { card, cardType } = sale;
  const allowed = cardType !== null && cardType.status && cardType.pointsCollect.status && (cardType.placesAvailability.length === 0 || cardType.placesAvailability.some((id) => id.equals(facts.placeId)));
  if (!card.status || !allowed) {
    return points;
  }
  for (const id of cardType.pointsCollect.collectionIds) {
    const collection = sale.collections.find((candidate) => candidate.id === id);
    if (collection?.status === true && typeof collection.pointConversion === 'number' && collection.pointConversion > 0 && (collection.minAmount ?? 0) <= base && collectionOpenAt(collection, facts.date)) {
      const value = pointsOf(base, collection.pointConversion);
      if (value > 0) {
        points[id] = value;
      }
    }
  }
  return points;
}

/** The anomalies of an advanced card: what the sale did that the card or its type does not allow (the facts apply anyway). */
function advancedAnomalies(sale: Extract<SaleCard, { kind: 'advanced' }>, facts: SaleFacts, moved: boolean, kinds: ReadonlySet<'mono' | 'multi'>): LoyaltyAnomaly[] {
  const codes: LoyaltyAnomalyCode[] = [];
  const { card, cardType } = sale;
  if (!card.status) {
    codes.push('cardInactive');
  }
  if (cardType === null) {
    codes.push('cardTypeMissing');
  } else {
    if (!cardType.status) {
      codes.push('cardTypeDisabled');
    }
    if (moved && !cardType.prepaid.status) {
      codes.push('notPrepaid');
    }
    if (cardType.placesAvailability.length > 0 && !cardType.placesAvailability.some((id) => id.equals(facts.placeId))) {
      codes.push('placeNotAllowed');
    }
  }
  const [only] = kinds;
  if (kinds.size > 1 || (only !== undefined && cardType?.prepaid.type != null && cardType.prepaid.type !== only)) {
    codes.push('refillMismatch');
  }
  return codes.map((code) => ({ code }));
}

/**
 * Works out what a sale does to the loyalty card it was paid with (pure: everything is passed in, the caller has read it from the database).
 *
 * The **base** of the points is what the customer really paid for goods: the total minus the credit of the card used to pay and minus the refills, never below zero (a sale never takes points away).
 * The refills are the lines whose code starts with `000-r-multi` or `000-r-mono`; each is worth its taxed price times its quantity, rounded to two decimals.
 *
 * An **advanced** card always gets the facts of the till: the credit changes by the refills minus the credit used, whatever the state of the card, its type or the point of sale (these are reported as anomalies, the till is never refused). The points
 * follow the rules of the server instead: only an active card of an enabled type that collects points and is allowed in the point of sale gets some, for each collection of its type that is enabled, converts (`pointConversion` over zero), has its
 * `minAmount` reached by the base and is open on the date of the sale: the whole part of the base over the conversion. A **simple** card gets the whole part of the base over the value of the rule of the currency.
 *
 * @example
 * // Total 50, credit used 10, refill 20: the base is 20, with one point per euro the card gets 20 points and the credit changes by 20 - 10 = 10.
 *
 * @param facts The facts of the sale.
 * @param card The card of the sale.
 * @returns The effects and the anomalies.
 * @throws {RangeError} When the sale has more than {@link MAX_LOYALTY_LINES} lines or an amount that is not a finite number (a bug of the caller).
 */
export function computeSaleLoyalty(facts: SaleFacts, card: SaleCard): SaleLoyalty {
  assertFacts(facts);
  const kinds = new Set<'mono' | 'multi'>();
  let refill = 0;
  for (const line of facts.lines) {
    const kind = line.code.startsWith(REFILL_PREFIXES.multi) ? 'multi' : line.code.startsWith(REFILL_PREFIXES.mono) ? 'mono' : null;
    if (kind !== null) {
      kinds.add(kind);
      refill += round2(line.taxedPrice * line.quantity);
    }
  }
  refill = round2(refill);
  const base = Math.max(0, round2(facts.finalTotalCheckout - facts.creditUsed - refill));
  if (card.kind === 'simple') {
    const valid = typeof card.ruleValue === 'number' && card.ruleValue > 0;
    return {
      effects: { advanced: null, simple: { code: card.code, points: valid ? pointsOf(base, card.ruleValue) : 0 } },
      anomalies: valid ? [] : [{ code: 'simpleRuleMissing' }],
    };
  }
  return {
    effects: { advanced: { cardId: card.card.id, code: card.card.code, balance: round2(refill - facts.creditUsed), points: collectedPoints(card, facts, base) }, simple: null },
    anomalies: advancedAnomalies(card, facts, facts.creditUsed !== 0 || refill !== 0, kinds),
  };
}

/**
 * Scales the effects of a sale to its state: what the sale does to the cards now. An active sale does all of it; a refunded one keeps the credit used, takes back the credit of the refill lines returned (`refillReturned`) and removes the points in proportion to what was returned (the whole part
 * of what is left, so a refund of 30% of 7 points leaves 4); a canceled one does nothing, which reverses everything, the refills included.
 *
 * @param full The effects of the whole sale ({@link computeSaleLoyalty}).
 * @param state The state of the sale; for a refund, `refundedRatio` is the cumulative share returned, from 0 to 1.
 * @returns The effects to apply, `null` for a canceled sale.
 * @throws {RangeError} When the ratio of a refund is not a number from 0 to 1.
 */
export function scaleForState(full: LoyaltyEffects, state: LoyaltyState): LoyaltyEffects | null {
  if (state.kind === 'active') {
    return full;
  }
  if (state.kind === 'canceled') {
    return null;
  }
  const ratio = state.refundedRatio;
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new RangeError('The refunded ratio of a sale must be a number from 0 to 1');
  }
  const kept = (points: number): number => Math.floor(round6(points * (1 - ratio)));
  return {
    advanced: full.advanced === null ? null : { ...full.advanced, balance: round2(full.advanced.balance - (state.refillReturned ?? 0)), points: Object.fromEntries(Object.entries(full.advanced.points).map(([id, points]) => [id, kept(points)])) },
    simple: full.simple === null ? null : { ...full.simple, points: kept(full.simple.points) },
  };
}

/**
 * Works out what the **legacy** did to the loyalty card of a sale it wrote, with the legacy formulas, to adopt the sale (step VS4a): never more than the legacy charged or gave. A simple card got `floor(total / rule)` on the gross total of the sale. An advanced card of a prepaid
 * type allowed in the point of sale had its credit moved by the refills minus the credit used (as stored in the lines, every line counted); one whose type collects points got, for each enabled collection of the type that converts, whose minimum the gross total reaches and that is
 * open on the date of the sale, `floor(total / pointConversion)`. The card status is not looked at (the legacy did not). A card that did not exist at the date of the sale (or has no creation date) gets nothing and `legacyCardAfterSale`.
 *
 * @param facts The facts of the sale, with the codes of the lines as stored.
 * @param card The card of the sale.
 * @returns The effects and the anomalies.
 */
export function computeLegacySaleLoyalty(facts: SaleFacts, card: SaleCard): SaleLoyalty {
  assertFacts(facts);
  if (card.kind === 'simple') {
    const valid = typeof card.ruleValue === 'number' && card.ruleValue > 0;
    return { effects: { advanced: null, simple: { code: card.code, points: valid ? pointsOf(facts.finalTotalCheckout, card.ruleValue) : 0 } }, anomalies: valid ? [] : [{ code: 'simpleRuleMissing' }] };
  }
  const { card: held, cardType } = card;
  if (!(held.insertDate instanceof Date) || held.insertDate.getTime() > facts.date.getTime()) {
    return { effects: { advanced: null, simple: null }, anomalies: [{ code: 'legacyCardAfterSale' }] };
  }
  const usable = cardType !== null && (cardType.placesAvailability.length === 0 || cardType.placesAvailability.some((id) => id.equals(facts.placeId))) ? cardType : null;
  const refill = round2(facts.lines.reduce((sum, line) => (isRefillCode(line.code) ? sum + round2(line.taxedPrice * line.quantity) : sum), 0));
  const points: Record<string, number> = {};
  if (usable !== null && usable.pointsCollect.status) {
    for (const id of usable.pointsCollect.collectionIds) {
      const collection = card.collections.find((candidate) => candidate.id === id);
      const value = typeof collection?.pointConversion === 'number' && collection.pointConversion > 0 ? pointsOf(facts.finalTotalCheckout, collection.pointConversion) : 0;
      if (collection?.status === true && value > 0 && (collection.minAmount ?? 0) <= facts.finalTotalCheckout && collectionOpenAt(collection, facts.date)) {
        points[id] = value;
      }
    }
  }
  const balance = usable !== null && usable.prepaid.status ? round2(refill - facts.creditUsed) : 0;
  return { effects: { advanced: { cardId: held.id, code: held.code, balance, points }, simple: null }, anomalies: [] };
}
