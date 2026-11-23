import { BSON } from 'mongodb';
import type { Document } from 'mongodb';
import { actorOf } from '../../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../../shared/http/client-context.ts';
import { AppError } from '../../../shared/http/errors.ts';
import type { ErrorDetail } from '../../../shared/http/errors.ts';
import type { Logger } from '../../../shared/logging/logger.ts';
import type { GroupAccess } from '../../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../../shared/security/scope/principal.ts';
import type { Catalog, CatalogState, Outcome } from './catalog.ts';
import type { CatalogsRepository } from './catalogs.repository.ts';
import { invalid, notFound, referenced } from './kit.ts';
import type { CatalogAnomaly } from './kit.ts';
import type { ReferencesRepository } from './references.repository.ts';
import type { Tax } from './taxes.ts';
import { taxCopyOf } from '../../product-departments/product-departments.mapper.ts';
import type { TaxDepartments } from '../../product-departments/product-departments.repository.ts';
import type { Realignment } from '../../products/products.tax.ts';

/** Most missing ids reported in the details of one refused request. */
const MAX_REPORTED_REFERENCES = 20;

/**
 * Size budget of a group document (8 MiB, half of the 16 MiB MongoDB limit). The element limits of the catalogs do not bound the document by themselves
 * (200 promotions with seven lists of 500 ids, 20 prize catalogues of 200 prizes with long texts exceed 16 MiB), and a document close to the limit would
 * make every later write to the group fail, the legacy's included. A write that makes the document grow beyond the budget is refused (`422 tooMany`
 * on `(body)`); a write that does not make it grow is always allowed, so a document already over the budget can still be reduced.
 */
export const MAX_GROUP_DOCUMENT_BYTES = 8 * 1024 * 1024;

/**
 * The places a company administrator (the places of his companies) or a place administrator (his places) may name, as computed by the server in
 * his scope; `null` for the roles that are not limited to places (PSA, dealer, group administrator).
 */
function placeScopeOf(principal: AuthPrincipal): ReadonlySet<string> | null {
  const { scope } = principal;
  return scope.kind === 'companies' || scope.kind === 'places' ? new Set(scope.placeIds.map((id) => id.toHexString())) : null;
}

/**
 * Refuses to a company or place administrator the change or the deletion of an element that applies to a place outside his scope, or to every place of
 * the group (an empty list): `403 FORBIDDEN`. The element stays readable.
 */
