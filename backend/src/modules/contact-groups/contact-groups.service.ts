import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { CONTACTS_GROUPS_OWNED_FIELDS } from '../../db/collections.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf, listSearch } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { dateOf, numberOf, textOf } from '../groups/catalogs/kit.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { MAX_REPORTED_REFERENCES } from '../contacts/contacts.repository.ts';
import type { ApiKeyCaller, StoreCaller } from '../product-catalog/caller.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';
import { applyChange } from '../product-categories/categories.document.ts';
import type { ContactGroupsRepository } from './contact-groups.repository.ts';
import { CONTACT_GROUPS_LIST } from './contact-groups.schemas.ts';
import type { ContactGroupsQuery, CreateContactGroupBody, PatchContactGroupBody } from './contact-groups.schemas.ts';

/** Whoever reads the groups of contacts: a backoffice user, a public API key (`contacts:read`) or the server of a point of sale, whose perimeter is the whole group. Only the writes are the user's alone. */
export type ContactGroupsReader = AuthPrincipal | ApiKeyCaller | StoreCaller;

/** The query of {@link ContactGroupsService.list}: the one of the route, and `updatedSince` (an ISO 8601 instant). */
export type ContactGroupsListQuery = ContactGroupsQuery & { readonly updatedSince?: string | undefined };

