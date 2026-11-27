import { ObjectId } from 'mongodb';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { Databases } from '../../db/databases.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { createContactsRepository } from '../contacts/contacts.repository.ts';
import type { ContactsRepository } from '../contacts/contacts.repository.ts';
import { createCardsRepository } from '../fidelity-cards/fidelity-cards.repository.ts';
import type { CardsRepository, NewMovement } from '../fidelity-cards/fidelity-cards.repository.ts';
import { computeLegacySaleLoyalty, computeSaleLoyalty, round2 } from './loyalty.compute.ts';
import type { AdvancedEffect, LoyaltyAnomaly, LoyaltyEffects, SaleFacts, SaleLoyalty, SimpleEffect } from './loyalty.compute.ts';
import { createLoyaltyRepository } from './loyalty.repository.ts';
import type { LoyaltyRepository } from './loyalty.repository.ts';

/** The sale the effects belong to. */
export interface LoyaltySale {
  /** The sale: written in the movements of the cards it moves. */
  readonly saleId: ObjectId;
  /** The customer of the sale, `null` when it has none: the contact whose simple card is moved when it has the code. */
  readonly customerId: ObjectId | null;
  /** The date of the sale: the date of the movements. */
  readonly date: Date;
}

/** Who asks for the effects, written in the movements. */
export interface LoyaltyActor {
  /** The operator or user; `null` when none is known. */
  readonly userId: ObjectId | null;
  /** The store key of the server of the point of sale that asked, when it did. */
  readonly storeKeyId?: ObjectId;
}

/** What a reconciliation did. */
export interface LoyaltyOutcome {
  /** What the sale has now applied to the cards (what the caller saves in the sale and passes back as `applied` next time); a part that could not be applied is not in it, so a new attempt applies it. `null` when nothing is applied. */
  readonly applied: LoyaltyEffects | null;
  /** The movements of the advanced cards that were written (none when the cards were already in the wanted state). */
  readonly movementIds: ObjectId[];
  /** What was found wrong and gone around; never an error, the caller decides what to show. */
  readonly anomalies: LoyaltyAnomaly[];
}

/** The two services a sale uses for its loyalty cards. */
export interface LoyaltyService {
  /**
   * What a sale does to the card it was paid with, worked out on what the group says (the card by its code, its type, the points collections and the rule of the currency are read from the database, none from the client): an advanced card when
   * the code is the one of a card of the group, a simple card (a code on a contact) otherwise. The caller scales the effects to the state of the sale (`scaleForState`) and reconciles them.
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param facts The facts of the sale.
   * @param cardCode The code of the card of the sale; `null` (or blank) when it has none.
   * @param currency The currency code of the sale (the rule of a simple card is one per currency).
   * @returns The effects and the anomalies.
   * @throws {RangeError} For facts that are not valid numbers or too many lines (a bug of the caller).
   */
  loyaltyOfSale(principal: ScopeHolder, access: GroupAccess, facts: SaleFacts, cardCode: string | null, currency: string): Promise<SaleLoyalty>;
  /**
   * What the **legacy** did to the loyalty card of a sale it wrote, worked out with the legacy formulas on the facts as stored (`computeLegacySaleLoyalty`), to adopt the sale: never more than the legacy charged or gave, and nothing for an advanced card
   * that did not exist yet at the date of the sale (anomaly `legacyCardAfterSale`).
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param facts The facts of the sale, with the codes of the lines as stored.
   * @param cardCode The code of the card of the sale; `null` (or blank) when it has none.
   * @param currency The currency code of the sale.
   * @returns The effects and the anomalies.
   */
  legacyLoyaltyOfSale(principal: ScopeHolder, access: GroupAccess, facts: SaleFacts, cardCode: string | null, currency: string): Promise<SaleLoyalty>;
  /**
   * Brings the cards of a sale to the state it wants, writing only the difference between `desired` and `applied`: the first application is a reconciliation from nothing, a refund applies the difference, a cancellation (`desired` `null`)
   * reverses everything and repeating a reconciliation writes nothing. If the card changed, the old one is reversed and the new one applied. The credit may go below zero and the points too (a sale of the point of sale is never refused;
   * the anomaly `negativeBalance` or `negativePoints` says so). All is written in one transaction on the cluster of the group (the one of the caller when `nested`).
   *
   * An advanced card moves with one update and one movement of `fidelity_cards_movements` for the credit and one for each collection touched (`sale`, or `canceled_sale` when `desired` is `null`, with the `saleId` and the date of the sale). A
   * simple card moves the points of the contact that has its code: the customer of the sale when it has it, otherwise the only contact of the group that does, and later reversals go back to the same contact.
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param sale The sale.
   * @param desired What the sale must have applied now, `null` to reverse everything.
   * @param applied What the sale has applied so far (kept in the sale), `null` for nothing.
   * @param actor Who asks.
   * @returns The new applied state, the movements written and the anomalies.
   * @throws {RangeError} When `desired` has an amount that is not a finite number or points that are not whole numbers (a bug of the caller).
   */
  reconcileSaleLoyalty(principal: ScopeHolder, access: GroupAccess, sale: LoyaltySale, desired: LoyaltyEffects | null, applied: LoyaltyEffects | null, actor: LoyaltyActor): Promise<LoyaltyOutcome>;
}

