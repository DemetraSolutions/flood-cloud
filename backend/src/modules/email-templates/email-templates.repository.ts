import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { findPlacesUsingTemplate } from '../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { EMAIL_TEMPLATES_LIST } from './email-templates.list.ts';
import { TEMPLATE_PROJECTION, TEMPLATE_SUMMARY_PROJECTION } from './email-templates.mapper.ts';

/** Most places reported as users of a template (a deletion that is refused lists at most these). */
export const MAX_REPORTED_PLACES = 20;

/** What changes in a template: the fields of an update, and the new date of the change. */
export interface TemplateChange {
  readonly name?: string;
  readonly text?: string;
  readonly html?: string;
  readonly updateDate: Date;
}

/** The `email_templates` collection of a group database, and the places of the group that refer to a template (read from the copies). */
export interface EmailTemplatesRepository {
  /**
   * A page of the templates of the group, with the name and the dates only (the content stays in the database).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param params Validated list parameters.
   */
  list(principal: AuthPrincipal, access: GroupAccess, params: ListParams): Promise<ListPage>;
  /**
   * One template with its content, or `null`.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group (another group's template is not in this group's database).
   * @param id Id of the template.
   */
  findById(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /**
   * Inserts a whole new template.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param document The document, built by the service.
   */
  insert(principal: AuthPrincipal, access: GroupAccess, document: Document): Promise<void>;
  /**
   * Sets the given fields and the date of the change, only if the template still has the date it was read with, so a change made meanwhile is never overwritten.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the template.
   * @param change The fields and the new date.
   * @param readDate The `updateDate` the template had when it was read (`undefined` when it had none).
   * @returns `updated`, or `conflict` when the template changed (or disappeared) since it was read.
   */
  update(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, change: TemplateChange, readDate: unknown): Promise<'updated' | 'conflict'>;
  /**
   * Deletes a template.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the template.
   * @returns Whether a template was deleted.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<boolean>;
  /**
   * The ids of the places of the group, trashed ones included, that name the template in the settings of their reservations or of their appointments, read from the copies in the common database.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the template.
   * @returns At most {@link MAX_REPORTED_PLACES} places (id and company), by id.
   */
  placesUsing(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<Array<{ readonly id: ObjectId; readonly companyId: unknown }>>;
}

/**
 * Builds the repository of the e-mail templates. The collection is the `email_templates` of the group database, opened from the verified access, so a template of another group is never
 * reachable; the places are read only through the verified access to the copies.
 *
 * @param databases Database accessor.
 */
export function createEmailTemplatesRepository(databases: Databases): EmailTemplatesRepository {
  const templates = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('email_templates');
  return {
    list: async (principal, access, params) =>
      pageOf(
        await templates(principal, access)
          .aggregate(listPipeline(listSearch(params, EMAIL_TEMPLATES_LIST), params, EMAIL_TEMPLATES_LIST, TEMPLATE_SUMMARY_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
        params,
      ),

    findById: (principal, access, id) => templates(principal, access).findOne({ _id: id }, { projection: TEMPLATE_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS }),

    insert: async (principal, access, document) => {
      await templates(principal, access).insertOne(document);
    },

    update: async (principal, access, id, change, readDate) => {
      const { updateDate, ...fields } = change;
      // The date comes from a document the legacy also writes: only a date (or none) can guard the write, anything else could be read as an operator.
      if (readDate !== undefined && readDate !== null && !(readDate instanceof Date)) {
        return 'conflict';
      }
      const result = await templates(principal, access).updateOne({ _id: id, updateDate: readDate ?? null } as Filter<Document>, { $set: { ...fields, updateDate } });
      return result.matchedCount === 1 ? 'updated' : 'conflict';
    },

    remove: async (principal, access, id) => (await templates(principal, access).deleteOne({ _id: id })).deletedCount === 1,

    placesUsing: async (principal, access, id) => {
      const found = await findPlacesUsingTemplate(principal, access, databases, id, MAX_REPORTED_PLACES);
      return found.map((place) => ({ id: place['_id'] as ObjectId, companyId: place['companyId'] }));
    },
  };
}
