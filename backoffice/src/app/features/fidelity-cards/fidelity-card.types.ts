/** Path segment of the advanced loyalty cards under `/v1/groups/{groupId}`. */
export const FIDELITY_CARDS_SEGMENT = 'fidelity-cards';

/** Limits of the server (`doc/API.md`, "Carte fedeltà avanzate"). */
export const FIDELITY_CARD_LIMITS = Object.freeze({
  code: 64,
  contacts: 20,
  amount: 1_000_000,
  points: 1_000_000,
  reason: 200,
});

/** The type of a card as the detail shows it (a type that no longer exists is `null`). */
export interface CardTypeInfo {
  readonly id: string;
  readonly name: string | null;
  readonly enabled: boolean;
  /** The cards of the type have a credit. */
  readonly prepaid: boolean;
  /** The cards of the type collect points. */
  readonly pointsCollect: boolean;
}

/** The points a card has on one points collection. */
export interface CardPoints {
  readonly collectionId: string;
  readonly name: string | null;
  readonly points: number;
  /** The collection is on, inside its period and not past the expiration of its points. */
  readonly active: boolean;
}

/** A contact that has the code of a card (its name only). */
export interface CardContact {
  readonly id: string;
  readonly displayName: string | null;
}

/** An advanced loyalty card as the server returns it. */
export interface FidelityCard {
  readonly id: string;
  readonly code: string;
  readonly cardTypeId: string | null;
  readonly cardType: CardTypeInfo | null;
  readonly enabled: boolean;
  /** The credit, read only; shown only for a prepaid type. */
  readonly balance: number | null;
  readonly points: readonly CardPoints[];
  readonly totalPoints: number;
  /** At most 20. */
  readonly contacts: readonly CardContact[];
  readonly contactsCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A row of the list of cards. */
export interface FidelityCardRow {
  readonly id: string;
  readonly code: string;
  readonly cardType: { readonly id: string; readonly name: string | null } | null;
  readonly enabled: boolean;
  readonly balance: number | null;
  readonly totalPoints: number;
  /** The first contact that has the code. */
  readonly contact: CardContact | null;
  readonly contactsCount: number;
  readonly createdAt: string | null;
}

/** A movement of the history of a card. */
export interface CardMovement {
  readonly id: string;
  readonly date: string | null;
  /** `manually`, `import`, `sale`, `canceled_sale` or `null`. */
  readonly type: string | null;
  /** The credit moved, with its sign. */
  readonly balance: number | null;
  /** The points moved, with their sign. */
  readonly points: number | null;
  readonly collection: { readonly id: string; readonly name: string | null } | null;
  /** Who made the movement: a user, a public API key (integration) or nobody (sales). */
  readonly operator: {
    readonly kind: 'user' | 'apiKey';
    readonly id: string;
    readonly name: string | null;
    /** `true` when the movement was made by the point of sale server. */
    readonly store?: boolean;
  } | null;
}

/** The body of an adjustment: at least one of the two. */
export interface CardAdjustment {
  readonly balanceDelta?: number;
  readonly pointsDeltas?: readonly { readonly collectionId: string; readonly delta: number }[];
  readonly reason?: string;
}

/** The movement types the page names; any other is shown as "other". */
export const MOVEMENT_TYPES = ['manually', 'import', 'sale', 'canceled_sale'] as const;

/**
 * Router commands of the list of cards, of one card or of the page of a new one.
 *
 * @param groupId Group of the cards.
 * @param cardId The card; `null` for the page of a new one, omitted for the list.
 */
export function fidelityCardRoute(groupId: string, cardId?: string | null): string[] {
  const base = ['/groups', groupId, 'fidelity', 'cards'];
  return cardId === undefined ? base : [...base, cardId === null ? 'new' : cardId];
}