/** The repositories the service works with, built over one database accessor. */
export interface LoyaltyRepositories {
  readonly setup: LoyaltyRepository;
  readonly cards: Pick<CardsRepository, 'findByCodes' | 'applySale' | 'insertMovements'>;
  readonly contacts: Pick<ContactsRepository, 'saleCardHolder' | 'addSalePoints'>;
}

/** Collaborators of {@link createLoyaltyService}. */
export interface LoyaltyServiceDeps {
  /** The database accessor: the real one, or (with `nested`) the one bound to the transaction of the caller. */
  readonly databases: Databases;
  /** Whether `databases` is already the accessor of an open transaction (`sessionDatabases`): the work then joins it instead of opening another one (a sale reconciles its cards inside its own transaction). */
  readonly nested?: boolean;
  /** Builds the repositories over a database accessor (the default builds the real ones; a test wraps them). */
  readonly repositoriesOver?: (databases: Databases) => LoyaltyRepositories;
  /** Generator of the ids of the movements. */
  readonly newId?: () => ObjectId;
}

/** Checks what the caller guaranteed about the effects it wants: finite credit and whole points. */
function assertEffects(effects: LoyaltyEffects): void {
  const advanced = effects.advanced;
  if (advanced !== null && (!Number.isFinite(advanced.balance) || !Object.values(advanced.points).every((points) => Number.isInteger(points)))) {
    throw new RangeError('The credit of a card must be a finite number and its points whole numbers');
  }
  if (effects.simple !== null && !Number.isInteger(effects.simple.points)) {
    throw new RangeError('The points of a simple card must be a whole number');
  }
}

/** What a card has gained, minus what it had already: the credit and the points by collection, a zero left out. */
function differenceOf(wanted: { readonly balance: number; readonly points: Readonly<Record<string, number>> }, had: { readonly balance: number; readonly points: Readonly<Record<string, number>> }): { readonly balance: number; readonly points: ReadonlyMap<string, number> } {
  const points = new Map<string, number>();
  for (const id of [...new Set([...Object.keys(wanted.points), ...Object.keys(had.points)])].sort()) {
    const delta = (wanted.points[id] ?? 0) - (had.points[id] ?? 0);
    if (delta !== 0) {
      points.set(id, delta);
    }
  }
  return { balance: round2(wanted.balance - had.balance), points };
}

const NOTHING = { balance: 0, points: {} } as const;

/**
 * Builds the service of the loyalty effects of a sale: the one place that turns a sale (or its refund or cancellation) into changes of the loyalty cards, the simple ones (the points of a code on a contact) and the advanced ones (the credit
 * and the points of a card, with their movements). The calculation is pure ({@link computeSaleLoyalty}); the application is one reconciliation that works on the difference between what the sale wants and what it has applied.
 *
 * @param deps The collaborators.
 */
