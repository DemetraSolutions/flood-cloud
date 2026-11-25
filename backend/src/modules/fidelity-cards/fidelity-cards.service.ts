import { Double, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { Databases } from '../../db/databases.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { escapeRegExp, listParamsOf } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { clearText, displayNameOf } from '../contacts/contacts.document.ts';
import { createContactsRepository } from '../contacts/contacts.repository.ts';
import type { ContactsRepository } from '../contacts/contacts.repository.ts';
import { actorOfCaller, operatorMetadata } from '../product-catalog/caller.ts';
import type { ApiKeyCaller, StoreCaller } from '../product-catalog/caller.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { cardTypes } from '../groups/catalogs/card-types.ts';
import type { CardType } from '../groups/catalogs/card-types.ts';
import { dateOf, isRecord, numberOf, textOf } from '../groups/catalogs/kit.ts';
import { pointsCollections } from '../groups/catalogs/points-collections.ts';
import type { PointsCollection } from '../groups/catalogs/points-collections.ts';
import { CARDS_LIST, MOVEMENTS_LIST } from './fidelity-cards.schemas.ts';
import type { AdjustmentBody, CardsQuery, CreateCardBody, MovementsQuery, PatchCardBody } from './fidelity-cards.schemas.ts';
import { cardBalance, cardRow, cardTypeIdOf, cardVersion, cardView } from './fidelity-cards.document.ts';
import type { CardCatalogs, CardRow, CardView } from './fidelity-cards.document.ts';
import type { CardIndexGuard } from './fidelity-cards.indexes.ts';
import { createCardsRepository } from './fidelity-cards.repository.ts';
import type { CardsRepository, NewMovement } from './fidelity-cards.repository.ts';

/**
 * Whoever works on the advanced cards: a backoffice user, a public API key (`fidelityCards:read`, `fidelityCards:write`) or the server of a point of sale (its store key, with the operator of a write), whose perimeter is the whole
 * group. The deletion of a card is the user's alone. The movements of a store have the operator as their user.
 */
export type CardsCaller = AuthPrincipal | ApiKeyCaller | StoreCaller;

/**
 * The query of {@link CardsService.list}: the one of the route, `codeOnly` (the search `q` looks at the codes of the cards only, never at the names of the contacts: what a caller who may not read the contacts is given), `code` (the
 * cards that have exactly that code, ignoring the spaces the legacy may have left around a stored one) and `updatedSince` (an ISO 8601 instant: only the cards whose `updateDate` is from then on).
 */
export type CardsListQuery = CardsQuery & { readonly codeOnly?: true; readonly code?: string | undefined; readonly updatedSince?: string | undefined };

/** A page of the cards as the detail shows them: the points by collection and the contacts that have each code. */
export interface CardViewPage {
  readonly items: readonly CardView[];
  readonly page: PageInfo;
}

/** A card with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface CardResult {
  readonly entity: CardView;
  readonly version: string;
}

/** A page of the rows of the list of the cards. */
export interface CardPage {
  readonly items: readonly CardRow[];
  readonly page: PageInfo;
}

/** A movement of the history of a card as the API shows it. */
export interface MovementRow {
  readonly id: string;
  readonly date: string | null;
  readonly type: string | null;
  readonly balance: number | null;
  readonly points: number | null;
  readonly collection: { readonly id: string; readonly name: string | null } | null;
  /** Who made the movement: a user (`store: true` when the user was the operator at the till of a point of sale, declared by its store key), a public API key, or nobody known (a sale of the legacy). */
  readonly operator: { readonly kind: 'user' | 'apiKey'; readonly id: string; readonly name: string | null; readonly store?: true } | null;
}

/** The operations on the advanced loyalty cards of a group. */
export interface CardsService {
  /**
   * A page of the cards, sorted before the page is cut. `q` is the code (the whole of it) or a text in the name of a contact that has a card (at most 100 contacts are examined).
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort; `SERVICE_UNAVAILABLE` when a read exceeds its time limit.
   */
  list(principal: CardsCaller, access: GroupAccess, query: CardsListQuery): Promise<CardPage>;
  /**
   * A page of the cards as the detail shows them (the points by collection and the first contacts that have the code, with how many in all), filtered and sorted as {@link CardsService.list}. With `updatedSince` the cards changed from
   * that instant on come back, in the order of the last change unless `sort` says otherwise. Only the creation and the changes of the type and of the state move `updateDate`: the credit and the points, which sales and adjustments
   * change, do not.
   *
   * @throws {AppError} as {@link CardsService.list}.
   */
  listFull(principal: CardsCaller, access: GroupAccess, query: CardsListQuery): Promise<CardViewPage>;
  /**
   * One card, with its points by collection and the contacts that have it.
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: CardsCaller, access: GroupAccess, id: ObjectId): Promise<CardResult>;
  /**
   * Creates a card in the shape the legacy writes, with the credit and the points it starts with (each a movement, `manually` unless the request comes from the workbook) and the contacts that have its code.
   *
   * @param options `movementType: 'import'` writes the initial movements as `import` (the workbook of the cards).
   * @throws {AppError} `VALIDATION_ERROR` for a type that does not exist, a credit on a type that is not prepaid, points on a type that does not collect them or on a collection that is not the type's, a contact that does not exist; `CONFLICT` with `taken` for a code a card already has.
   */
  create(principal: CardsCaller, access: GroupAccess, body: CreateCardBody, client: ClientContext, options?: { readonly movementType?: 'import' }): Promise<CardResult>;
  /**
   * Changes the type or the state of a card (the code never changes) and records it. A request that changes nothing writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `VALIDATION_ERROR` for a type that does not exist; `CONFLICT` when the card changed while this request ran.
   */
  update(principal: CardsCaller, access: GroupAccess, id: ObjectId, expected: string, body: PatchCardBody, client: ClientContext): Promise<CardResult>;
  /**
   * Adds or takes away credit and points (one `$inc`, never below zero) and writes a movement for each component, with the operator.
   *
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_ERROR` for a credit on a type that is not prepaid, a collection that is not the type's; `CONFLICT` with `balance`/`insufficient` or `points.<id>`/`insufficient`.
   */
  adjust(principal: CardsCaller, access: GroupAccess, id: ObjectId, body: AdjustmentBody, client: ClientContext): Promise<CardResult>;
  /**
   * A page of the movements of a card, newest first.
   *
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_ERROR` on `cursor`/`format`.
   */
  movements(principal: CardsCaller, access: GroupAccess, id: ObjectId, query: MovementsQuery): Promise<{ readonly items: readonly MovementRow[]; readonly page: PageInfo }>;
  /**
   * Deletes a card for good, only one without history.
   *
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` with `referenced` (`contacts.<id>` or `movements`) or when the card changed meanwhile.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createCardsService}. */
export interface CardsServiceDeps {
  readonly repository: CardsRepository;
  /** The contacts side of the cards: who has a code, the contacts a new card is given to. */
  readonly contacts: Pick<ContactsRepository, 'cardHolders' | 'cardCodesOfContactsNamed' | 'contactsByIds'>;
  /** Reads the card types and the points collections of the group. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
  readonly activityLog: ActivityLog;
  /** Makes sure the group has the unique index on the code before its first card is written. */
  readonly indexes: CardIndexGuard;
  /** The database accessor: the writes that must go together (a card with its movements and its contacts, an adjustment with its movements) run in one transaction on the cluster of the group, over repositories built on it. */
  readonly databases: Databases;
  /**
   * Whether `databases` is already the accessor of an open transaction (`sessionDatabases`): the writes that must go together then join it instead of opening another one (the workbook of the cards runs every row in
   * the one transaction of the import, and the service is built over it).
   */
  readonly nested?: boolean;
  /** Builds the repositories of a transaction over the database accessor of its session (the default builds the real ones; a test wraps them). */
  readonly repositoriesOver?: (databases: Databases) => { readonly cards: CardsRepository; readonly contacts: Pick<ContactsRepository, 'linkCard' | 'cardHolderIds'> };
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new cards. */
  readonly newId?: () => ObjectId;
}

/**
 * Builds the service of the advanced cards of a group: the card (code, type, state, credit, points by collection), who has its code, its history, the creation with the credit and points it starts with, the adjustments that never go
 * below zero, and the deletion of a card that has no history. The activity log records the cards and the adjustments, never a contact (only how many).
 *
 * @param deps The repositories and the collaborators.
 */
export function createCardsService(deps: CardsServiceDeps): CardsService {
  const { repository, contacts, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const repositoriesOver = deps.repositoriesOver ?? ((databases: Databases) => ({ cards: createCardsRepository(databases), contacts: createContactsRepository(databases) }));
  /**
   * Runs `work` in a transaction on the cluster of the group (the one of the verified access: the group database is the only one written), over repositories that make every read and write part of it. The driver retries
   * `work` on a transient error and aborts everything when it throws, so `work` keeps nothing between attempts but its result.
   */
  const inTransaction = <T>(principal: CardsCaller, access: GroupAccess, work: (repositories: ReturnType<typeof repositoriesOver>) => Promise<T>): Promise<T> =>
    deps.nested === true ? work(repositoriesOver(deps.databases)) : inGroupTransaction(principal, access, deps.databases, (session) => work(repositoriesOver(sessionDatabases(deps.databases, session, access.groupId))));

  const catalogsOf = async (access: GroupAccess): Promise<CardCatalogs> => {
    const [types, collections] = await Promise.all([deps.catalogs.list(cardTypes, access), deps.catalogs.list(pointsCollections, access)]);
    return { types: types as CardType[], collections: collections as PointsCollection[], now: deps.now() };
  };
  const found = async (principal: CardsCaller, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  /** The contacts that have the code of a card, with the name of each, as the answers show them. */
  const holdersOf = (documents: readonly Document[], count: number): { items: { id: string; displayName: string | null }[]; count: number } => ({
    items: documents.map((contact) => ({ id: (contact['_id'] as ObjectId).toHexString(), displayName: displayNameOf(clearText(contact['companyName']), clearText(contact['name']), clearText(contact['surname'])) })),
    count,
  });
  /** The contacts that have the code of a card, read before a write: the code never changes, and the answer of a write is then made of values already read, so nothing after the commit can fail. */
  const holdersFor = async (principal: CardsCaller, access: GroupAccess, code: string): Promise<{ items: { id: string; displayName: string | null }[]; count: number }> => {
    const holders = (await contacts.cardHolders(principal, access, [code], true)).get(code)!;
    return holdersOf(holders.items, holders.count);
  };
  /** The card as the answers show it, from values already read (no database): the version is the one of the stored card. */
  const resultFrom = (document: Document, catalogs: CardCatalogs, holders: { items: { id: string; displayName: string | null }[]; count: number }): CardResult => ({ entity: cardView(document, catalogs, holders), version: cardVersion(document, versionKey) });
  const viewOf = async (principal: CardsCaller, access: GroupAccess, document: Document, catalogs: CardCatalogs): Promise<CardResult> => resultFrom(document, catalogs, await holdersFor(principal, access, textOf(document['code']) ?? ''));
  const record = (principal: CardsCaller, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, metadata?: Record<string, string | number | null>) =>
    recordDataChange(activityLog, {
      actor: actorOfCaller(principal),
      groupId: access.groupId,
      resource: { type: 'fidelityCard', id: id.toHexString() },
      action,
      before,
      after,
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      metadata: { ...metadata, ...operatorMetadata(principal) },
    });
  const loggable = (document: Document): Record<string, unknown> => ({ code: textOf(document['code']), cardTypeId: cardTypeIdOf(document), enabled: document['status'] === true });
  const dateAfter = (read: unknown): Date => {
    const clock = new Date(deps.now());
    return read instanceof Date && read.getTime() >= clock.getTime() ? new Date(read.getTime() + 1) : clock;
  };
  const issue = (field: string, kind: string): ErrorDetail => ({ field, issue: kind });
  const refuse = (issues: readonly ErrorDetail[]): void => {
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues.slice(0, 20) });
    }
  };
  const movement = (principal: CardsCaller, card: Document, date: Date, balance: number, pointsCollectionId: string | null, points: number, type: NewMovement['type'] = 'manually'): NewMovement => ({
    // A public key is not a user: its movements have no `userId` and carry the id of the key (`apiKeyId`, a field the legacy neither reads nor rewrites). A store's movements are its operator's, as a user's are.
    userId: 'kind' in principal ? (principal.kind === 'store' ? (principal.operator?.id ?? null) : null) : principal.userId,
    ...('kind' in principal && principal.kind === 'apiKey' ? { apiKeyId: principal.keyId } : {}),
    ...('kind' in principal && principal.kind === 'store' ? { storeKeyId: principal.keyId } : {}),
    cardId: card['_id'] as ObjectId,
    cardCode: textOf(card['code']) as string,
    date,
    type,
    balance,
    pointsCollectionId,
    points,
  });
  /** The points collections a card of a type may have points on: only if the type collects points, and only the ones it names. */
  const allowedCollections = (type: CardType | undefined): ReadonlySet<string> => new Set(type?.pointsCollect.enabled === true ? type.pointsCollect.collectionIds : []);

  /** The holders of the code of a stored card, from the ones read for a page (none for a card without a readable code). */
  const holdersAt = (holders: ReadonlyMap<string, { readonly items: Document[]; readonly count: number }>, item: Document) => {
    const found = holders.get(textOf(item['code']) ?? '');
    return holdersOf(found?.items ?? [], found?.count ?? 0);
  };
  /**
   * One page of the stored cards for a list, with what the rows and the views are made of: the conditions of the search `q`, the type, the state, the exact `code` and `updatedSince`, the card types and the holders of each code.
   * From an instant on the default order is the one of the last change.
   */
  const pageOfCards = async (principal: CardsCaller, access: GroupAccess, query: CardsListQuery) => {
    const params = listParamsOf({ ...query, ...(query.sort === undefined && query.updatedSince !== undefined ? { sort: 'updatedAt' } : {}) }, CARDS_LIST);
    const conditions: Filter<Document>[] = [];
    if (params.q !== null) {
      const codes = query.codeOnly === true ? [] : await contacts.cardCodesOfContactsNamed(principal, access, params.q);
      conditions.push({ $or: [{ code: { $regex: `^${escapeRegExp(params.q)}$`, $options: 'i' } }, ...(codes.length === 0 ? [] : [{ code: { $in: codes } }])] });
    }
    if (query.cardTypeId !== undefined) {
      conditions.push({ cardTypeId: query.cardTypeId });
    }
    if (query.enabled !== undefined) {
      conditions.push({ status: query.enabled ? true : { $ne: true } });
    }
    if (query.code !== undefined) {
      conditions.push({ code: { $regex: `^\\s*${escapeRegExp(query.code)}\\s*$` } });
    }
    if (query.updatedSince !== undefined) {
      conditions.push({ updateDate: { $gte: new Date(query.updatedSince) } });
    }
    const { items, page } = await repository.list(principal, access, conditions.length === 0 ? {} : { $and: conditions }, params);
    const catalogs = await catalogsOf(access);
    const codes = items.map((item) => textOf(item['code'])).filter((code): code is string => code !== null);
    const holders = codes.length === 0 ? new Map<string, { readonly items: Document[]; readonly count: number }>() : await contacts.cardHolders(principal, access, codes, false);
    return { items, page, catalogs, holders };
  };

  return {
    list: async (principal, access, query) => {
      const { items, page, catalogs, holders } = await pageOfCards(principal, access, query);
      return { items: items.map((item) => cardRow(item, catalogs, holdersAt(holders, item))), page };
    },

    listFull: async (principal, access, query) => {
      const { items, page, catalogs, holders } = await pageOfCards(principal, access, query);
      return { items: items.map((item) => cardView(item, catalogs, holdersAt(holders, item))), page };
    },

    get: async (principal, access, id) => viewOf(principal, access, await found(principal, access, id), await catalogsOf(access)),

    create: async (principal, access, body, client, options = {}) => {
      const catalogs = await catalogsOf(access);
      const type = catalogs.types.find((candidate) => candidate.id === body.cardTypeId);
      const issues: ErrorDetail[] = [];
      if (type === undefined) {
        issues.push(issue('cardTypeId', 'incorrect'));
      }
      if (body.initialBalance !== undefined && type?.prepaid.enabled !== true) {
        issues.push(issue('initialBalance', 'notAllowed'));
      }
      const allowed = allowedCollections(type);
      (body.initialPoints ?? []).forEach((item, index) => {
        if (!catalogs.collections.some((collection) => collection.id === item.collectionId)) {
          issues.push(issue(`initialPoints.${String(index)}.collectionId`, 'incorrect'));
        } else if (!allowed.has(item.collectionId)) {
          issues.push(issue(`initialPoints.${String(index)}.collectionId`, 'notAllowed'));
        }
      });
      const contactIds = body.contactIds ?? [];
      const linkedContacts = contactIds.length === 0 ? [] : await contacts.contactsByIds(principal, access, contactIds);
      const found = new Set(linkedContacts.map((contact) => (contact['_id'] as ObjectId).toHexString()));
      contactIds.forEach((contact, position) => (found.has(contact) ? undefined : issues.push(issue(`contactIds.${String(position)}`, 'incorrect'))));
      refuse(issues);
      await deps.indexes.ensure(principal, access);
      if (await repository.codeTaken(principal, access, body.code)) {
        throw new AppError('CONFLICT', { details: [issue('code', 'taken')] });
      }
      const id = newId();
      const date = new Date(deps.now());
      const initial: Document = Object.fromEntries((body.initialPoints ?? []).map((item) => [item.collectionId, item.points]));
      const document: Document = { _id: id, code: body.code, cardTypeId: body.cardTypeId, status: body.enabled ?? true, balance: new Double(body.initialBalance ?? 0), pointsCollections: initial, insertDate: date, updateDate: date };
      const movements = [
        ...(body.initialBalance === undefined ? [] : [movement(principal, document, date, body.initialBalance, null, 0, options.movementType)]),
        ...(body.initialPoints ?? []).map((item) => movement(principal, document, date, 0, item.collectionId, item.points, options.movementType)),
      ];
      // Everything the answer shows is read before the write: after the commit nothing can fail (the key of the request is pinned, and a retry must not write twice).
      const existing = await holdersFor(principal, access, body.code);
      // The card, its movements and the contacts that have its code are one write: all or nothing.
      const linked = await inTransaction(principal, access, async (tx) => {
        await tx.cards.insert(principal, access, document, movements);
        return contactIds.length === 0 ? 0 : tx.contacts.linkCard(principal, access, contactIds.map((contact) => ObjectId.createFromHexString(contact)), body.code, date);
      });
      const readBack: Document = { ...document, balance: body.initialBalance ?? 0 };
      const known = new Set(existing.items.map((contact) => contact.id));
      const added = holdersOf(linkedContacts.filter((contact) => !known.has((contact['_id'] as ObjectId).toHexString())), 0).items;
      const holders = { items: [...existing.items, ...added].slice(0, 20), count: existing.count + added.length };
      await record(principal, access, client, id, 'fidelityCard.created', undefined, { ...loggable(readBack), balance: readBack['balance'], points: initial }, { contactsCount: linked });
      return resultFrom(readBack, catalogs, holders);
    },

    update: async (principal, access, id, expected, body, client) => {
      const stored = await found(principal, access, id);
      if (cardVersion(stored, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const catalogs = await catalogsOf(access);
      const set: Document = {};
      if (body.cardTypeId !== undefined && body.cardTypeId !== cardTypeIdOf(stored)) {
        if (!catalogs.types.some((type) => type.id === body.cardTypeId)) {
          throw new AppError('VALIDATION_ERROR', { details: [issue('cardTypeId', 'incorrect')] });
        }
        set['cardTypeId'] = body.cardTypeId;
      }
      if (body.enabled !== undefined && (stored['status'] === true) !== body.enabled) {
        set['status'] = body.enabled;
      }
      const holders = await holdersFor(principal, access, textOf(stored['code']) ?? '');
      if (Object.keys(set).length === 0) {
        return resultFrom(stored, catalogs, holders);
      }
      // A card cannot move to a type that has no credit while it has some: the credit would be left where nothing shows it. The write checks it again atomically.
      const toUnpaid = set['cardTypeId'] !== undefined && catalogs.types.find((type) => type.id === set['cardTypeId'])?.prepaid.enabled !== true;
      if (toUnpaid && typeof stored['balance'] === 'number' && stored['balance'] > 0) {
        throw new AppError('CONFLICT', { details: [issue('balance', 'notEmpty')] });
      }
      const updateDate = dateAfter(stored['updateDate']);
      if (!(await repository.update(principal, access, id, set, updateDate, { updateDate: stored['updateDate'], cardTypeId: stored['cardTypeId'], status: stored['status'] }, toUnpaid ? { emptyBalance: true } : {}))) {
        throw new AppError('CONFLICT');
      }
      const next: Document = { ...stored, ...set, updateDate };
      await record(principal, access, client, id, 'fidelityCard.updated', loggable(stored), loggable(next));
      return resultFrom(next, catalogs, holders);
    },

    adjust: async (principal, access, id, body, client) => {
      const stored = await found(principal, access, id);
      const catalogs = await catalogsOf(access);
      const type = catalogs.types.find((candidate) => candidate.id === cardTypeIdOf(stored));
      const issues: ErrorDetail[] = [];
      if (body.balanceDelta !== undefined && type?.prepaid.enabled !== true) {
        issues.push(issue('balanceDelta', 'notAllowed'));
      }
      const allowed = allowedCollections(type);
      (body.pointsDeltas ?? []).forEach((item, index) => {
        if (!allowed.has(item.collectionId)) {
          issues.push(issue(`pointsDeltas.${String(index)}.collectionId`, 'notAllowed'));
        }
      });
      refuse(issues);
      const deltas = { ...(body.balanceDelta === undefined ? {} : { balance: body.balanceDelta }), points: body.pointsDeltas ?? [] };
      const date = new Date(deps.now());
      // Everything the answer shows is read before the write: after the commit nothing can fail (the key of the request is pinned, and a retry must not write twice).
      const holders = await holdersFor(principal, access, textOf(stored['code']) ?? '');
      // The `$inc` and the movements that explain it are one write: all or nothing. A refusal (nothing matched) writes nothing, so the transaction commits empty and the reason is looked up outside it.
      const after = await inTransaction(principal, access, async (tx) => {
        const changed = await tx.cards.adjust(principal, access, id, deltas, stored['cardTypeId']);
        if (changed !== null) {
          await tx.cards.insertMovements(principal, access, [
            ...(body.balanceDelta === undefined ? [] : [movement(principal, changed, date, body.balanceDelta, null, 0)]),
            ...(body.pointsDeltas ?? []).map((item) => movement(principal, changed, date, 0, item.collectionId, item.delta)),
          ]);
        }
        return changed;
      });
      if (after === null) {
        // Nothing matched: a value would go below zero (or is not a number), or the card went meanwhile.
        const current = await repository.findById(principal, access, id);
        const stock = isRecord(current?.['pointsCollections']) ? current['pointsCollections'] : {};
        const short = (value: unknown, delta: number): boolean => (typeof value === 'number' ? value + delta < 0 : delta < 0);
        const details: ErrorDetail[] = [
          ...(current !== null && body.balanceDelta !== undefined && short(current['balance'], body.balanceDelta) ? [issue('balance', 'insufficient')] : []),
          ...(current === null ? [] : (body.pointsDeltas ?? []).filter((item) => short(stock[item.collectionId], item.delta)).map((item) => issue(`points.${item.collectionId}`, 'insufficient'))),
        ];
        throw current === null ? new AppError('NOT_FOUND') : new AppError('CONFLICT', details.length === 0 ? {} : { details });
      }
      const balanceAfter = cardBalance(after['balance']);
      const stockAfter = isRecord(after['pointsCollections']) ? after['pointsCollections'] : {};
      const pointsAfter = Object.fromEntries((body.pointsDeltas ?? []).map((item) => [item.collectionId, stockAfter[item.collectionId] as number]));
      await record(
        principal,
        access,
        client,
        id,
        'fidelityCard.adjusted',
        { ...(body.balanceDelta === undefined || balanceAfter === null ? {} : { balance: Math.round((balanceAfter - body.balanceDelta) * 100) / 100 }), points: Object.fromEntries((body.pointsDeltas ?? []).map((item) => [item.collectionId, pointsAfter[item.collectionId]! - item.delta])) },
        { ...(body.balanceDelta === undefined ? {} : { balance: balanceAfter }), points: pointsAfter },
        { reason: body.reason ?? null },
      );
      return resultFrom(after, catalogs, holders);
    },

    movements: async (principal, access, id, query) => {
      const card = await found(principal, access, id);
      const params = listParamsOf(query, MOVEMENTS_LIST);
      const { items, page } = await repository.movements(principal, access, { id, code: textOf(card['code']) ?? '' }, params);
      const collections = (await deps.catalogs.list(pointsCollections, access)) as PointsCollection[];
      const operators = await repository.operatorNames(
        access,
        items.flatMap((item) => (item['userId'] instanceof ObjectId ? [item['userId']] : [])),
      );
      const keys = await repository.apiKeyNames(
        access,
        items.flatMap((item) => (item['apiKeyId'] instanceof ObjectId ? [item['apiKeyId']] : [])),
      );
      return {
        items: items.map((item) => {
          const collectionId = textOf(item['pointsCollectionId']);
          const userId = item['userId'] instanceof ObjectId ? item['userId'].toHexString() : null;
          const keyId = item['apiKeyId'] instanceof ObjectId ? item['apiKeyId'].toHexString() : null;
          return {
            id: (item['_id'] as ObjectId).toHexString(),
            date: dateOf(item['date']),
            type: textOf(item['type']),
            balance: numberOf(item['balance']),
            points: numberOf(item['points']),
            collection: collectionId === null ? null : { id: collectionId, name: collections.find((collection) => collection.id === collectionId)?.name ?? null },
            operator: userId !== null ? { kind: 'user' as const, id: userId, name: operators.get(userId) ?? null, ...(item['storeKeyId'] instanceof ObjectId ? { store: true as const } : {}) } : keyId !== null ? { kind: 'apiKey' as const, id: keyId, name: keys.get(keyId) ?? null } : null,
          };
        }),
        page,
      };
    },

    remove: async (principal, access, id, expected, client) => {
      const stored = await found(principal, access, id);
      if (cardVersion(stored, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const code = textOf(stored['code']) ?? '';
      // A card with a history is deactivated, never deleted: the code of a contact would turn into a simple card and the movements would lose their card. The checks and the deletion are one transaction, and the deletion
      // requires the credit and the points to be the ones read, so a sale or an adjustment that came meanwhile keeps the card.
      await inTransaction(principal, access, async (tx) => {
        const holders = await tx.contacts.cardHolderIds(principal, access, code);
        if (holders.length > 0) {
          throw new AppError('CONFLICT', { details: holders.map((holder) => issue(`contacts.${holder}`, 'referenced')) });
        }
        if (await tx.cards.hasMovements(principal, access, { id, code })) {
          throw new AppError('CONFLICT', { details: [issue('movements', 'referenced')] });
        }
        if (!(await tx.cards.remove(principal, access, id, { updateDate: stored['updateDate'], balance: stored['balance'], pointsCollections: stored['pointsCollections'] }))) {
          throw new AppError('CONFLICT');
        }
      });
      await record(principal, access, client, id, 'fidelityCard.deleted', loggable(stored), undefined);
    },
  };
}
