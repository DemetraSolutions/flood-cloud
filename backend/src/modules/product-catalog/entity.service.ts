import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BSON, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { ListConfig } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { actorOfCaller, languageOfCaller, operatorMetadata } from './caller.ts';
import type { CatalogCaller } from './caller.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { dateOf, valueAt } from '../groups/catalogs/kit.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { assertWritablePlaces, isWritablePlaces, placeIdsOf, placesWrite, shownPlaceIds } from './availability.ts';
import type { EntityRepository } from './entity.repository.ts';
import type { GroupLanguages } from './group-languages.ts';
import { imageOf, imageWrite, newMedias } from './image.ts';
import { ENTITY_CHANGES_LIST } from './entity.schemas.ts';
import { languageIssues, mergeTexts, nameSearch, requiredLanguage, textsOf } from './texts.ts';
import type { Texts, TextsPatch } from './texts.ts';

/** The fields every department and brand has in the body of a creation. */
export interface EntityCreateBody {
  /** The name by language; at least a text in the required language. */
  readonly name: Texts;
  readonly description?: Texts;
  readonly enabled?: boolean;
  /** The places the entry is for, none for every place. */
  readonly placeIds?: readonly string[];
  /** An image of the library of the group, by its id. */
  readonly image?: { readonly imageId: string } | null;
}

/** The fields every department and brand has in the body of a modification. */
export interface EntityPatchBody {
  readonly name?: TextsPatch;
  readonly description?: TextsPatch;
  readonly enabled?: boolean;
  readonly placeIds?: readonly string[];
  readonly image?: { readonly imageId: string } | null;
}

/** The query of a list of departments or brands. */
export interface EntityQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: string;
  readonly q?: string;
  readonly enabled?: boolean;
}

/** What a read of the changes of a collection asks: the page and the instant the changes are counted from (every entry when left out). */
export interface EntityChangesQuery {
  readonly limit?: number;
  readonly cursor?: string;
  /** An instant, normalized ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
  readonly updatedSince?: string;
  /** Only the enabled entries, with or without `updatedSince` (what an integration lists when it asks for no instant). */
  readonly activeOnly?: boolean;
}