function guardStoredPlaces(principal: AuthPrincipal, catalog: Catalog, element: object | undefined): void {
  const allowed = placeScopeOf(principal);
  if (allowed === null || catalog.places === undefined || element === undefined) {
    return;
  }
  const { ids } = catalog.places(element);
  if (ids.length === 0 || ids.some((id) => !allowed.has(id))) {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * Refuses to a company or place administrator an element, as it would be written, that applies to places outside his scope (`403`, each refused id as
 * `<field>.<index>` `notAllowed`) or to every place of the group (an empty list, `<field>` `notAllowed`).
 */
function guardResultPlaces(principal: AuthPrincipal, catalog: Catalog, element: object | undefined): void {
  const allowed = placeScopeOf(principal);
  if (allowed === null || catalog.places === undefined || element === undefined) {
    return;
  }
  const { field, ids } = catalog.places(element);
  const details: ErrorDetail[] =
    ids.length === 0 ? [{ field, issue: 'notAllowed' }] : ids.flatMap((id, index) => (allowed.has(id) ? [] : [{ field: `${field}.${String(index)}`, issue: 'notAllowed' }]));
  if (details.length > 0) {
    throw new AppError('FORBIDDEN', { details: details.slice(0, MAX_REPORTED_REFERENCES) });
  }
}

/** The BSON size of a stored value (`0` for an absent one), to estimate how much a write changes the size of the document. */
function bsonSizeOf(value: unknown): number {
  return value === undefined ? 0 : BSON.calculateObjectSize({ v: value });
}

/** The operations on the catalogs kept in the document of a group, the same for every catalog. */
export interface CatalogsService {
  /**
   * Lists the elements of a catalog. The catalogs are bounded (each has a most-elements limit), so the list is not paginated.
   *
   * @param catalog The catalog.
   * @param access Verified access to the group.
   * @throws {AppError} `NOT_FOUND` if the group disappeared since the access was checked.
   */
  list(catalog: Catalog, access: GroupAccess): Promise<object[]>;
  /**
   * Creates an element with a server-made id and records `group.<catalog>.created`.
   *
   * @throws {AppError} `FORBIDDEN` when a company or place administrator names a place outside his scope, or no place (every place of the group);
   * `VALIDATION_ERROR` over the limit (of elements, or of the size of the group document), with a missing reference or an invalid combination; `CONFLICT` for a duplicate or a document that changed meanwhile.
   */
  create(principal: AuthPrincipal, access: GroupAccess, catalog: Catalog, body: unknown, client: ClientContext): Promise<object>;
  /**
   * Modifies an element (JSON Merge Patch; `PUT` for the loyalty rules) and records `group.<catalog>.updated`. A request that changes nothing writes and records nothing.
   *
   * @throws {AppError} `FORBIDDEN` when a company or place administrator changes an element that applies to places outside his scope (or to every place),
   * or would make it so; `VALIDATION_ERROR` for an empty body, a document that would grow beyond its size budget, a missing reference or an invalid combination; `NOT_FOUND`; `CONFLICT`.
   */
  patch(principal: AuthPrincipal, access: GroupAccess, catalog: Catalog, id: string, body: unknown, client: ClientContext): Promise<object>;
  /**
   * Deletes an element and records `group.<catalog>.deleted`.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN` when a company or place administrator deletes an element that applies to places outside his scope (or to every place);
   * `CONFLICT` for a protected element, one still referenced (a tax rate a department was given, listed as `productDepartments.<id>`, or a price of a product that is not in the trash has, listed as `products.<id>`), or a document that changed meanwhile.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, catalog: Catalog, id: string, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createCatalogsService}. */
export interface CatalogsServiceDeps {
  readonly catalogs: CatalogsRepository;
  readonly references: ReferencesRepository;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Generator of the ids of new elements. */
  readonly newId: () => string;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /**
   * The departments and the products of the group, which hold a copy of the tax rate they were given (the departments in `tax`, the prices of the products in `taxData`): a modification of a tax rate realigns the copies, and a tax rate a department or a price holds is never deleted. When
   * the group database is on the cluster of the common database the modification and the realignment are one transaction; otherwise the rate is written first and the realignment right after,
   * and as the realignment only touches the copies that differ, repeating the modification (which is then a request that changes nothing) completes what an interruption left undone.
   */
  readonly taxDepartments?: TaxDepartments;
}

/**
 * Builds the service of the catalogs of a group. Every write is one update of the group document, checked against the `updateDate` that was read, so
 * a concurrent change is a `409` and never a lost update; the references to places, products, categories and contacts are verified in the group database first.
 *
 * @param deps Repositories, activity log, logger, id generator and clock.
 */
export function createCatalogsService(deps: CatalogsServiceDeps): CatalogsService {
  const { catalogs, references, activityLog, logger, taxDepartments } = deps;

  const load = async (catalog: Catalog, access: GroupAccess): Promise<{ updateDate: unknown; size: number; state: CatalogState }> => {
    const stored = await catalogs.read(access.groupId, catalog.paths);
    if (stored === null) {
      throw notFound();
    }
    return { updateDate: stored.updateDate, size: stored.size, state: { raw: (path) => stored.values[path], newId: deps.newId } };
  };

  /** Refuses a write that makes the document grow beyond {@link MAX_GROUP_DOCUMENT_BYTES}. */
  const checkSize = (loaded: { size: number }, outcome: Outcome<object>): void => {
    const growth = outcome.changes.reduce((total, change) => total + bsonSizeOf(change.next) - bsonSizeOf(change.old), 0);
    if (growth > 0 && loaded.size + growth > MAX_GROUP_DOCUMENT_BYTES) {
      throw invalid('(body)', 'tooMany');
    }
  };

  const verifyReferences = async (principal: AuthPrincipal, access: GroupAccess, outcome: Outcome<object>): Promise<void> => {
    for (const check of outcome.references) {
      const missing = await references.missing(principal, access, check);
      if (missing.length > 0) {
        const details: ErrorDetail[] = missing.slice(0, MAX_REPORTED_REFERENCES).map((index) => ({ field: `${check.field}.${String(index)}${check.suffix ?? ''}`, issue: 'incorrect' }));
        throw new AppError('VALIDATION_ERROR', { details });
      }
    }
  };

  /**
   * The stored copy of a tax rate that a modification of the rate must write in the departments, `null` for every other write (and when the departments are not wired).
   */
  const taxCopyToSync = (catalog: Catalog, outcome: Outcome<object>, verb: 'created' | 'updated' | 'deleted'): Document | null =>
    taxDepartments !== undefined && catalog.name === 'tax' && verb === 'updated' ? taxCopyOf(outcome.after as Tax) : null;

  /**
   * Realigns the copies of a tax rate that is already written (no transaction): a failure is logged with the ids only and reported as an incomplete realignment, never as a failure of the write, which stands
   * and which repeating the request goes on from.
   */
  const realignOutside = async (access: GroupAccess, copy: Document, now: Date, principal: AuthPrincipal, client: ClientContext): Promise<Realignment> => {
    let result: Realignment;
    try {
      result = await taxDepartments!.realign(principal, access, copy, now);
    } catch (error) {
      logger.error('tax rate realignment failed', { groupId: access.groupId.toHexString(), taxId: String(copy['id']), error: error instanceof Error ? error.name : 'unknown' });
      result = { complete: false, remainingBlocks: null };
    }
    if (!result.complete) {
      // A trace that lasts: the rate is written, its copies are not all aligned, and repeating the request goes on.
      await activityLog.record({
        category: 'data',
        action: 'group.tax.realignmentIncomplete',
        outcome: 'failure',
        actor: actorOf(principal),
        groupId: access.groupId,
        resource: { type: 'group', id: access.groupId.toHexString() },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { taxId: String(copy['id']).slice(0, 64), remainingBlocks: result.remainingBlocks, skipped: result.skipped === true },
      });
    }
    return result;
  };
  const incompleteOnly = (result: Realignment): Realignment | null => (result.complete ? null : result);

  /**
   * Writes what an outcome says and records it; does nothing when the request changes nothing (but for a tax rate, whose copies in the departments are realigned anyway, so a repeated
   * request repairs an interrupted one).
   */
  const commit = async (
    principal: AuthPrincipal,
    access: GroupAccess,
    catalog: Catalog,
    loaded: { updateDate: unknown; size: number },
    outcome: Outcome<object>,
    client: ClientContext,
    verb: 'created' | 'updated' | 'deleted',
  ): Promise<Realignment | null> => {
    const copy = taxCopyToSync(catalog, outcome, verb);
    if (outcome.changes.length === 0) {
      return copy === null ? null : incompleteOnly(await realignOutside(access, copy, new Date(deps.now()), principal, client));
    }
    checkSize(loaded, outcome);
    await verifyReferences(principal, access, outcome);
    const clock = new Date(deps.now());
    // Strictly after the version read, so that two writes within the same millisecond still differ.
    const now = loaded.updateDate instanceof Date && loaded.updateDate.getTime() >= clock.getTime() ? new Date(loaded.updateDate.getTime() + 1) : clock;
    const atomic = copy === null ? null : taxDepartments!.atomic(access);
    const result =
      atomic === null
        ? await catalogs.apply(access.groupId, outcome.changes, loaded.updateDate, now)
        : await atomic(async (session) => {
            const written = await catalogs.apply(access.groupId, outcome.changes, loaded.updateDate, now, session);
            if (written === 'updated') {
              await taxDepartments!.realign(principal, access, copy!, now, session);
            }
            return written;
          });
    if (result === 'notFound') {
      throw notFound();
    }
    if (result !== 'updated') {
      throw new AppError('CONFLICT');
    }
    await recordDataChange(activityLog, {
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'group', id: access.groupId.toHexString() },
      action: `group.${catalog.name}.${verb}`,
      before: outcome.before as Readonly<Record<string, unknown>> | undefined,
      after: outcome.after as Readonly<Record<string, unknown>> | undefined,
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });
    // Without a transaction the realignment comes after the write and its record: if it fails the rate is already changed and logged, and repeating the request finishes the job.
    return copy !== null && atomic === null ? incompleteOnly(await realignOutside(access, copy, now, principal, client)) : null;
  };

  return {
    list: async (catalog, access) => {
      const { state } = await load(catalog, access);
      const anomalies: CatalogAnomaly[] = [];
      const elements = catalog.list(state, anomalies);
      if (anomalies.length > 0) {
        logger.warn('group catalog anomalies', { groupId: access.groupId.toHexString(), catalog: catalog.name, anomalies });
      }
      return elements;
    },

    create: async (principal, access, catalog, body, client) => {
      const loaded = await load(catalog, access);
      const outcome = catalog.create(body, loaded.state);
      guardResultPlaces(principal, catalog, outcome.after);
      await commit(principal, access, catalog, loaded, outcome, client, 'created');
      return outcome.after!;
    },

    patch: async (principal, access, catalog, id, body, client) => {
      if (Object.keys(body as object).length === 0) {
        throw invalid('(body)', 'required');
      }
      const loaded = await load(catalog, access);
      const outcome = catalog.patch(id, body, loaded.state);
      guardStoredPlaces(principal, catalog, outcome.before);
      guardResultPlaces(principal, catalog, outcome.after);
      const realignment = await commit(principal, access, catalog, loaded, outcome, client, 'updated');
      // A tax rate whose copies could not all be realigned is written: the answer says how far the realignment went, and repeating the request goes on.
      return realignment === null ? outcome.after! : { ...outcome.after!, realignment };
    },

    remove: async (principal, access, catalog, id, client) => {
      const loaded = await load(catalog, access);
      const outcome = catalog.remove(id, loaded.state);
      guardStoredPlaces(principal, catalog, outcome.before);
      if (taxDepartments !== undefined && catalog.name === 'tax') {
        // A tax rate a department was given cannot go: the POS reads the rate through the copy in the department.
        const users = await taxDepartments.usedBy(principal, access, id);
        if (users.length > 0) {
          throw referenced(users.map((department) => `productDepartments.${department}`));
        }
        // The same for the prices of the products that are not in the trash: the POS reads the rate through the copy in the price.
        const priced = await taxDepartments.productsUsing(principal, access, id);
        if (priced.length > 0) {
          throw referenced(priced.map((product) => `products.${product}`));
        }
      }
      await commit(principal, access, catalog, loaded, outcome, client, 'deleted');
    },
  };
}
