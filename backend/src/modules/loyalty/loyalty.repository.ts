import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { isRecord } from '../groups/catalogs/kit.ts';
import type { LegacyCardType, LegacyPointsCollection } from './loyalty.compute.ts';

/** What the group says about its loyalty: the card types by id, the points collections and the value of the rule of one currency. */
export interface LoyaltySetup {
  /** The card types of the group (`fidelity.cardsTypes`) by their id. */
  readonly cardTypes: ReadonlyMap<string, LegacyCardType>;
  /** The points collections of the group (`fidelity.pointsCollections`). */
  readonly collections: readonly LegacyPointsCollection[];
  /** `fidelityCardRules.<currency>.value`: the amount of money for one point of a simple card; `null` when there is no rule or it is not a number. */
  readonly ruleValue: number | null;
}

/** The part of the group the loyalty effects of a sale read, from the common database. */
export interface LoyaltyRepository {
  /** The loyalty setup of the group of the verified access, for the currency of a sale. */
  readSetup(principal: ScopeHolder, access: GroupAccess, currency: string): Promise<LoyaltySetup>;
}

/** An id stored as an `ObjectId` or as the hexadecimal text an older client wrote; `null` for anything else. */
function placeOf(raw: unknown): ObjectId | null {
  if (raw instanceof ObjectId) {
    return raw;
  }
  return typeof raw === 'string' && /^[0-9a-f]{24}$/.test(raw) ? ObjectId.createFromHexString(raw) : null;
}

/** A valid date, or `null` for anything else (a missing end of a period is open). */
function dateOrNull(raw: unknown): Date | null {
  return raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw : null;
}

/** A finite number, or `null`. */
function numberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * The card type of the legacy as the calculation reads it. Every flag is on only when it is exactly `true`; anything unreadable is the safe value (off, no collections, no limit on the places).
 *
 * @param raw A stored element of `fidelity.cardsTypes`.
 * @returns The type, or `null` when the element has no text id.
 */
export function legacyCardTypeOf(raw: Readonly<Record<string, unknown>>): { readonly id: string; readonly type: LegacyCardType } | null {
  if (typeof raw['id'] !== 'string') {
    return null;
  }
  const prepaid = isRecord(raw['prepaid']) ? raw['prepaid'] : {};
  const collect = isRecord(raw['pointsCollect']) ? raw['pointsCollect'] : {};
  const places = Array.isArray(raw['placesAvailability']) ? (raw['placesAvailability'] as unknown[]) : [];
  const ids = Array.isArray(collect['collectionIds']) ? (collect['collectionIds'] as unknown[]) : [];
  return {
    id: raw['id'],
    type: {
      status: raw['status'] === true,
      prepaid: { status: prepaid['status'] === true, type: prepaid['type'] === 'mono' || prepaid['type'] === 'multi' ? prepaid['type'] : null },
      pointsCollect: { status: collect['status'] === true, collectionIds: ids.filter((id): id is string => typeof id === 'string') },
      placesAvailability: places.flatMap((place) => {
        const id = placeOf(place);
        return id === null ? [] : [id];
      }),
    },
  };
}

/**
 * The points collection of the legacy as the calculation reads it.
 *
 * @param raw A stored element of `fidelity.pointsCollections`.
 * @returns The collection, or `null` when the element has no text id.
 */
export function legacyCollectionOf(raw: Readonly<Record<string, unknown>>): LegacyPointsCollection | null {
  if (typeof raw['id'] !== 'string') {
    return null;
  }
  return {
    id: raw['id'],
    status: raw['status'] === true,
    pointConversion: numberOrNull(raw['pointConversion']),
    minAmount: numberOrNull(raw['minAmount']),
    dateFrom: dateOrNull(raw['dateFrom']),
    dateTo: dateOrNull(raw['dateTo']),
    pointsExpirationDate: dateOrNull(raw['pointsExpirationDate']),
  };
}

/**
 * Builds the repository over a database accessor (the real one, or the one bound to the transaction of the caller).
 *
 * @param databases Database accessor.
 */
export function createLoyaltyRepository(databases: Databases): LoyaltyRepository {
  return {
    readSetup: async (_principal, access, currency) => {
      const group = await bounded(() => databases.common().collection('groups').findOne({ _id: access.groupId }, { projection: { 'fidelity.cardsTypes': 1, 'fidelity.pointsCollections': 1, fidelityCardRules: 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
      const fidelity = isRecord(group?.['fidelity']) ? group['fidelity'] : {};
      const records = (raw: unknown): Readonly<Record<string, unknown>>[] => (Array.isArray(raw) ? (raw as unknown[]).filter(isRecord) : []);
      const rules = isRecord(group?.['fidelityCardRules']) ? group['fidelityCardRules'] : {};
      const rule = Object.hasOwn(rules, currency) && isRecord(rules[currency]) ? rules[currency] : {};
      return {
        cardTypes: new Map(records(fidelity['cardsTypes']).flatMap((raw) => {
          const type = legacyCardTypeOf(raw);
          return type === null ? [] : [[type.id, type.type] as const];
        })),
        collections: records(fidelity['pointsCollections']).flatMap((raw) => {
          const collection = legacyCollectionOf(raw);
          return collection === null ? [] : [collection];
        }),
        ruleValue: numberOrNull(rule['value']),
      };
    },
  };
}