/** What every department and brand shows. */
export interface EntityView {
  readonly id: string;
  readonly name: Texts;
  readonly description: Texts;
  readonly enabled: boolean;
  /** The places the entry is for: empty for every place. A company or place administrator is shown only the ones of his perimeter. */
  readonly placeIds: readonly string[];
  /** Whether the caller may modify and delete the entry: always, except for a company or place administrator, who may only when the entry names places and all of them are his. Computed by the server. */
  readonly editable: boolean;
  /** The image chosen from the library; only in a group that has the `media` feature. */
  readonly image?: MediaLogo | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** An entry with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface EntityResult<V> {
  readonly entity: V;
  readonly version: string;
}

/** A page of entries. */
export interface EntityPage<V> {
  readonly items: readonly V[];
  readonly page: PageInfo;
}

/** The caller and the group of an operation. */
export interface KindContext {
  readonly principal: CatalogCaller;
  readonly access: GroupAccess;
}

/** What makes a department different from a brand: the fields only it has, the rules only it has and the names it is logged under. */
export interface EntityKind<X extends object, C extends EntityCreateBody, P extends EntityPatchBody> {
  /** Type of the resource in the activity log. */
  readonly resource: 'productDepartment' | 'productBrand';
  /** The three actions of the activity log. */
  readonly actions: { readonly created: DataAction; readonly updated: DataAction; readonly deleted: DataAction };
  /** The fields of the collection this backend owns: the version of an entry covers all of them. */
  readonly ownedFields: readonly string[];
  /** How the list is sorted for the language of the caller. */
  listConfig(language: string): ListConfig;
  /** The fields only this kind has, read from a stored document (tolerant: it never throws). */
  extra(document: Document): X;
  /** What of {@link EntityKind.extra} the activity log keeps. */
  loggable(extra: X): Record<string, unknown>;
  /** The fields only this kind has, as they are stored in a new document; throws the {@link AppError} of a rule it has. */
  create(context: KindContext, body: C): Promise<Document>;
  /** The fields only this kind has that a modification sets; throws the {@link AppError} of a rule it has. */
  patch(context: KindContext, found: Document, body: P): Promise<Document>;
  /** Refuses (`409` with the references) the deletion of an entry that is in use. */
  guardRemove(context: KindContext, found: Document): Promise<void>;
  /**
   * Runs after a creation (`previous` is `undefined`) or a modification has been written, to check what the database cannot (a rule that needs a unique index, which the collections of a group
   * cannot have). It returns the {@link AppError} of the rule when the write must not stand (the service then undoes the whole write and throws it), `null` otherwise.
   */
  settle?(context: KindContext, written: { readonly id: ObjectId; readonly previous: Document | undefined; readonly document: Document }): Promise<AppError | null>;
}

/** The incremental read of a collection of the catalog, for a client that keeps its own copy (the server of a point of sale, an integration). */
export interface EntityChanges<V> {
  /**
   * A page of the entries the caller reaches, oldest change first, the disabled ones included (unless `activeOnly`); with `updatedSince`, the ones changed from that instant.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit; `NOT_FOUND` if the caller disappeared since the authentication.
   */
  listChanges(principal: CatalogCaller, access: GroupAccess, query: EntityChangesQuery): Promise<EntityPage<V>>;
}

/** The operations on the departments or the brands of a group. */
export interface EntityService<V extends { readonly id: string }, C extends object, P extends object> {
  /**
   * A page of the entries the caller reaches, sorted by name (or by code, for the departments), searched by name and filtered by state.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort; `NOT_FOUND` if the caller disappeared since the authentication.
   */
  list(principal: CatalogCaller, access: GroupAccess, query: EntityQuery): Promise<EntityPage<V>>;
  /**
   * One entry.
   *
   * @throws {AppError} `NOT_FOUND` (also for an entry a company or place administrator does not reach).
   */
  get(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<EntityResult<V>>;
  /**
   * Creates an entry and records its creation.
   *
   * @throws {AppError} `FORBIDDEN` for a company or place administrator who names a place outside his perimeter or none; `VALIDATION_ERROR` for a language the group does not have, a missing
   * name in the required language, an image without the `media` feature or not of the library, a place that does not exist; and the errors of the kind.
   */
  create(principal: CatalogCaller, access: GroupAccess, body: C, client: ClientContext): Promise<EntityResult<V>>;
  /**
   * Modifies an entry (JSON Merge Patch on the texts, the other fields replaced) and records it. A request that changes nothing writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN` for a company or place administrator when the entry is not editable by him; `PRECONDITION_FAILED` when the entry is not at the version the client read; `CONFLICT` when it changed while this request ran; the errors of {@link EntityService.create}.
   */
  update(principal: CatalogCaller, access: GroupAccess, id: ObjectId, expected: string, body: P, client: ClientContext): Promise<EntityResult<V>>;
  /**
   * Deletes an entry for good and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN` for a company or place administrator when the entry is for every place or names a place outside his perimeter; `CONFLICT` with the references when it is in use, or without details when it changed (or went) while the request ran.
   */
  remove(principal: CatalogCaller, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createEntityService}. */
export interface EntityServiceDeps<X extends object, C extends EntityCreateBody, P extends EntityPatchBody> {
  readonly kind: EntityKind<X, C, P>;
  readonly repository: EntityRepository;
  /** Which of some places exist in the group and are not in the trash. */
  readonly places: { missing(principal: CatalogCaller, access: GroupAccess, check: { field: string; collection: 'places'; ids: readonly string[] }): Promise<number[]> };
  /** The descriptor of an image of the library, `null` when the caller may not use it. */
  readonly images: { imageSource(principal: CatalogCaller, access: GroupAccess, imageId: ObjectId): Promise<MediaLogo | null> };
  readonly languages: GroupLanguages;
  /** Reads the language of the caller. */
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  /** Where a write that could not be undone is reported (`error`, ids only). */
  readonly logger: Logger;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new entries. */
  readonly newId?: () => ObjectId;
}

/**
 * The value with the keys of every plain object in alphabetical order, whatever their order in the document: MongoDB applies a `$set` of several paths in path order, so the same content can be
 * stored in two orders, and a version must not depend on it.
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortedKeys(record[key])]));
}

/**
 * The version of a stored entry, the `ETag` of the reads and the `If-Match` of the writes: HMAC-SHA256 with the secret key of the server, in base64url, of the id and of every field the backend owns
 * (so a change by the legacy to any of them changes the version).
 *
 * @param document The stored document, read with every owned field.
 * @param fields The owned fields of the collection (a dotted path is read at its place in the document).
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function entityVersion(document: Document, fields: readonly string[], key: Buffer): string {
  const parts = Object.fromEntries(['_id', ...fields].map((field) => [field, valueAt(document, field)]));
  return createHmac('sha256', key).update(BSON.serialize(sortedKeys(parts) as Document)).digest('base64url');
}

/**
 * Builds the service of the departments or the brands of a group: the rules the two have in common (texts by language, the places an entry is for and who may touch which, the image of the library,
 * versions, the activity log) and the hooks of the kind.
 *
 * @param deps The kind, the repository and the collaborators.
 */
export function createEntityService<X extends object, C extends EntityCreateBody, P extends EntityPatchBody>(deps: EntityServiceDeps<X, C, P>): EntityService<EntityView & X, C, P> & EntityChanges<EntityView & X> {
  const { kind, repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  type Entity = EntityView & X;

  const viewOf = (principal: CatalogCaller, access: GroupAccess, document: Document): Entity =>
    ({
      id: (document['_id'] as ObjectId).toHexString(),
      ...kind.extra(document),
      name: textsOf(document['name']),
      description: textsOf(document['description']),
      enabled: document['status'] === true,
      placeIds: shownPlaceIds(principal, document['placesAvailability']),
      editable: isWritablePlaces(principal, document['placesAvailability']),
      ...(access.features.media ? { image: imageOf(document) } : {}),
      createdAt: dateOf(document['insertDate']),
      updatedAt: dateOf(document['updateDate']),
    }) as unknown as Entity;
  const resultOf = (principal: CatalogCaller, access: GroupAccess, document: Document): EntityResult<Entity> => ({
    entity: viewOf(principal, access, document),
    version: entityVersion(document, kind.ownedFields, versionKey),
  });
  /** What the activity log keeps of an entry: its fields, never anything the backend does not own, and of the places only the ones the actor may see. */
  const loggable = (principal: CatalogCaller, document: Document): Record<string, unknown> => ({
    ...kind.loggable(kind.extra(document)),
    name: textsOf(document['name']),
    description: textsOf(document['description']),
    enabled: document['status'] === true,
    placeIds: shownPlaceIds(principal, document['placesAvailability']),
    imageId: imageOf(document)?._id ?? null,
  });
  const record = (principal: CatalogCaller, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Document | undefined, after: Document | undefined) =>
    recordDataChange(activityLog, {
      actor: actorOfCaller(principal),
      groupId: access.groupId,
      resource: { type: kind.resource, id: id.toHexString() },
      action,
      before: before === undefined ? undefined : loggable(principal, before),
      after: after === undefined ? undefined : loggable(principal, after),
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      metadata: operatorMetadata(principal),
    });
  const languageOf = (principal: CatalogCaller, access: GroupAccess): Promise<string> => languageOfCaller(deps, principal, access.groupId);
  const found = async (principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  /** The descriptor of the image of a request: `null` for none; a problem is added to `issues`. */
  const imageOfRequest = async (principal: CatalogCaller, access: GroupAccess, image: { readonly imageId: string } | null, issues: ErrorDetail[]): Promise<MediaLogo | null> => {
    if (!access.features.media) {
      issues.push({ field: 'image', issue: 'notAllowed' });
      return null;
    }
    if (image === null) {
      return null;
    }
    const source = await deps.images.imageSource(principal, access, ObjectId.createFromHexString(image.imageId));
    if (source === null) {
      issues.push({ field: 'image', issue: 'incorrect' });
    }
    return source;
  };
  /** The places that do not exist (or are in the trash) among the ones an entry newly names. */
  const missingPlaces = async (principal: CatalogCaller, access: GroupAccess, requested: readonly string[], added: readonly string[], issues: ErrorDetail[]): Promise<void> => {
    if (added.length === 0) {
      return;
    }
    const missing = await deps.places.missing(principal, access, { field: 'placeIds', collection: 'places', ids: added });
    for (const position of missing) {
      issues.push({ field: `placeIds.${String(requested.indexOf(added[position]!))}`, issue: 'incorrect' });
    }
  };
  /** Reports a write that a lost race required to undo and that could not be undone: the state then differs from what the activity log says. */
  const undoFailed = (access: GroupAccess, id: ObjectId): void =>
    deps.logger.error('product catalog write could not be undone', { resource: kind.resource, id: id.toHexString(), groupId: access.groupId.toHexString() });
  const refuse = (issues: readonly ErrorDetail[]): void => {
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues.slice(0, 20) });
    }
  };

  return {
    list: async (principal, access, query) => {
      const config = kind.listConfig(await languageOf(principal, access));
      const params = listParamsOf(query, config);
      const filter: Filter<Document> = {
        ...(params.q === null ? {} : nameSearch(params.q)),
        ...(query.enabled === undefined ? {} : { status: query.enabled ? true : { $ne: true } }),
      };
      const { items, page } = await repository.list(principal, access, filter, params, config);
      return { items: items.map((document) => viewOf(principal, access, document)), page };
    },

    listChanges: async (principal, access, query) => {
      const params = listParamsOf(query, ENTITY_CHANGES_LIST);
      const filter: Filter<Document> = { ...(query.updatedSince === undefined ? {} : { updateDate: { $gte: new Date(query.updatedSince) } }), ...(query.activeOnly === true ? { status: true } : {}) };
      const { items, page } = await repository.list(principal, access, filter, params, ENTITY_CHANGES_LIST);
      return { items: items.map((document) => viewOf(principal, access, document)), page };
    },

    get: async (principal, access, id) => resultOf(principal, access, await found(principal, access, id)),

    create: async (principal, access, body, client) => {
      const groupLanguages = await deps.languages.of(access.groupId);
      const languages = new Set(groupLanguages);
      const required = requiredLanguage(await languageOf(principal, access), groupLanguages);
      const issues = [...languageIssues('name', body.name, undefined, languages), ...languageIssues('description', body.description ?? {}, undefined, languages)];
      if (body.name[required] === undefined) {
        issues.push({ field: `name.${required}`, issue: 'required' });
      }
      const descriptor = body.image === undefined ? null : await imageOfRequest(principal, access, body.image, issues);
      const requested = body.placeIds ?? [];
      const places = placesWrite(principal, undefined, requested);
      await missingPlaces(principal, access, requested, places.added, issues);
      refuse(issues);
      const context = { principal, access };
      const extra = await kind.create(context, body);
      const now = new Date(deps.now());
      const document: Document = {
        _id: newId(),
        ...extra,
        name: body.name,
        description: body.description ?? { [required]: '' },
        placesAvailability: places.value,
        medias: newMedias(descriptor),
        status: body.enabled ?? true,
        insertDate: now,
        updateDate: now,
      };
      await repository.insert(principal, access, document);
      const lost = (await kind.settle?.(context, { id: document['_id'] as ObjectId, previous: undefined, document })) ?? null;
      if (lost !== null) {
        if (!(await repository.remove(principal, access, document['_id'] as ObjectId, document['updateDate'], document['placesAvailability']))) {
          undoFailed(access, document['_id'] as ObjectId);
        }
        throw lost;
      }
      await record(principal, access, client, document['_id'] as ObjectId, kind.actions.created, undefined, document);
      return resultOf(principal, access, document);
    },

    update: async (principal, access, id, expected, body, client) => {
      const stored = await found(principal, access, id);
      assertWritablePlaces(principal, stored['placesAvailability']);
      if (entityVersion(stored, kind.ownedFields, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const issues: ErrorDetail[] = [];
      const set: Document = {};
      const unset: Document = {};
      let medias: unknown;
      if (body.name !== undefined || body.description !== undefined) {
        const groupLanguages = await deps.languages.of(access.groupId);
        const languages = new Set(groupLanguages);
        if (body.name !== undefined) {
          const merged = mergeTexts(stored['name'], body.name);
          issues.push(...languageIssues('name', body.name, stored['name'], languages));
          const required = requiredLanguage(await languageOf(principal, access), groupLanguages);
          // A name keeps a text in the required language it already had, and never ends up with none.
          if (Object.keys(textsOf(merged)).length === 0 || (textsOf(stored['name'])[required] !== undefined && textsOf(merged)[required] === undefined)) {
            issues.push({ field: `name.${required}`, issue: 'required' });
          }
          if (!isDeepStrictEqual(stored['name'], merged)) {
            set['name'] = merged;
          }
        }
        if (body.description !== undefined) {
          const merged = mergeTexts(stored['description'], body.description);
          issues.push(...languageIssues('description', body.description, stored['description'], languages));
          if (!isDeepStrictEqual(stored['description'], merged)) {
            set['description'] = merged;
          }
        }
      }
      if (body.enabled !== undefined && (stored['status'] === true) !== body.enabled) {
        set['status'] = body.enabled;
      }
      if (body.placeIds !== undefined) {
        const places = placesWrite(principal, stored['placesAvailability'], body.placeIds);
        await missingPlaces(principal, access, body.placeIds, places.added, issues);
        const before = placeIdsOf(stored['placesAvailability']);
        const after = placeIdsOf(places.value);
        const rawLength = Array.isArray(stored['placesAvailability']) ? (stored['placesAvailability'] as unknown[]).length : 0;
        if (rawLength !== places.value.length || !isDeepStrictEqual([...before].sort(), [...after].sort())) {
          set['placesAvailability'] = places.value;
        }
      }
      if (body.image !== undefined) {
        const descriptor = await imageOfRequest(principal, access, body.image, issues);
        const current = imageOf(stored);
        if (issues.length === 0 && (descriptor === null ? current !== null : current?._id !== descriptor._id)) {
          const written = imageWrite(stored['medias'], descriptor);
          Object.assign(set, written.set);
          Object.assign(unset, written.unset);
          medias = written.medias;
        }
      }
      refuse(issues);
      Object.assign(set, await kind.patch({ principal, access }, stored, body));
      if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
        return resultOf(principal, access, stored);
      }
      const readDate: unknown = stored['updateDate'];
      const clock = new Date(deps.now());
      // Strictly after the date read, so that two changes within the same millisecond still have different versions.
      const updateDate = readDate instanceof Date && readDate.getTime() >= clock.getTime() ? new Date(readDate.getTime() + 1) : clock;
      // A write holds only while the places are what was read too: the legacy writes them without touching `updateDate`.
      const change = { set, unset, updateDate, readPlaces: stored['placesAvailability'] };
      if ((await repository.update(principal, access, id, change, readDate)) === 'conflict') {
        throw new AppError('CONFLICT');
      }
      const next: Document = { ...stored, ...Object.fromEntries(Object.entries(set).filter(([key]) => !key.includes('.') && key !== 'medias')), ...(medias === undefined ? {} : { medias }), updateDate };
      const lost = (await kind.settle?.({ principal, access }, { id, previous: stored, document: next })) ?? null;
      if (lost !== null) {
        // The whole write is undone, not only the field the rule is about: afterwards the entry is what it was, and the activity log (which records nothing) says so.
        const roots = [...new Set([...Object.keys(set), ...Object.keys(unset)].map((key) => key.split('.')[0]!))];
        const restore = { set: Object.fromEntries(roots.filter((key) => stored[key] !== undefined).map((key) => [key, stored[key]])), unset: Object.fromEntries(roots.filter((key) => stored[key] === undefined).map((key) => [key, ''])) };
        const undone = await repository.update(principal, access, id, { ...restore, updateDate: new Date(updateDate.getTime() + 1), readPlaces: next['placesAvailability'] }, updateDate);
        if (undone === 'conflict') {
          undoFailed(access, id);
        }
        throw lost;
      }
      await record(principal, access, client, id, kind.actions.updated, stored, next);
      return resultOf(principal, access, next);
    },

    remove: async (principal, access, id, client) => {
      const stored = await found(principal, access, id);
      assertWritablePlaces(principal, stored['placesAvailability']);
      await kind.guardRemove({ principal, access }, stored);
      // The deletion holds only while the entry is as it was read.
      if (!(await repository.remove(principal, access, id, stored['updateDate'], stored['placesAvailability']))) {
        throw new AppError('CONFLICT');
      }
      await record(principal, access, client, id, kind.actions.deleted, stored, undefined);
    },
  };
}
