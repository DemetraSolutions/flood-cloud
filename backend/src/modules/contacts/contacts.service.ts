import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { computeChanges } from '../../shared/activity-log/changes.ts';
import type { FieldChange } from '../../shared/activity-log/changes.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { escapeRegExp, listParamsOf } from '../../shared/http/list.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { settleItem } from '../../shared/trash/trash.ts';
import type { TrashItemOutcome, VersionCheck } from '../../shared/trash/trash.ts';
import type { Country } from '../companies/companies.repository.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { isRecord, newElementId, recordsOf, textOf } from '../groups/catalogs/kit.ts';
import { HIDDEN_ADVANCED_CARD, advancedCard } from '../fidelity-cards/fidelity-cards.document.ts';
import { cardTypes } from '../groups/catalogs/card-types.ts';
import type { CardType } from '../groups/catalogs/card-types.ts';
import { pointsCollections } from '../groups/catalogs/points-collections.ts';
import type { PointsCollection } from '../groups/catalogs/points-collections.ts';
import type { AdvancedCard } from '../fidelity-cards/fidelity-cards.document.ts';
import { hasPermission } from '../../shared/security/rbac/policy.ts';
import { actorOfCaller, operatorMetadata } from '../product-catalog/caller.ts';
import type { ApiKeyCaller, StoreCaller } from '../product-catalog/caller.ts';
import { applyChange } from '../product-categories/categories.document.ts';
import { blankContact, cardsOf, clearText, contactComparable, contactData, contactVersion } from './contacts.document.ts';
import { contactRow, contactView } from './contacts.mapper.ts';
import type { ContactRow, ContactView } from './contacts.mapper.ts';
import { planContact } from './contacts.plan.ts';
import type { ContactPlan, PlanDeps } from './contacts.plan.ts';
import { guardContactRemoval } from './contacts.removal.ts';
import type { ContactsRepository } from './contacts.repository.ts';
import { CONTACTS_LIST } from './contacts.schemas.ts';
import type { ContactsQuery, CreateContactBody, PatchContactBody, PointsAdjustmentBody } from './contacts.schemas.ts';

/**
 * Whoever works on the contacts: a backoffice user, a public API key (`contacts:read`, `contacts:write`) or the server of a point of sale (its store key, with the operator of a write): the perimeter of the last two is the whole group,
 * because the contacts have no place. A store sees everything an advanced card holds and may add and take away the codes of advanced cards (its operator holds the `contacts` permission of the point of sale).
 */
export type ContactsCaller = AuthPrincipal | ApiKeyCaller | StoreCaller;

/** The query of {@link ContactsService.listChanges}: the one of the list, and `updatedSince` (an ISO 8601 instant). */
export type ContactsChangesQuery = ContactsQuery & { readonly updatedSince?: string | undefined };

/** A page of contacts as the detail shows them (without the warnings of the duplicates). */
export interface ContactViewPage {
  readonly items: readonly ContactView[];
  readonly page: PageInfo;
}

/** How many contacts a warning names at most (the others are counted). */
export const MAX_WARNING_CONTACTS = 5;

/** A value that other contacts use too (the save went through: it is a warning, never an error). */
export interface DuplicateWarning {
  /** `code`, `person.taxCode`, `company.vatNumber` or `company.taxCode`. */
  readonly field: string;
  readonly issue: 'duplicate';
  /** The contacts, not in the trash, that use the value: at most {@link MAX_WARNING_CONTACTS}. */
  readonly contactIds: readonly string[];
  /** How many other contacts use it that are not named (the ones beyond the first five). */
  readonly others: number;
}

/** A contact; the answers of a creation, a modification and a detail have the warnings of its code, tax codes and VAT number, the others (trash, restore) do not. */
export type ContactDetail = ContactView & { readonly warnings?: readonly DuplicateWarning[] };

/** A contact with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface ContactResult {
  readonly entity: ContactDetail;
  readonly version: string;
}

/** A page of the rows of the list. */
export interface ContactPage {
  readonly items: readonly ContactRow[];
  readonly page: PageInfo;
}

