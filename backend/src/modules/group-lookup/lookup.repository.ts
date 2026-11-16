import type { Collection, Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { localizedName } from '../../db/localized-name.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { LOOKUP_LIST, LOOKUP_NAME } from './lookup.list.ts';

/** What the compact read of one collection selects, shows and sorts by. */
interface LookupSource {
  /** Documents kept before anything else (trash, kind of contact…). */
  readonly filter: Filter<Document>;
  /** Stored fields the name is made of: the only ones read. */
  readonly fields: Readonly<Record<string, 1>>;
  /** Stored fields to return besides the name. */
  readonly extra: Readonly<Record<string, 1>>;
  /** Expression of the name to show, over the projected fields. */
  readonly name: Document;
}

/** What a read of the products can be narrowed to, besides the ids. */
export interface ProductsNarrowing {
  /** Legacy product type, from an allowlist. */
  readonly type?: string;
}

/** The legacy encrypted format of a personal text (`<ciphertext hex>$<iv hex>`): never shown, since the key is not ours. */
const ENCRYPTED = '^([0-9a-f]{32})+\\$[0-9a-f]{32}$';

/** A text field of a contact as a trimmed non-empty string, or `null` when it is missing, not a text, empty or in the legacy encrypted format. */
function clearText(field: string): Document {
  const text = { $trim: { input: field } };
  return {
    $let: {
      vars: { text: { $cond: [{ $eq: [{ $type: field }, 'string'] }, text, ''] } },
      in: { $cond: [{ $or: [{ $eq: ['$$text', ''] }, { $regexMatch: { input: '$$text', regex: ENCRYPTED } }] }, null, '$$text'] },
    },
  };
}

/**
 * The display name of a contact: the company name when it has one, else name and surname (the parts that are in clear), else `null`. Personal
 * data in the legacy encrypted format are never shown.
 */
function contactName(): Document {
  return {
    $let: {
      vars: { company: clearText('$companyName'), first: clearText('$name'), last: clearText('$surname') },
      in: {
        $ifNull: [
          '$$company',
          {
            $let: {
              vars: { person: { $trim: { input: { $concat: [{ $ifNull: ['$$first', ''] }, ' ', { $ifNull: ['$$last', ''] }] } } } },
              in: { $cond: [{ $eq: ['$$person', ''] }, null, '$$person'] },
            },
          },
        ],
      },
    },
  };
}

/** Compact, read-only reads of the group catalogs the backoffice selectors need (the `products`, `products_categories`, `contacts` and `contacts_groups` of the group database). */
export interface LookupRepository {
  /**
   * A page of the products of a group that are not in the trash: id, name in the given language and type.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group, which fixes the database and the cluster.
   * @param params Validated list parameters.
   * @param language Language of the name to show.
   * @param ids Restricts the read to these ids, or `null`.
   * @param narrowing Optional narrowing by type.
   */
  products(principal: AuthPrincipal, access: GroupAccess, params: ListParams, language: string, ids: readonly ObjectId[] | null, narrowing: ProductsNarrowing): Promise<ListPage>;
  /** A page of the product categories of a group that are not in the trash (same parameters as `products`, without narrowing). */
  categories(principal: AuthPrincipal, access: GroupAccess, params: ListParams, language: string, ids: readonly ObjectId[] | null): Promise<ListPage>;
  /** A page of the customers of a group that are not in the trash, by display name (company name, else name and surname). */
  customers(principal: AuthPrincipal, access: GroupAccess, params: ListParams, ids: readonly ObjectId[] | null): Promise<ListPage>;
  /** A page of the contact groups of a group (they have no trash), by name. */
  contactGroups(principal: AuthPrincipal, access: GroupAccess, params: ListParams, ids: readonly ObjectId[] | null): Promise<ListPage>;
  /** A page of the e-mail templates of a group that are not in the trash, by name (only `_id` and `name` are read: never the text or the HTML). */
  emailTemplates(principal: AuthPrincipal, access: GroupAccess, params: ListParams, ids: readonly ObjectId[] | null): Promise<ListPage>;
  /**
   * The language codes the group declares (`settings.languages` in `common.groups`), as stored.
   *
   * @param access Verified access to the group.
   * @returns The stored value when it is a list, `null` when the group has none.
   */
  languages(access: GroupAccess): Promise<readonly unknown[] | null>;
}

/** Reads one page: only the fields of the name travel down the pipeline, and the name is computed before search, order and cursor. */
async function readPage(collection: Collection<Document>, source: LookupSource, params: ListParams, ids: readonly ObjectId[] | null): Promise<ListPage> {
  const documents = await collection
    .aggregate(
      [
        { $match: ids === null ? source.filter : { ...source.filter, _id: { $in: [...ids] } } },
        { $project: { ...source.fields, ...source.extra } },
        { $addFields: { [LOOKUP_NAME]: source.name } },
        ...listPipeline(listSearch(params, LOOKUP_LIST), params, LOOKUP_LIST, { [LOOKUP_NAME]: 1, ...source.extra }),
      ],
      { maxTimeMS: LIST_MAX_TIME_MS },
    )
    .toArray();
  return pageOf(documents, params);
}

/**
 * Builds the compact-read repository over the group database, which is opened only through a verified group access (so the cluster and the
 * database come from the access, never from the request). Nothing is written.
 *
 * @param databases Database accessor.
 */
export function createLookupRepository(databases: Databases): LookupRepository {
  const group = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases);
  const NOT_TRASHED = { trash: { $ne: true } };
  return {
    products: (principal, access, params, language, ids, narrowing) =>
      readPage(
        group(principal, access).collection('products'),
        { filter: { ...NOT_TRASHED, ...(narrowing.type === undefined ? {} : { type: narrowing.type }) }, fields: { name: 1 }, extra: { type: 1 }, name: localizedName(language) },
        params,
        ids,
      ),
    categories: (principal, access, params, language, ids) =>
      readPage(group(principal, access).collection('products_categories'), { filter: NOT_TRASHED, fields: { name: 1 }, extra: {}, name: localizedName(language) }, params, ids),
    customers: (principal, access, params, ids) =>
      readPage(
        group(principal, access).collection('contacts'),
        { filter: { ...NOT_TRASHED, customer: true }, fields: { companyName: 1, name: 1, surname: 1 }, extra: {}, name: contactName() },
        params,
        ids,
      ),
    emailTemplates: (principal, access, params, ids) =>
      readPage(
        group(principal, access).collection('email_templates'),
        { filter: NOT_TRASHED, fields: { name: 1 }, extra: {}, name: { $cond: [{ $eq: [{ $type: '$name' }, 'string'] }, '$name', null] } },
        params,
        ids,
      ),
    languages: async (access) => {
      const found = await databases.common().collection('groups').findOne({ _id: access.groupId }, { projection: { 'settings.languages': 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      const languages: unknown = (found?.['settings'] as { languages?: unknown } | undefined)?.languages;
      return Array.isArray(languages) ? (languages as unknown[]) : null;
    },
    contactGroups: (principal, access, params, ids) =>
      readPage(
        group(principal, access).collection('contacts_groups'),
        { filter: {}, fields: { name: 1 }, extra: {}, name: { $cond: [{ $eq: [{ $type: '$name' }, 'string'] }, '$name', null] } },
        params,
        ids,
      ),
  };
}
