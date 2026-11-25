import type { Document, ObjectId } from 'mongodb';
import { FIDELITY_CARDS_OWNED_FIELDS } from '../../db/collections.ts';
import type { CardType } from '../groups/catalogs/card-types.ts';
import { dateOf, flagOf, isRecord, numberOf, textOf } from '../groups/catalogs/kit.ts';
import type { PointsCollection } from '../groups/catalogs/points-collections.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';

/** The fields the version of a card covers: the credit and the points are moved by the sales and the adjustments and never change it. */
export const CARD_VERSION_FIELDS: readonly string[] = Object.freeze(['code', 'cardTypeId', 'status']);

/** The card type of a card as the API shows it. */
export interface CardTypeView {
  readonly id: string;
  readonly name: string | null;
  readonly enabled: boolean;
  /** Whether the cards of the type have a credit. */
  readonly prepaid: boolean;
  /** Whether the cards of the type collect points. */
  readonly pointsCollect: boolean;
}

/** The points a card has on one points collection of the group. */
export interface CardPoints {
  readonly collectionId: string;
  readonly name: string | null;
  readonly points: number;
  /** Whether the collection is enabled, inside its period and not past the expiration of its points: only the points of an active collection count in `totalPoints`. */
  readonly active: boolean;
}

/**
 * What a contact shows of an advanced card. A caller who may not read the loyalty cards (no `fidelity:read`) is told only that the code is an advanced card: the object is there and every field of it is `null`.
 */
export interface AdvancedCard {
  readonly cardId: string | null;
  readonly cardType: { readonly id: string; readonly name: string | null } | null;
  readonly enabled: boolean | null;
  readonly balance: number | null;
  readonly totalPoints: number | null;
}

/** What a contact shows of an advanced card to a caller who may not read the cards: that it is one, and nothing of it. */
export const HIDDEN_ADVANCED_CARD: AdvancedCard = Object.freeze({ cardId: null, cardType: null, enabled: null, balance: null, totalPoints: null });