/** What became of one contact of a bulk trash. */
export type TrashManyItem = { readonly id: string; readonly outcome: 'trashed' } | { readonly id: string; readonly outcome: 'skipped'; readonly issue: 'notFound' | 'alreadyTrashed' | 'conflict' };

/** The balance of a card after an adjustment. */
export interface PointsResult {
  readonly code: string;
  readonly points: number;
}

/** The operations on the contacts of a group. */
export interface ContactsService {
  /**
   * A page of the contacts of the group, filtered and sorted.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort; `SERVICE_UNAVAILABLE` when the search exceeds its time limit.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: ContactsQuery): Promise<ContactPage>;
  /**
   * A page of the contacts as the detail shows them (every field and the loyalty cards, without the warnings), filtered and sorted as {@link ContactsService.list}. With `updatedSince` the contacts changed from that instant come back, the ones in the
   * trash included unless `trashed` says otherwise, in the order of the last change unless `sort` says otherwise; a contact deleted for good cannot be told.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort; `SERVICE_UNAVAILABLE` when the search exceeds its time limit.
   */
  listChanges(caller: ContactsCaller, access: GroupAccess, query: ContactsChangesQuery): Promise<ContactViewPage>;
  /**
   * One contact, with the warnings of its code, tax codes and VAT number.
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: ContactsCaller, access: GroupAccess, id: ObjectId): Promise<ContactResult>;
  /**
   * Creates a contact in the shape the legacy writes and records it. A code, tax code or VAT number another contact uses is a warning in the answer, never an error.
   *
   * @throws {AppError} `VALIDATION_ERROR` for a missing name and company name, a country, province, group of contacts, price list, company or service that does not exist, and the services of a group that lacks the function; `CONFLICT` with `taken` for an account another contact has.
   */
  create(principal: ContactsCaller, access: GroupAccess, body: CreateContactBody, client: ClientContext): Promise<ContactResult>;
  /**
   * Modifies a contact (the objects `person`, `company`, `eInvoicing` and `account` and the addresses field by field, the lists replaced as a whole, the cards by their codes) and records it. A request that changes nothing writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED` when the contact is not at the version the client read; `CONFLICT` when it is in the trash, or changed while this request ran, or on `taken` and `referenced`; the errors of {@link ContactsService.create}.
   */
  update(principal: ContactsCaller, access: GroupAccess, id: ObjectId, expected: string, body: PatchContactBody, client: ClientContext): Promise<ContactResult>;
  /**
   * Moves a contact to the trash (never blocked by its references) and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` when it is already in the trash or changed meanwhile.
   */
  trash(principal: ContactsCaller, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<ContactResult>;
  /**
   * Takes a contact out of the trash and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` when it is not in the trash or changed meanwhile.
   */
  restore(principal: ContactsCaller, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<ContactResult>;
  /**
   * Deletes a contact that is in the trash for good and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` when it is not in the trash, with the references when something still names it (`referenced`), or when it changed meanwhile; `SERVICE_UNAVAILABLE` when the search of the references exceeds its time limit.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<void>;
  /**
   * Moves several contacts to the trash, one after the other, each as the single-item route does; one that cannot be moved is skipped with its reason and never stops the others.
   *
   * @param ids 1 to 100 contacts, without repetitions.
   */
  trashMany(principal: AuthPrincipal, access: GroupAccess, ids: readonly ObjectId[], client: ClientContext): Promise<{ readonly results: readonly TrashManyItem[] }>;
  /** Takes a contact out of the trash for the trash page: exactly {@link ContactsService.restore}, with the version read just now, and a refusal as the issue. */
  restoreFromTrash(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /** Deletes a contact from the trash for the trash page: exactly {@link ContactsService.remove}, with the version read just now, and a refusal as the issue. */
  deleteFromTrash(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /** The ids of the contacts in the trash, in `_id` order, at most `limit`, after a cursor. */
  trashedIds(principal: AuthPrincipal, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /** How many contacts are in the trash. */
  countTrashed(principal: AuthPrincipal, access: GroupAccess): Promise<number>;
  /**
   * Adds points to the balance of a card of a contact (or takes them away), atomically, without touching the version of the contact, and records it.
   *
   * @throws {AppError} `NOT_FOUND` when the contact (not in the trash) or the card does not exist; `CONFLICT` with `points`/`insufficient` when the balance would go below zero.
   */
  adjustPoints(principal: ContactsCaller, access: GroupAccess, id: ObjectId, code: string, body: PointsAdjustmentBody, client: ClientContext): Promise<PointsResult>;
}

/** Collaborators of {@link createContactsService}. */
export interface ContactsServiceDeps {
  readonly repository: ContactsRepository;
  /** Reads the price lists and the promotions of the group. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
  /** Reads a country of the platform by its code. */
  readonly findCountry: (code: string) => Promise<Country | null>;
  readonly activityLog: ActivityLog;
  /** Counts the definitive deletions of contacts per user. */
  readonly rateLimiter: RateLimiter;
  /** The limit of the definitive deletions of contacts per user and hour (`contactDeletePerUser`): every contact counts, deleted alone or in a bulk call. */
  readonly deleteRule: RateLimitRule;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new contacts. */
  readonly newId?: () => ObjectId;
  /** Generator of the ids of new supplier price lists. */
  readonly newElementId?: () => string;
}

/** `409` for a contact that changed (or went) between its read and its write; it is told apart from the one of a contact in the wrong state only by the bulk trash. */
class ChangedMeanwhile extends AppError {
  constructor() {
    super('CONFLICT');
  }
}

/** `409` for a contact in the trash, which only the trash operations touch. */
const trashedConflict = (): AppError => new AppError('CONFLICT', { details: [{ field: 'trashed', issue: 'incorrect' }] });

/**
 * The filter of the search `q`: the text, literal and without regard to case, is *contained* in the first name, the surname or the company name, or is *equal* to the code, a tax code, the VAT number, the code of a card
 * or an e-mail; with two words, the first name and the surname in either order are looked for too. Every text is escaped. There is no index: the read has a time limit and answers `503` when it passes.
 *
 * @param q The search text, trimmed.
 */
export function contactSearch(q: string): Filter<Document> {
  const contains = (text: string): Document => ({ $regex: escapeRegExp(text), $options: 'i' });
  const equals = (text: string): Document => ({ $regex: `^${escapeRegExp(text)}$`, $options: 'i' });
  const words = q.split(/\s+/);
  return {
    $or: [
      { name: contains(q) },
      { surname: contains(q) },
      { companyName: contains(q) },
      ...['contactCode', 'code', 'companyCode', 'companyCode2', 'fidelities.code', 'email', 'companyEmail'].map((field) => ({ [field]: equals(q) })),
      ...(words.length === 2 ? [{ name: contains(words[0]!), surname: contains(words[1]!) }, { name: contains(words[1]!), surname: contains(words[0]!) }] : []),
    ],
  };
}

/** The condition on the state of a contact: in the trash only when `trashed` is `true`, else not in the trash. */
const trashCondition = (trashed: boolean | undefined): Filter<Document> => (trashed === true ? { trash: true } : { trash: { $ne: true } });

/**
 * The conditions of a list of contacts: the ones given (the state, the date), the kind, the group of contacts and the search text.
 *
 * @param query The validated query.
 * @param q The search text of the parameters of the list, or `null`.
 * @param base The conditions the caller has already worked out (at least one).
 */
function filterOf(query: ContactsQuery, q: string | null, base: readonly Filter<Document>[]): Filter<Document>[] {
  const conditions = [...base];
  if (query.kind === 'customers') {
    conditions.push({ customer: true });
  } else if (query.kind === 'suppliers') {
    conditions.push({ supplier: true });
  } else if (query.kind === 'others') {
    conditions.push({ customer: { $ne: true }, supplier: { $ne: true } });
  }
  if (query.contactGroupId !== undefined) {
    conditions.push({ cGroupId: { $in: [ObjectId.createFromHexString(query.contactGroupId), query.contactGroupId] } });
  }
  if (q !== null) {
    conditions.push(contactSearch(q));
  }
  return conditions;
}

/**
 * Builds the service of the contacts of a group: the whole of the contact form of the legacy backoffice (the general data, the personal and company data with the e-invoice, the loyalty cards, the services and the account of
 * the customer), shared by every place of the group, with the trash, the versions, the warnings of the duplicates, the refusal to delete what is still used and the activity log, which records the names of the changed fields and never a value.
 *
 * @param deps The repository and the collaborators.
 */
export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  const { repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const planDeps: PlanDeps = { repository, catalogs: deps.catalogs, findCountry: deps.findCountry, newElementId: deps.newElementId ?? newElementId };
  const versionOf = (document: Document): string => contactVersion(document, versionKey);

  const found = async (principal: ContactsCaller, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  const refuse = (plan: ContactPlan): void => {
    if (plan.issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: plan.issues.slice(0, 20) });
    }
    if (plan.conflicts.length > 0) {
      throw new AppError('CONFLICT', { details: plan.conflicts.slice(0, 20) });
    }
  };
  /** The other contacts, not in the trash, that use the code, a tax code or the VAT number of a contact, as warnings. */
  const warningsOf = async (principal: ContactsCaller, access: GroupAccess, document: Document): Promise<DuplicateWarning[]> => {
    const data = contactData(document);
    const orNull = (value: string): string | null => (value === '' ? null : value);
    const fields: ReadonlyArray<readonly [string, string, string | null]> = [
      ['code', 'contactCode', orNull(data.code)],
      ['person.taxCode', 'code', orNull(data.person.taxCode)],
      ['company.vatNumber', 'companyCode', orNull(data.company.vatNumber)],
      ['company.taxCode', 'companyCode2', orNull(data.company.taxCode)],
    ];
    const others = await repository.usingValues(principal, access, document['_id'] as ObjectId, { code: fields[0]![2], taxCode: fields[1]![2], vatNumber: fields[2]![2], companyTaxCode: fields[3]![2] });
    return fields.flatMap(([field, stored, value]) => {
      const matches = value === null ? [] : others.filter((other) => textOf(other[stored])?.trim() === value);
      const named = matches.slice(0, MAX_WARNING_CONTACTS);
      return matches.length === 0 ? [] : [{ field, issue: 'duplicate' as const, contactIds: named.map((other) => (other['_id'] as ObjectId).toHexString()), others: matches.length - named.length }];
    });
  };
  /** Whether a caller may see what an advanced card holds (`fidelity:read` for a user, `fidelityCards:read` for a public key, always for a store). */
  const seesCards = (caller: ContactsCaller): boolean => ('kind' in caller ? caller.kind === 'store' || caller.permissions?.has('fidelityCards:read') === true : hasPermission(caller, 'fidelity:read'));
  /** The advanced cards that have a code of some contacts (one read of `fidelity_cards` with the codes, and the card types and points collections of the group), by code. */
  const advancedOfAll = async (principal: ContactsCaller, access: GroupAccess, documents: readonly Document[]): Promise<Map<string, AdvancedCard>> => {
    const codes = [...new Set(documents.flatMap((document) => cardsOf(document['fidelities']).map((card) => card.code)))];
    if (codes.length === 0) {
      return new Map();
    }
    // Without the permission to read the cards the contact only says that the code is an advanced card: no id, type, state, credit or points.
    if (!seesCards(principal)) {
      return new Map((await repository.advancedCards(principal, access, codes)).map((card) => [card['code'] as string, HIDDEN_ADVANCED_CARD]));
    }
    const [cards, types, collections] = await Promise.all([repository.advancedCards(principal, access, codes), deps.catalogs.list(cardTypes, access), deps.catalogs.list(pointsCollections, access)]);
    const catalogs = { types: types as CardType[], collections: collections as PointsCollection[], now: deps.now() };
    return new Map(cards.map((card) => [card['code'] as string, advancedCard(card, catalogs)]));
  };
  const advancedOf = (principal: ContactsCaller, access: GroupAccess, document: Document): Promise<Map<string, AdvancedCard>> => advancedOfAll(principal, access, [document]);
  /**
   * A public key that adds or takes away the code of an advanced card needs `fidelityCards:write` too (the code is the link that gives a contact the credit of the card): the codes of simple cards need `contacts:write` alone.
   * A user is not asked (his own permissions are the route's), and neither is a store (its operator holds the permission of the contacts and of their cards).
   */
  const guardAdvancedCodes = async (caller: ContactsCaller, access: GroupAccess, plan: ContactPlan): Promise<void> => {
    const codes = [...plan.added, ...plan.removed];
    if ('kind' in caller && caller.kind === 'apiKey' && codes.length > 0 && caller.permissions?.has('fidelityCards:write') !== true && (await repository.isAdvancedCard(caller, access, codes))) {
      throw new AppError('FORBIDDEN');
    }
  };
  const resultOf = async (principal: ContactsCaller, access: GroupAccess, document: Document, withWarnings = true): Promise<ContactResult> => ({
    entity: { ...contactView(document, access.features, await advancedOf(principal, access, document)), ...(withWarnings ? { warnings: await warningsOf(principal, access, document) } : {}) },
    version: versionOf(document),
  });
  /** The `metadata` of the entry of a write: the indicator of the public key that made it (`keyHint`), nothing for a user. */
  const metadataOf = (caller: ContactsCaller): { readonly metadata?: Record<string, string> } => {
    const metadata = operatorMetadata(caller);
    return Object.keys(metadata).length === 0 ? {} : { metadata };
  };
  /** Records a write with the names of the fields it changed, never their values (they are personal data). */
  const recordFields = (principal: ContactsCaller, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Document | undefined, after: Document | undefined): Promise<void> => {
    const changes: FieldChange[] = computeChanges(before === undefined ? undefined : contactComparable(before), after === undefined ? undefined : contactComparable(after)).map((change) => ({ field: change.field, redacted: true as const }));
    return activityLog.record({
      category: 'data',
      action,
      outcome: 'success',
      actor: actorOfCaller(principal),
      groupId: access.groupId,
      resource: { type: 'contact', id: id.toHexString() },
      ...(changes.length === 0 ? {} : { changes }),
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      ...metadataOf(principal),
    });
  };
  const recordState = (principal: ContactsCaller, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, trashed: boolean) =>
    recordDataChange(activityLog, {
      actor: actorOfCaller(principal),
      groupId: access.groupId,
      resource: { type: 'contact', id: id.toHexString() },
      action,
      before: { trashed: !trashed },
      after: { trashed },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      ...metadataOf(principal),
    });
  /** The date of a change: strictly after the date read, so that two changes within the same millisecond still have different versions. */
  const dateAfter = (read: unknown): Date => {
    const clock = new Date(deps.now());
    return read instanceof Date && read.getTime() >= clock.getTime() ? new Date(read.getTime() + 1) : clock;
  };
  const checkVersion = (stored: Document, check: VersionCheck): void => {
    if (check.kind === 'ifMatch' && versionOf(stored) !== check.version) {
      throw new AppError('PRECONDITION_FAILED');
    }
  };
  /** Moves a contact to the trash or out of it: the contact must be in the opposite state; `check` is the `If-Match` of the request, or `bulk` (an item of a bulk call, which has no version). */
  const changeState = async (principal: ContactsCaller, access: GroupAccess, id: ObjectId, check: VersionCheck, client: ClientContext, to: 'trashed' | 'restored'): Promise<Document> => {
    const stored = await found(principal, access, id);
    if ((stored['trash'] === true) === (to === 'trashed')) {
      throw new AppError('CONFLICT');
    }
    checkVersion(stored, check);
    const now = dateAfter(stored['updateDate']);
    if (!(await repository.setTrash(principal, access, id, to, now, { updateDate: stored['updateDate'], trash: stored['trash'] }))) {
      throw new ChangedMeanwhile();
    }
    const next: Document = { ...stored, trash: to === 'trashed', updateDate: now };
    if (to === 'trashed') {
      next['trashDate'] = now;
    } else {
      delete next['trashDate'];
    }
    await recordState(principal, access, client, id, to === 'trashed' ? 'contact.trashed' : 'contact.restored', to === 'trashed');
    return next;
  };
  /** Deletes a contact that is in the trash; `check` as in {@link changeState}. */
  const deleteTrashed = async (principal: AuthPrincipal, access: GroupAccess, id: ObjectId, check: VersionCheck, client: ClientContext): Promise<void> => {
    const stored = await found(principal, access, id);
    if (stored['trash'] !== true) {
      throw new AppError('CONFLICT');
    }
    checkVersion(stored, check);
    // The checks of the references are the costly part (nothing they look at has an index): every contact counts against the hourly limit of the user.
    const rule = deps.deleteRule;
    const decision = await deps.rateLimiter.consume(rule.bucket, principal.userId.toHexString(), rule.limit, rule.windowSeconds);
    if (!decision.allowed) {
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(decision.resetSeconds) } });
    }
    await guardContactRemoval({ repository, now: deps.now }, principal, access, id);
    if (!(await repository.removeTrashed(principal, access, id, { updateDate: stored['updateDate'] }))) {
      throw new AppError('CONFLICT');
    }
    await recordFields(principal, access, client, id, 'contact.deleted', undefined, undefined);
  };

  return {
    list: async (principal, access, query) => {
      const params = listParamsOf(query, CONTACTS_LIST);
      const { items, page } = await repository.list(principal, access, { $and: filterOf(query, params.q, [trashCondition(query.trashed)]) }, params);
      return { items: items.map(contactRow), page };
    },

    listChanges: async (principal, access, query) => {
      // From an instant on, the contacts in the trash are changes too (they are how the integration learns of a removal), unless the request asks for one state.
      const state = query.updatedSince !== undefined && query.trashed === undefined ? [] : [trashCondition(query.trashed)];
      const since = query.updatedSince === undefined ? [] : [{ updateDate: { $gte: new Date(query.updatedSince) } }];
      const params = listParamsOf({ ...query, ...(query.sort === undefined && query.updatedSince !== undefined ? { sort: 'updatedAt' } : {}) }, CONTACTS_LIST);
      const { items, page } = await repository.listFull(principal, access, { $and: filterOf(query, params.q, [...state, ...since]) }, params);
      const advanced = await advancedOfAll(principal, access, items);
      return { items: items.map((document) => contactView(document, access.features, advanced)), page };
    },

    get: async (principal, access, id) => resultOf(principal, access, await found(principal, access, id)),

    create: async (principal, access, body, client) => {
      const id = newId();
      const blank = blankContact({ id, now: new Date(deps.now()) });
      const plan = await planContact(planDeps, { principal, access, id, stored: blank, body, creating: true });
      refuse(plan);
      await guardAdvancedCodes(principal, access, plan);
      const document: Document = { ...applyChange(blank, plan.set, plan.unset), fidelities: plan.added.map((code) => ({ code, points: 0 })) };
      await repository.insert(principal, access, document);
      await recordFields(principal, access, client, id, 'contact.created', blank, document);
      return resultOf(principal, access, document);
    },

    update: async (principal, access, id, expected, body, client) => {
      const stored = await found(principal, access, id);
      if (stored['trash'] === true) {
        throw trashedConflict();
      }
      checkVersion(stored, { kind: 'ifMatch', version: expected });
      const plan = await planContact(planDeps, { principal, access, id, stored, body, creating: false });
      refuse(plan);
      await guardAdvancedCodes(principal, access, plan);
      if (!plan.changed) {
        return resultOf(principal, access, stored);
      }
      const readDate: unknown = stored['updateDate'];
      const updateDate = dateAfter(readDate);
      const outcome = await repository.update(principal, access, id, { set: plan.set, unset: plan.unset, containers: plan.containers, updateDate, readValues: plan.readValues, added: plan.added, removed: plan.removed }, readDate);
      if (outcome !== 'updated') {
        throw new AppError('CONFLICT');
      }
      // The cards of the document after the write: the others are as they were (balance included), the removed ones are gone and the added ones start at zero.
      const cards = (Array.isArray(stored['fidelities']) ? (stored['fidelities'] as unknown[]) : []).filter((card) => !(isRecord(card) && plan.removed.includes(card['code'] as string)));
      const next: Document = { ...applyChange(stored, plan.set, plan.unset), fidelities: [...cards, ...plan.added.map((code) => ({ code, points: 0 }))], updateDate };
      await recordFields(principal, access, client, id, 'contact.updated', stored, next);
      return resultOf(principal, access, next);
    },

    trash: async (principal, access, id, expected, client) => resultOf(principal, access, await changeState(principal, access, id, { kind: 'ifMatch', version: expected }, client, 'trashed'), false),

    restore: async (principal, access, id, expected, client) => resultOf(principal, access, await changeState(principal, access, id, { kind: 'ifMatch', version: expected }, client, 'restored'), false),

    remove: (principal, access, id, expected, client) => deleteTrashed(principal, access, id, { kind: 'ifMatch', version: expected }, client),

    trashMany: async (principal, access, ids, client) => {
      const results: TrashManyItem[] = [];
      for (const id of [...new Map(ids.map((candidate) => [candidate.toHexString(), candidate])).values()]) {
        let raced = false;
        const outcome = await settleItem(async () => {
          try {
            await changeState(principal, access, id, { kind: 'bulk' }, client, 'trashed');
          } catch (error) {
            raced = error instanceof ChangedMeanwhile;
            throw error;
          }
        });
        results.push(outcome.done ? { id: id.toHexString(), outcome: 'trashed' } : { id: id.toHexString(), outcome: 'skipped', issue: raced ? 'conflict' : outcome.issue === 'notFound' ? 'notFound' : 'alreadyTrashed' });
      }
      return { results };
    },

    restoreFromTrash: (principal, access, id, client) => settleItem(() => changeState(principal, access, id, { kind: 'bulk' }, client, 'restored')),

    deleteFromTrash: (principal, access, id, client) => settleItem(() => deleteTrashed(principal, access, id, { kind: 'bulk' }, client)),

    trashedIds: (principal, access, limit, after) => repository.trashedIds(principal, access, limit, after),

    countTrashed: (principal, access) => repository.countTrashed(principal, access),

    adjustPoints: async (principal, access, id, code, body, client) => {
      // The card is looked for by the code it is stored with (the one shown is cleaned): none is 404, two with the same code are ambiguous.
      const stored = await repository.cardsOf(principal, access, id);
      const codes = stored === null ? [] : recordsOf(stored['fidelities']).flatMap((card) => (clearText(card['code']) === code ? [card['code'] as string] : []));
      if (codes.length === 0) {
        throw new AppError('NOT_FOUND');
      }
      if (codes.length > 1) {
        throw new AppError('CONFLICT', { details: [{ field: 'code', issue: 'duplicate' }] });
      }
      // The points of an advanced card are its own (credit and collections): the adjustments of the card are the way to change them.
      if (await repository.isAdvancedCard(principal, access, [code, codes[0]!])) {
        throw new AppError('CONFLICT', { details: [{ field: 'code', issue: 'advancedCard' }] });
      }
      const balance = await repository.adjustPoints(principal, access, id, codes[0]!, body.delta);
      if (balance === null) {
        // The balance would go below zero, is not a number, or the card changed meanwhile.
        throw new AppError('CONFLICT', { details: [{ field: 'points', issue: 'insufficient' } satisfies ErrorDetail] });
      }
      await activityLog.record({
        category: 'data',
        action: 'contact.pointsAdjusted',
        outcome: 'success',
        actor: actorOfCaller(principal),
        groupId: access.groupId,
        resource: { type: 'contact', id: id.toHexString() },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { cardCode: code, delta: body.delta, balance, reason: body.reason ?? null, ...operatorMetadata(principal) },
      });
      return { code, points: balance };
    },
  };
}
