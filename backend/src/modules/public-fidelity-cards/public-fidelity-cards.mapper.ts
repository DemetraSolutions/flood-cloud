import type { CardRow, CardTypeView, CardView } from '../fidelity-cards/fidelity-cards.document.ts';
import type { MovementRow } from '../fidelity-cards/fidelity-cards.service.ts';

/** The contact that has a card, as a public key that may read the contacts sees it: the identifier and the display name, nothing else. */
export interface PublicCardContact {
  readonly id: string;
  readonly displayName: string | null;
}

/** A row of the public list of the cards. `contact` (the first contact that has the card) is there only for a key that may read the contacts. */
export interface PublicCardRow {
  readonly id: string;
  readonly code: string;
  readonly cardType: { readonly id: string; readonly name: string | null } | null;
  readonly enabled: boolean;
  /** The credit, in units of currency; `null` when the card has none to show. Only a card of a prepaid type has one. */
  readonly balance: number | null;
  /** The points that count now: the ones of the collections that are active. */
  readonly totalPoints: number;
  readonly contactsCount: number;
  readonly contact?: PublicCardContact | null;
  readonly createdAt: string | null;
}

/** A card as the public detail shows it. `contacts` (at most 20) is there only for a key that may read the contacts: any other key has `contactsCount` alone. */
export interface PublicCard {
  readonly id: string;
  readonly code: string;
  readonly cardType: CardTypeView | null;
  readonly enabled: boolean;
  readonly balance: number | null;
  /** The points on each collection of the group the card has, with whether the collection gives points now. */
  readonly points: ReadonlyArray<{ readonly collectionId: string; readonly name: string | null; readonly points: number; readonly active: boolean }>;
  readonly totalPoints: number;
  readonly contactsCount: number;
  readonly contacts?: readonly PublicCardContact[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A movement of the history of a card as the public API shows it. `operator` is who made it, a user or a public API key, by name (never an identifier); a movement of a sale has none. */
export interface PublicMovement {
  readonly id: string;
  readonly date: string | null;
  readonly type: string | null;
  readonly balance: number | null;
  readonly points: number | null;
  readonly collection: { readonly id: string; readonly name: string | null } | null;
  readonly operator: { readonly kind: 'user' | 'apiKey'; readonly name: string | null } | null;
}

const toPublicCardContact = (contact: { readonly id: string; readonly displayName: string | null }): PublicCardContact => ({ id: contact.id, displayName: contact.displayName });

/**
 * The public representation of a row of the list of cards, built field by field.
 *
 * @param row The row as the backoffice shows it.
 * @param withContacts Whether the key may read the contacts: only then the first contact of the card is named.
 */
export function toPublicCardRow(row: CardRow, withContacts: boolean): PublicCardRow {
  return {
    id: row.id,
    code: row.code,
    cardType: row.cardType === null ? null : { id: row.cardType.id, name: row.cardType.name },
    enabled: row.enabled,
    balance: row.balance,
    totalPoints: row.totalPoints,
    contactsCount: row.contactsCount,
    ...(withContacts ? { contact: row.contact === null ? null : toPublicCardContact(row.contact) } : {}),
    createdAt: row.createdAt,
  };
}

/**
 * The public representation of a card, built field by field.
 *
 * @param view The card as the backoffice shows it.
 * @param withContacts Whether the key may read the contacts: only then the contacts that have the card are named.
 */
export function toPublicCard(view: CardView, withContacts: boolean): PublicCard {
  return {
    id: view.id,
    code: view.code,
    cardType: view.cardType === null ? null : { id: view.cardType.id, name: view.cardType.name, enabled: view.cardType.enabled, prepaid: view.cardType.prepaid, pointsCollect: view.cardType.pointsCollect },
    enabled: view.enabled,
    balance: view.balance,
    points: view.points.map((item) => ({ collectionId: item.collectionId, name: item.name, points: item.points, active: item.active })),
    totalPoints: view.totalPoints,
    contactsCount: view.contactsCount,
    ...(withContacts ? { contacts: view.contacts.map(toPublicCardContact) } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/**
 * The public representation of a movement: the operator keeps his or its name and loses the identifier.
 *
 * @param row The movement as the backoffice shows it.
 */
export function toPublicMovement(row: MovementRow): PublicMovement {
  return { id: row.id, date: row.date, type: row.type, balance: row.balance, points: row.points, collection: row.collection === null ? null : { id: row.collection.id, name: row.collection.name }, operator: row.operator === null ? null : { kind: row.operator.kind, name: row.operator.name } };
}