export function createLoyaltyService(deps: LoyaltyServiceDeps): LoyaltyService {
  const newId = deps.newId ?? (() => new ObjectId());
  const repositoriesOver =
    deps.repositoriesOver ??
    ((databases: Databases): LoyaltyRepositories => ({ setup: createLoyaltyRepository(databases), cards: createCardsRepository(databases), contacts: createContactsRepository(databases) }));
  /** Runs `work` in a transaction on the cluster of the group, over repositories that make every read and write part of it (the driver may repeat `work`, so it keeps nothing between attempts but its result). */
  const inTransaction = <T>(principal: ScopeHolder, access: GroupAccess, work: (repositories: LoyaltyRepositories) => Promise<T>): Promise<T> =>
    deps.nested === true ? work(repositoriesOver(deps.databases)) : inGroupTransaction(principal, access, deps.databases, (session) => work(repositoriesOver(sessionDatabases(deps.databases, session, access.groupId))));

  /** The advanced card of a code, if there is one: the one with exactly that code, else the only one that has it when the spaces around a stored code are ignored. */
  const findAdvanced = async (repositories: LoyaltyRepositories, principal: ScopeHolder, access: GroupAccess, code: string): Promise<{ readonly id: ObjectId; readonly code: string; readonly status: boolean; readonly cardTypeId: string | null; readonly insertDate: Date | null } | 'none' | 'ambiguous'> => {
    const found = await repositories.cards.findByCodes(principal, access, [code]);
    const exact = found.filter((card) => card['code'] === code);
    const card = exact.length === 1 ? exact[0]! : found.length === 1 ? found[0]! : undefined;
    if (card === undefined) {
      return found.length === 0 ? 'none' : 'ambiguous';
    }
    return { id: card['_id'] as ObjectId, code: card['code'] as string, status: card['status'] === true, cardTypeId: typeof card['cardTypeId'] === 'string' ? card['cardTypeId'] : null, insertDate: card['insertDate'] instanceof Date ? card['insertDate'] : null };
  };

  /** Applies a difference to an advanced card and writes its movements. */
  const reconcile = async (repositories: LoyaltyRepositories, principal: ScopeHolder, access: GroupAccess, sale: LoyaltySale, desired: LoyaltyEffects | null, applied: LoyaltyEffects | null, actor: LoyaltyActor): Promise<LoyaltyOutcome> => {
    const anomalies: LoyaltyAnomaly[] = [];
    const movements: NewMovement[] = [];
    const type = desired === null ? 'canceled_sale' : 'sale';

    /** Moves an advanced card by a difference with one update; the movements and the anomalies of what it did. `false` when the card could not be updated. */
    const moveCard = async (card: { readonly cardId: ObjectId; readonly code: string }, change: { readonly balance: number; readonly points: ReadonlyMap<string, number> }): Promise<boolean> => {
      if (change.balance === 0 && change.points.size === 0) {
        return true;
      }
      const after = await repositories.cards.applySale(principal, access, card.cardId, {
        ...(change.balance === 0 ? {} : { balance: change.balance }),
        points: [...change.points].map(([collectionId, delta]) => ({ collectionId, delta })),
      });
      if (after === null) {
        anomalies.push({ code: 'cardNotFound' });
        return false;
      }
      const stock = after['pointsCollections'] as Record<string, number>;
      if (change.balance !== 0 && (after['balance'] as number) < 0) {
        anomalies.push({ code: 'negativeBalance' });
      }
      const movement = (balance: number, pointsCollectionId: string | null, points: number): NewMovement => ({
        _id: newId(),
        userId: actor.userId,
        ...(actor.storeKeyId === undefined ? {} : { storeKeyId: actor.storeKeyId }),
        saleId: sale.saleId,
        cardId: card.cardId,
        cardCode: card.code,
        date: sale.date,
        type,
        balance,
        pointsCollectionId,
        points,
      });
      if (change.balance !== 0) {
        movements.push(movement(change.balance, null, 0));
      }
      for (const [collectionId, delta] of change.points) {
        if (stock[collectionId]! < 0) {
          anomalies.push({ code: 'negativePoints', collectionId });
        }
        movements.push(movement(0, collectionId, delta));
      }
      return true;
    };

    /** The advanced card: the difference when it is the same card, else the reversal of the old one and the application of the new. */
    const advancedPart = async (): Promise<AdvancedEffect | null> => {
      const wanted = desired?.advanced ?? null;
      const had = applied?.advanced ?? null;
      if (wanted !== null && had !== null && wanted.cardId.equals(had.cardId)) {
        return (await moveCard(wanted, differenceOf(wanted, had))) ? wanted : had;
      }
      if (had !== null) {
        // A card that is gone has nothing left to undo: the reversal is reported and the old state dropped either way.
        await moveCard(had, differenceOf(NOTHING, had));
      }
      return wanted !== null && (await moveCard(wanted, differenceOf(wanted, NOTHING))) ? wanted : null;
    };

    /** The contact whose simple card a code is, with the anomaly when there is none. */
    const holderOf = async (code: string): Promise<ObjectId | null> => {
      const holder = await repositories.contacts.saleCardHolder(principal, access, code, sale.customerId);
      if (holder === 'none' || holder === 'ambiguous') {
        anomalies.push({ code: holder === 'none' ? 'simpleCardNotFound' : 'simpleCardAmbiguous' });
        return null;
      }
      return holder;
    };

    /** Adds points to the simple card of a contact; `false` (with the anomaly) when the card is not there. */
    const addPoints = async (contactId: ObjectId, code: string, delta: number): Promise<boolean> => {
      const after = await repositories.contacts.addSalePoints(principal, access, contactId, code, delta);
      if (after === null) {
        anomalies.push({ code: 'simpleCardNotFound' });
        return false;
      }
      if (after < 0) {
        anomalies.push({ code: 'negativePoints' });
      }
      return true;
    };

    /** Takes back the points a simple card was given, from the contact that got them. A contact that is gone has nothing left to undo. */
    const reverseSimple = async (had: SimpleEffect): Promise<void> => {
      if (had.points === 0) {
        return;
      }
      const contactId = had.contactId ?? (await holderOf(had.code));
      if (contactId !== null) {
        await addPoints(contactId, had.code, -had.points);
      }
    };

    /** The simple card: the difference when it is the same code on the same contact, else the reversal of the old one and the application of the new. */
    const simplePart = async (): Promise<SimpleEffect | null> => {
      const wanted = desired?.simple ?? null;
      const had = applied?.simple ?? null;
      const target = wanted === null ? null : await holderOf(wanted.code);
      if (wanted !== null && had !== null && target !== null && had.code === wanted.code && (had.contactId === undefined || had.contactId.equals(target))) {
        const delta = wanted.points - had.points;
        return delta === 0 || (await addPoints(target, wanted.code, delta)) ? { ...wanted, contactId: target } : had;
      }
      if (had !== null) {
        await reverseSimple(had);
      }
      return wanted !== null && target !== null && (wanted.points === 0 || (await addPoints(target, wanted.code, wanted.points))) ? { ...wanted, contactId: target } : null;
    };

    const advanced = await advancedPart();
    const simple = await simplePart();
    if (movements.length > 0) {
      await repositories.cards.insertMovements(principal, access, movements);
    }
    const seen = new Set<string>();
    return {
      applied: advanced === null && simple === null ? null : { advanced, simple },
      movementIds: movements.map((movement) => movement._id!),
      anomalies: anomalies.filter((anomaly) => {
        const key = `${anomaly.code}:${anomaly.collectionId ?? ''}`;
        return !seen.has(key) && seen.add(key);
      }),
    };
  };

  return {
    loyaltyOfSale: async (principal, access, facts, cardCode, currency) => {
      if (cardCode === null || cardCode.trim() === '') {
        return { effects: { advanced: null, simple: null }, anomalies: [] };
      }
      const repositories = repositoriesOver(deps.databases);
      const card = await findAdvanced(repositories, principal, access, cardCode);
      if (card === 'ambiguous') {
        return { effects: { advanced: null, simple: null }, anomalies: [{ code: 'cardAmbiguous' }] };
      }
      const setup = await repositories.setup.readSetup(principal, access, currency);
      if (card === 'none') {
        return computeSaleLoyalty(facts, { kind: 'simple', code: cardCode, ruleValue: setup.ruleValue });
      }
      return computeSaleLoyalty(facts, { kind: 'advanced', card, cardType: card.cardTypeId === null ? null : (setup.cardTypes.get(card.cardTypeId) ?? null), collections: setup.collections });
    },

    legacyLoyaltyOfSale: async (principal, access, facts, cardCode, currency) => {
      if (cardCode === null || cardCode.trim() === '') {
        return { effects: { advanced: null, simple: null }, anomalies: [] };
      }
      const repositories = repositoriesOver(deps.databases);
      const card = await findAdvanced(repositories, principal, access, cardCode);
      if (card === 'ambiguous') {
        return { effects: { advanced: null, simple: null }, anomalies: [{ code: 'cardAmbiguous' }] };
      }
      const setup = await repositories.setup.readSetup(principal, access, currency);
      if (card === 'none') {
        return computeLegacySaleLoyalty(facts, { kind: 'simple', code: cardCode, ruleValue: setup.ruleValue });
      }
      return computeLegacySaleLoyalty(facts, { kind: 'advanced', card, cardType: card.cardTypeId === null ? null : (setup.cardTypes.get(card.cardTypeId) ?? null), collections: setup.collections });
    },

    reconcileSaleLoyalty: async (principal, access, sale, desired, applied, actor) => {
      if (desired !== null) {
        assertEffects(desired);
      }
      return inTransaction(principal, access, (repositories) => reconcile(repositories, principal, access, sale, desired, applied, actor));
    },
  };
}