/** A group of contacts as the API shows it. */
export interface ContactGroupView {
  readonly id: string;
  readonly name: string;
  /** The price list the contacts of the group are sold with (an enabled one of the group), `null` for none. */
  readonly priceListId: string | null;
  /** The discount of the contacts of the group, 0 to 100, `null` for none. */
  readonly discountPercent: number | null;
  /** How many contacts, not in the trash, are in the group (up to 10 000); only in the detail. */
  readonly contactsCount?: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A group of contacts with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface ContactGroupResult {
  readonly entity: ContactGroupView;
  readonly version: string;
}

/** A page of groups of contacts. */
export interface ContactGroupPage {
  readonly items: readonly ContactGroupView[];
  readonly page: PageInfo;
}

/** The operations on the groups of contacts of a group. */
export interface ContactGroupsService {
  /**
   * A page of the groups of contacts, sorted by name (or by the date of the last change) and searched by name. With `updatedSince` only the groups changed from that instant on come back, in the order of the last change unless `sort`
   * says otherwise (a group deleted for good cannot be told).
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  list(principal: ContactGroupsReader, access: GroupAccess, query: ContactGroupsListQuery): Promise<ContactGroupPage>;
  /**
   * One group of contacts, with how many contacts it has.
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: ContactGroupsReader, access: GroupAccess, id: ObjectId): Promise<ContactGroupResult>;
  /**
   * Creates a group of contacts and records it. Names are not unique (as in the legacy).
   *
   * @throws {AppError} `VALIDATION_ERROR` for a price list that does not exist or is disabled.
   */
  create(principal: AuthPrincipal, access: GroupAccess, body: CreateContactGroupBody, client: ClientContext): Promise<ContactGroupResult>;
  /**
   * Modifies a group of contacts and records it. A request that changes nothing writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` when it changed while this request ran; the errors of {@link ContactGroupsService.create}.
   */
  update(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, expected: string, body: PatchContactGroupBody, client: ClientContext): Promise<ContactGroupResult>;
  /**
   * Deletes a group of contacts for good (it has no trash) and records it.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` with the references when a contact (in the trash too) or a promotion still uses it, or when it changed meanwhile; `SERVICE_UNAVAILABLE` when the search of the contacts exceeds its time limit.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createContactGroupsService}. */
export interface ContactGroupsServiceDeps {
  readonly repository: ContactGroupsRepository;
  /** Reads the price lists of the group. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new groups of contacts. */
  readonly newId?: () => ObjectId;
}

/** A stored group of contacts as the API shows it (tolerant: a field of the wrong type is empty). */
function viewOf(document: Document, contactsCount?: number): ContactGroupView {
  const discount = numberOf(document['discountPercentage']);
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: textOf(document['name']) ?? '',
    priceListId: textOf(document['priceListId']) || null,
    discountPercent: discount !== null && discount >= 0 && discount <= 100 ? discount : null,
    ...(contactsCount === undefined ? {} : { contactsCount }),
    createdAt: dateOf(document['insertDate']),
    updatedAt: dateOf(document['updateDate']),
  };
}

/**
 * Builds the service of the groups of contacts of a group: the name, the price list and the discount the legacy keeps, with versions, the refusal to delete a group that is still used (by a contact, in the trash too, or by a
 * promotion) and the activity log. A group of contacts has no trash.
 *
 * @param deps The repository and the collaborators.
 */
export function createContactGroupsService(deps: ContactGroupsServiceDeps): ContactGroupsService {
  const { repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const versionOf = (document: Document): string => entityVersion(document, CONTACTS_GROUPS_OWNED_FIELDS, versionKey);
  const found = async (principal: ContactGroupsReader, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  const record = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Document | undefined, after: Document | undefined) => {
    const loggable = (document: Document | undefined) => {
      const view = document === undefined ? undefined : viewOf(document);
      return view === undefined ? undefined : { name: view.name, priceListId: view.priceListId, discountPercent: view.discountPercent };
    };
    return recordDataChange(activityLog, {
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'contactGroup', id: id.toHexString() },
      action,
      before: loggable(before),
      after: loggable(after),
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });
  };
  /** The price list of a request must be an enabled one of the group. */
  const assertPriceList = async (access: GroupAccess, id: string | null | undefined): Promise<void> => {
    if (id !== undefined && id !== null && !((await deps.catalogs.list(priceLists, access)) as PriceList[]).some((list) => list.id === id && list.enabled)) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'priceListId', issue: 'incorrect' }] });
    }
  };
  const stored = (value: number | null): unknown => (value === null ? null : new Double(value));

  return {
    list: async (principal, access, query) => {
      const params = listParamsOf({ ...query, ...(query.sort === undefined && query.updatedSince !== undefined ? { sort: 'updatedAt' } : {}) }, CONTACT_GROUPS_LIST);
      const search = listSearch(params, CONTACT_GROUPS_LIST);
      const filter = query.updatedSince === undefined ? search : { $and: [search, { updateDate: { $gte: new Date(query.updatedSince) } }] };
      const { items, page } = await repository.list(principal, access, filter, params);
      return { items: items.map((document) => viewOf(document)), page };
    },

    get: async (principal, access, id) => {
      const document = await found(principal, access, id);
      return { entity: viewOf(document, await repository.countContacts(principal, access, id)), version: versionOf(document) };
    },

    create: async (principal, access, body, client) => {
      await assertPriceList(access, body.priceListId);
      const now = new Date(deps.now());
      const document: Document = { _id: newId(), name: body.name, priceListId: body.priceListId ?? null, discountPercentage: stored(body.discountPercent ?? null), insertDate: now, updateDate: now };
      await repository.insert(principal, access, document);
      // The number written as a `Double` is read back as a plain number, so the version is the one a later read gives.
      const readBack = applyChange(document, { discountPercentage: document['discountPercentage'] }, {});
      await record(principal, access, client, document['_id'] as ObjectId, 'contactGroup.created', undefined, readBack);
      return { entity: viewOf(readBack), version: versionOf(readBack) };
    },

    update: async (principal, access, id, expected, body, client) => {
      const current = await found(principal, access, id);
      if (versionOf(current) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      // A price list is judged only when the request changes it, so one that was disabled since never blocks an unrelated change.
      if (body.priceListId !== undefined && body.priceListId !== (textOf(current['priceListId']) ?? null)) {
        await assertPriceList(access, body.priceListId);
      }
      const wanted: Document = { name: body.name, priceListId: body.priceListId, discountPercentage: body.discountPercent === undefined ? undefined : stored(body.discountPercent) };
      const set: Document = {};
      for (const [key, value] of Object.entries(wanted)) {
        const plain = value instanceof Double ? value.valueOf() : value;
        if (value !== undefined && plain !== (current[key] as unknown)) {
          set[key] = value;
        }
      }
      if (Object.keys(set).length === 0) {
        return { entity: viewOf(current, await repository.countContacts(principal, access, id)), version: versionOf(current) };
      }
      const readDate: unknown = current['updateDate'];
      const clock = new Date(deps.now());
      const updateDate = readDate instanceof Date && readDate.getTime() >= clock.getTime() ? new Date(readDate.getTime() + 1) : clock;
      const readValues = Object.fromEntries(Object.keys(set).map((key) => [key, current[key] as unknown]));
      if (!(await repository.update(principal, access, id, { set, updateDate, readValues }, readDate))) {
        throw new AppError('CONFLICT');
      }
      const next = applyChange(current, set, {});
      next['updateDate'] = updateDate;
      await record(principal, access, client, id, 'contactGroup.updated', current, next);
      return { entity: viewOf(next, await repository.countContacts(principal, access, id)), version: versionOf(next) };
    },

    remove: async (principal, access, id, expected, client) => {
      const current = await found(principal, access, id);
      if (versionOf(current) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const users = await repository.contactsOf(principal, access, id);
      if (users.length > 0) {
        throw new AppError('CONFLICT', { details: users.map((user) => ({ field: `contacts.${user}`, issue: 'referenced' })) });
      }
      const promoted = await repository.promotionsNaming(access, id);
      if (promoted.length > 0) {
        throw new AppError('CONFLICT', { details: promoted.slice(0, MAX_REPORTED_REFERENCES).map((promotion) => ({ field: `promotions.${promotion}`, issue: 'referenced' })) });
      }
      if (!(await repository.remove(principal, access, id, current['updateDate']))) {
        throw new AppError('CONFLICT');
      }
      await record(principal, access, client, id, 'contactGroup.deleted', current, undefined);
    },
  };
}