/** A card as the detail shows it. */
export interface CardView {
  readonly id: string;
  readonly code: string;
  readonly cardTypeId: string | null;
  readonly cardType: CardTypeView | null;
  readonly enabled: boolean;
  /** The credit, in units of currency with two decimals; `null` when the stored value is not a number. The client shows it only for a prepaid type. */
  readonly balance: number | null;
  readonly points: readonly CardPoints[];
  readonly totalPoints: number;
  /** The contacts, not in the trash, that have the code: at most 20, only their name. */
  readonly contacts: readonly { readonly id: string; readonly displayName: string | null }[];
  readonly contactsCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A row of the list of the cards. */
export interface CardRow {
  readonly id: string;
  readonly code: string;
  readonly cardType: { readonly id: string; readonly name: string | null } | null;
  readonly enabled: boolean;
  readonly balance: number | null;
  readonly totalPoints: number;
  readonly contact: { readonly id: string; readonly displayName: string | null } | null;
  readonly contactsCount: number;
  readonly createdAt: string | null;
}

/** The credit of a stored card with two decimals, `null` when it is not a number. */
export function cardBalance(raw: unknown): number | null {
  const value = numberOf(raw);
  return value === null ? null : Math.round(value * 100) / 100;
}

/**
 * Whether a points collection gives points now, as the POS judges it: enabled, started (`dateFrom`), not ended (`dateTo`) and not past the expiration of its points (`pointsExpirationDate`). A date that is not one is no limit.
 *
 * @param collection The points collection of the group.
 * @param now The instant, in epoch milliseconds.
 */
export function isCollectionActive(collection: PointsCollection, now: number): boolean {
  const before = (iso: string | null): boolean => iso !== null && Date.parse(iso) > now;
  const past = (iso: string | null): boolean => iso !== null && Date.parse(iso) < now;
  return collection.enabled && !before(collection.dateFrom) && !past(collection.dateTo) && !past(collection.pointsExpirationDate);
}

/**
 * The points of a stored card on the collections of the group: one entry for every key of `pointsCollections` that is a collection of the group (a number; `0` when it is not one), and the sum of the active ones. The keys that are
 * no collection of the group are ignored (and kept in the document).
 *
 * @param document The stored card.
 * @param collections The points collections of the group.
 * @param now The instant, in epoch milliseconds.
 */
export function cardPoints(document: Document, collections: readonly PointsCollection[], now: number): { readonly points: CardPoints[]; readonly totalPoints: number } {
  const stored = isRecord(document['pointsCollections']) ? document['pointsCollections'] : {};
  const points = collections.flatMap((collection) =>
    Object.hasOwn(stored, collection.id) ? [{ collectionId: collection.id, name: collection.name, points: numberOf(stored[collection.id]) ?? 0, active: isCollectionActive(collection, now) }] : [],
  );
  return { points, totalPoints: points.reduce((total, item) => (item.active ? total + item.points : total), 0) };
}

/** The type of a card as the API shows it, `null` when the card has none or the type is gone. */
export function cardTypeView(types: readonly CardType[], id: unknown): CardTypeView | null {
  const type = types.find((candidate) => candidate.id === id);
  return type === undefined ? null : { id: type.id, name: type.name, enabled: type.enabled, prepaid: type.prepaid.enabled, pointsCollect: type.pointsCollect.enabled };
}

/** The stored id of the type of a card, `null` when it is not a text. */
export function cardTypeIdOf(document: Document): string | null {
  return textOf(document['cardTypeId']);
}

/**
 * The version of a stored card, the `ETag` of the reads and the `If-Match` of the writes.
 *
 * @param document The stored card, read with every owned field.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 */
export function cardVersion(document: Document, key: Buffer): string {
  return entityVersion(document, CARD_VERSION_FIELDS, key);
}

/** What a read of a card needs of the group. */
export interface CardCatalogs {
  readonly types: readonly CardType[];
  readonly collections: readonly PointsCollection[];
  /** The instant, in epoch milliseconds. */
  readonly now: number;
}

/**
 * What a contact shows of an advanced card.
 *
 * @param document The stored card.
 * @param catalogs The card types and points collections of the group.
 */
export function advancedCard(document: Document, catalogs: CardCatalogs): AdvancedCard {
  const type = cardTypeView(catalogs.types, document['cardTypeId']);
  return {
    cardId: (document['_id'] as ObjectId).toHexString(),
    cardType: type === null ? null : { id: type.id, name: type.name },
    enabled: flagOf(document['status']),
    balance: cardBalance(document['balance']),
    totalPoints: cardPoints(document, catalogs.collections, catalogs.now).totalPoints,
  };
}

/** A stored card as the detail shows it. */
export function cardView(document: Document, catalogs: CardCatalogs, contacts: { readonly items: CardView['contacts']; readonly count: number }): CardView {
  const { points, totalPoints } = cardPoints(document, catalogs.collections, catalogs.now);
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    code: textOf(document['code']) ?? '',
    cardTypeId: cardTypeIdOf(document),
    cardType: cardTypeView(catalogs.types, document['cardTypeId']),
    enabled: flagOf(document['status']),
    balance: cardBalance(document['balance']),
    points,
    totalPoints,
    contacts: contacts.items,
    contactsCount: contacts.count,
    createdAt: dateOf(document['insertDate']),
    updatedAt: dateOf(document['updateDate']),
  };
}

/** A stored card as a row of the list shows it. */
export function cardRow(document: Document, catalogs: CardCatalogs, contacts: { readonly items: CardView['contacts']; readonly count: number }): CardRow {
  const type = cardTypeView(catalogs.types, document['cardTypeId']);
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    code: textOf(document['code']) ?? '',
    cardType: type === null ? null : { id: type.id, name: type.name },
    enabled: flagOf(document['status']),
    balance: cardBalance(document['balance']),
    totalPoints: cardPoints(document, catalogs.collections, catalogs.now).totalPoints,
    contact: contacts.items[0] ?? null,
    contactsCount: contacts.count,
    createdAt: dateOf(document['insertDate']),
  };
}

/** The fields the repository projects for a card. */
export const CARD_FIELDS: readonly string[] = FIDELITY_CARDS_OWNED_FIELDS;
