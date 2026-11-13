import type { Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { IMAGES_LIST } from './media.list.ts';

/** The fields of a stored image the API reads (a projection: the rest of the document is never loaded). */
const IMAGE_PROJECTION = Object.freeze({ name: 1, title: 1, alt: 1, basename: 1, extension: 1, mimetype: 1, insertDate: 1, companyId: 1 } as const);

/** The fields the descriptor of a logo is built from. */
const LOGO_PROJECTION = Object.freeze({ name: 1, title: 1, alt: 1, basename: 1, extension: 1, mimetype: 1, dirname: 1, filectime: 1 } as const);

/** What the images in the `files` collection of a group database are: the images that are not in the trash. */
const LIVE_IMAGES: Filter<Document> = { type: 'image', trash: { $ne: true } };

/** The reads and the one write of the `files` collection of a group, and the files host of the group. */
export interface MediaRepository {
  /**
   * Inserts a whole new `files` document in the group database. Nothing else is ever written to this collection in this step.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param document The document, built by `newFileDocument`.
   */
  insert(principal: AuthPrincipal, access: GroupAccess, document: Document): Promise<void>;
  /**
   * A page of the images of the group that are not in the trash.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param params Validated list parameters.
   * @param visible What the caller may see (the owner rule), combined with the images that are not in the trash.
   */
  list(principal: AuthPrincipal, access: GroupAccess, params: ListParams, visible: Filter<Document>): Promise<ListPage>;
  /**
   * One image of the group that is not in the trash, with the fields of the image of the API and of the descriptor of a logo.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param imageId Id of the image.
   * @param visible What the caller may see (the owner rule), combined with the id.
   * @returns The document, `null` when there is none (another group's image is not in this group's database).
   */
  findImage(principal: AuthPrincipal, access: GroupAccess, imageId: ObjectId, visible: Filter<Document>): Promise<Document | null>;
  /**
   * Whether a document of the group database has this id (trash and type do not matter): used after an insert whose outcome is not known.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param imageId Id of the document.
   */
  hasFile(principal: AuthPrincipal, access: GroupAccess, imageId: ObjectId): Promise<boolean>;
  /**
   * The `filesHost` of a group document, as stored (any type).
   *
   * @param groupId Id of the group (from a verified access).
   */
  filesHost(groupId: ObjectId): Promise<unknown>;
}

/**
 * Builds the repository of the images. The collection is the `files` of the group database, opened from the verified access, so an image of another group is never reachable.
 *
 * @param databases Database accessor.
 */
export function createMediaRepository(databases: Databases): MediaRepository {
  const files = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('files');
  return {
    insert: async (principal, access, document) => {
      await files(principal, access).insertOne(document);
    },

    list: async (principal, access, params, visible) =>
      pageOf(
        await files(principal, access)
          .aggregate(listPipeline({ $and: [LIVE_IMAGES, visible, listSearch(params, IMAGES_LIST)] }, params, IMAGES_LIST, IMAGE_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
        params,
      ),

    findImage: (principal, access, imageId, visible) =>
      files(principal, access).findOne({ $and: [LIVE_IMAGES, visible, { _id: imageId }] }, { projection: { ...IMAGE_PROJECTION, ...LOGO_PROJECTION }, maxTimeMS: LIST_MAX_TIME_MS }),

    hasFile: async (principal, access, imageId) => (await files(principal, access).findOne({ _id: imageId }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })) !== null,

    filesHost: async (groupId) => (await databases.common().collection('groups').findOne({ _id: groupId }, { projection: { filesHost: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))?.['filesHost'],
  };
}
