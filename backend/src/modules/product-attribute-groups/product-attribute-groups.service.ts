import { isDeepStrictEqual } from 'node:util';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { PRODUCTS_ATTRIBUTES_OWNED_FIELDS } from '../../db/collections.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { dateOf, isRecord, recordsOf, referenced } from '../groups/catalogs/kit.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';
import type { EntityPage, EntityResult, EntityService } from '../product-catalog/entity.service.ts';
import type { GroupLanguages } from '../product-catalog/group-languages.ts';
import { userField } from '../product-catalog/product-references.ts';
import type { ProductReferences } from '../product-catalog/product-references.ts';
import { languageIssues, mergeTexts, nameSearch, requiredLanguage, textsOf } from '../product-catalog/texts.ts';
import type { Texts } from '../product-catalog/texts.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { attributeGroupsListFor } from './product-attribute-groups.schemas.ts';
import type { CreateAttributeGroupBody, PatchAttributeGroupBody } from './product-attribute-groups.schemas.ts';

/** One attribute of a group of attributes. */
export interface Attribute {
  /** Made by the server when the attribute is created, never by the client. */
  readonly id: string;
  readonly name: Texts;
}

/** A group of attributes as the API shows it. */
export interface AttributeGroup {
  readonly id: string;
  readonly name: Texts;
  readonly attributes: readonly Attribute[];
  /** Whether the caller may modify and delete the group: only the platform, dealer and group administrators; a company or place administrator reads. Computed by the server. */
  readonly editable: boolean;
  /** `null` for a group the legacy created (its upsert never wrote the date). */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** The service of the groups of attributes of a group (`doc/Tasks.md` step C1). */
export type AttributeGroupsService = EntityService<AttributeGroup, CreateAttributeGroupBody, PatchAttributeGroupBody>;

/** Collaborators of {@link createAttributeGroupsService}. */
export interface AttributeGroupsServiceDeps {
  readonly repository: EntityRepository;
  readonly products: Pick<ProductReferences, 'withAttributes'>;
  readonly languages: GroupLanguages;
  /** Reads the language of the caller. */
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new groups. */
  readonly newId?: () => ObjectId;
  /** Generator of the ids of new attributes (a random text, the form the ids already stored have). */
  readonly newAttributeId: () => string;
}

/** The attributes of a stored group: the elements that are objects with a text id (the others are not shown). */
function attributesOf(raw: unknown): Attribute[] {
  return recordsOf(raw).flatMap((element) => (typeof element['id'] === 'string' ? [{ id: element['id'], name: textsOf(element['name']) }] : []));
}

/**
 * Builds the service of the groups of attributes of a group. A group keeps its attributes inside its own document, so there is no perimeter: whoever updates the products of the group changes them.
 * A deletion, of a group or of an attribute, is refused while a product that is not in the trash uses the attribute.
 *
 * @param deps Repository, products, languages, users, activity log, version key, clock and id generators.
 */
export function createAttributeGroupsService(deps: AttributeGroupsServiceDeps): AttributeGroupsService {
  const { repository, activityLog, versionKey, products } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const viewOf = (principal: AuthPrincipal, document: Document): AttributeGroup => ({
    id: (document['_id'] as ObjectId).toHexString(),
    name: textsOf(document['name']),
    attributes: attributesOf(document['attributes']),
    editable: perimeterOf(principal) === null,
    createdAt: dateOf(document['insertDate']),
    updatedAt: dateOf(document['updateDate']),
  });
  const resultOf = (principal: AuthPrincipal, document: Document): EntityResult<AttributeGroup> => ({ entity: viewOf(principal, document), version: entityVersion(document, PRODUCTS_ATTRIBUTES_OWNED_FIELDS, versionKey) });
  /** What the activity log keeps of a group: its name and its attributes. */
  const loggable = (document: Document): Record<string, unknown> => ({ name: textsOf(document['name']), attributes: attributesOf(document['attributes']) });
  const record = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Document | undefined, after: Document | undefined) =>
    recordDataChange(activityLog, {
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'productAttributeGroup', id: id.toHexString() },
      action,
      before: before === undefined ? undefined : loggable(before),
      after: after === undefined ? undefined : loggable(after),
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });
  const languageOf = async (principal: AuthPrincipal): Promise<string> => {
    const caller = await deps.users.findById(principal.userId);
    if (caller === null) {
      throw new AppError('NOT_FOUND');
    }
    return caller.user.language;
  };
  const found = async (principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  /** `409` with the products that use some attributes, when there are any. */
  const assertUnused = async (principal: AuthPrincipal, access: GroupAccess, attributeIds: readonly string[]): Promise<void> => {
    const users = await products.withAttributes(principal, access, attributeIds);
    if (users.length > 0) {
      throw referenced(users.map((id) => userField('products', id)));
    }
  };
  /** The groups of attributes are written only by the platform, dealer and group administrators: a company or place administrator, who has no perimeter over them, only reads. */
  const assertWriter = (principal: AuthPrincipal): void => {
    if (perimeterOf(principal) !== null) {
      throw new AppError('FORBIDDEN');
    }
  };
  const refuse = (issues: readonly ErrorDetail[]): void => {
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues.slice(0, 20) });
    }
  };

  return {
    list: async (principal, access, query) => {
      const config = attributeGroupsListFor(await languageOf(principal));
      const params = listParamsOf(query, config);
      const { items, page } = await repository.list(principal, access, params.q === null ? {} : nameSearch(params.q), params, config);
      return { items: items.map((item) => viewOf(principal, item)), page } satisfies EntityPage<AttributeGroup>;
    },

    get: async (principal, access, id) => resultOf(principal, await found(principal, access, id)),

    create: async (principal, access, body, client) => {
      assertWriter(principal);
      const groupLanguages = await deps.languages.of(access.groupId);
      const languages = new Set(groupLanguages);
      const required = requiredLanguage(await languageOf(principal), groupLanguages);
      const attributes = body.attributes ?? [];
      const issues = [
        ...languageIssues('name', body.name, undefined, languages),
        ...attributes.flatMap((attribute, index) => languageIssues(`attributes.${String(index)}.name`, attribute.name, undefined, languages)),
      ];
      if (body.name[required] === undefined) {
        issues.push({ field: `name.${required}`, issue: 'required' });
      }
      refuse(issues);
      const now = new Date(deps.now());
      const document: Document = {
        _id: newId(),
        name: body.name,
        attributes: attributes.map((attribute) => ({ id: deps.newAttributeId(), name: attribute.name })),
        insertDate: now,
        updateDate: now,
      };
      await repository.insert(principal, access, document);
      await record(principal, access, client, document['_id'] as ObjectId, 'productAttributeGroup.created', undefined, document);
      return resultOf(principal, document);
    },

    update: async (principal, access, id, expected, body, client) => {
      assertWriter(principal);
      const stored = await found(principal, access, id);
      if (entityVersion(stored, PRODUCTS_ATTRIBUTES_OWNED_FIELDS, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const groupLanguages = await deps.languages.of(access.groupId);
      const languages = new Set(groupLanguages);
      const issues: ErrorDetail[] = [];
      const set: Document = {};
      if (body.name !== undefined) {
        const merged = mergeTexts(stored['name'], body.name);
        issues.push(...languageIssues('name', body.name, stored['name'], languages));
        const required = requiredLanguage(await languageOf(principal), groupLanguages);
        // A name keeps a text in the required language it already had, and never ends up with none.
        if (Object.keys(textsOf(merged)).length === 0 || (textsOf(stored['name'])[required] !== undefined && textsOf(merged)[required] === undefined)) {
          issues.push({ field: `name.${required}`, issue: 'required' });
        }
        if (!isDeepStrictEqual(stored['name'], merged)) {
          set['name'] = merged;
        }
      }
      let removed: string[] = [];
      if (body.attributes !== undefined) {
        const storedList = recordsOf(stored['attributes']);
        const byId = new Map(storedList.flatMap((element) => (typeof element['id'] === 'string' ? [[element['id'], element] as const] : [])));
        const next = body.attributes.map((attribute, index) => {
          if (attribute.id === undefined) {
            issues.push(...languageIssues(`attributes.${String(index)}.name`, attribute.name, undefined, languages));
            return { id: deps.newAttributeId(), name: attribute.name };
          }
          const current = byId.get(attribute.id);
          if (current === undefined) {
            issues.push({ field: `attributes.${String(index)}.id`, issue: 'incorrect' });
            return { id: attribute.id, name: attribute.name };
          }
          issues.push(...languageIssues(`attributes.${String(index)}.name`, attribute.name, current['name'], languages));
          // An attribute whose name does not change is kept exactly as stored (with any key the backend does not manage).
          return isDeepStrictEqual(textsOf(current['name']), attribute.name) ? current : { ...current, id: attribute.id, name: attribute.name };
        });
        // What the API cannot address (an element without a text id, or that is not an object) is not shown and is not ours to drop: it stays, at the end.
        next.push(...((Array.isArray(stored['attributes']) ? (stored['attributes'] as unknown[]) : []).filter((element) => !(isRecord(element) && typeof element['id'] === 'string')) as typeof next));
        const kept = new Set(body.attributes.flatMap((attribute) => (attribute.id === undefined ? [] : [attribute.id])));
        removed = [...byId.keys()].filter((attributeId) => !kept.has(attributeId));
        if (!isDeepStrictEqual(next, stored['attributes'])) {
          set['attributes'] = next;
        }
      }
      refuse(issues);
      if (Object.keys(set).length === 0) {
        return resultOf(principal, stored);
      }
      // An attribute that goes cannot be one a product still has.
      await assertUnused(principal, access, removed);
      const readDate: unknown = stored['updateDate'];
      const clock = new Date(deps.now());
      // Strictly after the date read, so that two changes within the same millisecond still have different versions.
      const updateDate = readDate instanceof Date && readDate.getTime() >= clock.getTime() ? new Date(readDate.getTime() + 1) : clock;
      if ((await repository.update(principal, access, id, { set, unset: {}, updateDate, readPlaces: undefined }, readDate)) === 'conflict') {
        throw new AppError('CONFLICT');
      }
      const next: Document = { ...stored, ...set, updateDate };
      await record(principal, access, client, id, 'productAttributeGroup.updated', stored, next);
      return resultOf(principal, next);
    },

    remove: async (principal, access, id, client) => {
      assertWriter(principal);
      const stored = await found(principal, access, id);
      await assertUnused(
        principal,
        access,
        attributesOf(stored['attributes']).map((attribute) => attribute.id),
      );
      // The deletion holds only while the group is as it was read.
      if (!(await repository.remove(principal, access, id, stored['updateDate'], undefined))) {
        throw new AppError('CONFLICT');
      }
      await record(principal, access, client, id, 'productAttributeGroup.deleted', stored, undefined);
    },
  };
}
