import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { placeInScope } from '../../shared/security/scope/scope-filters.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { EMAIL_TEMPLATES_LIST } from './email-templates.list.ts';
import { toSummary, toTemplate, versionOf } from './email-templates.mapper.ts';
import type { EmailTemplate, EmailTemplateSummary } from './email-templates.mapper.ts';
import type { EmailTemplatesRepository } from './email-templates.repository.ts';
import type { CreateTemplateBody, PatchTemplateBody, TemplatesQuery } from './email-templates.schemas.ts';

/** A template with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface TemplateResult {
  readonly template: EmailTemplate;
  readonly version: string;
}

/** A page of templates. */
export interface TemplatesPage {
  readonly items: readonly EmailTemplateSummary[];
  readonly page: PageInfo;
}

/** The e-mail templates of a group (`doc/Tasks.md` 9-bis, step T2). */
export interface EmailTemplatesService {
  /**
   * Lists the templates of the group by name, without their content.
   *
   * @param access Verified access to the group.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: TemplatesQuery): Promise<TemplatesPage>;
  /**
   * One template with its content.
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<TemplateResult>;
  /**
   * Creates a template and records `emailTemplate.created` (without its content).
   *
   * @param body Validated body: the name, and the text and the HTML (empty when left out).
   */
  create(principal: AuthPrincipal, access: GroupAccess, body: CreateTemplateBody, client: ClientContext): Promise<TemplateResult>;
  /**
   * Modifies a template (the fields of the body, JSON Merge Patch on three scalar fields) and records `emailTemplate.updated`. A request that changes nothing writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED` when the template is not at the version the client read; `CONFLICT` when it changed while this request ran.
   */
  update(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, expected: string, body: PatchTemplateBody, client: ClientContext): Promise<TemplateResult>;
  /**
   * Deletes a template and records `emailTemplate.deleted`.
   *
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` with a `places.<id>` `referenced` detail for each place of the caller's perimeter (at most 20, trashed ones included) whose reservations or appointments still use it, and one `places` detail without id when some are outside it.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createEmailTemplatesService}. */
export interface EmailTemplatesServiceDeps {
  readonly repository: EmailTemplatesRepository;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new templates. */
  readonly newId?: () => ObjectId;
}

/** A short digest of a content: the activity log says that a text changed, never what it said. */
const digest = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 16);

/** What the activity log keeps of a template: its name and a digest of each content, never the content. */
const loggable = (name: string, text: string, html: string): Record<string, string> => ({ name, textDigest: digest(text), htmlDigest: digest(html) });

/**
 * Builds the service of the e-mail templates. The HTML is stored as sent: it is the content of an e-mail the user writes, and what keeps it harmless is that the API only ever returns it as
 * a JSON string and the backoffice shows it in an isolated frame.
 *
 * @param deps Repository, activity log, version key, clock and id generator.
 */
export function createEmailTemplatesService(deps: EmailTemplatesServiceDeps): EmailTemplatesService {
  const { repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const resultOf = (document: Document): TemplateResult => ({ template: toTemplate(document), version: versionOf(document, versionKey) });
  const record = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, id: ObjectId, action: 'emailTemplate.created' | 'emailTemplate.updated' | 'emailTemplate.deleted', before?: Record<string, string>, after?: Record<string, string>) =>
    recordDataChange(activityLog, {
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'emailTemplate', id: id.toHexString() },
      action,
      before,
      after,
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });

  return {
    list: async (principal, access, query) => {
      const { items, page } = await repository.list(principal, access, listParamsOf(query, EMAIL_TEMPLATES_LIST));
      return { items: items.map(toSummary), page };
    },

    get: async (principal, access, id) => {
      const found = await repository.findById(principal, access, id);
      if (found === null) {
        throw new AppError('NOT_FOUND');
      }
      return resultOf(found);
    },

    create: async (principal, access, body, client) => {
      const now = new Date(deps.now());
      const document: Document = { _id: newId(), name: body.name, text: body.text ?? '', html: body.html ?? '', insertDate: now, updateDate: now };
      await repository.insert(principal, access, document);
      await record(principal, access, client, document['_id'] as ObjectId, 'emailTemplate.created', undefined, loggable(body.name, document['text'] as string, document['html'] as string));
      return resultOf(document);
    },

    update: async (principal, access, id, expected, body, client) => {
      const found = await repository.findById(principal, access, id);
      if (found === null) {
        throw new AppError('NOT_FOUND');
      }
      if (versionOf(found, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const current = toTemplate(found);
      const next = { name: body.name ?? current.name, text: body.text ?? current.text, html: body.html ?? current.html };
      if (next.name === current.name && next.text === current.text && next.html === current.html) {
        return resultOf(found);
      }
      const readDate: unknown = found['updateDate'];
      const clock = new Date(deps.now());
      // Strictly after the date read, so that two changes within the same millisecond still have different versions.
      const updateDate = readDate instanceof Date && readDate.getTime() >= clock.getTime() ? new Date(readDate.getTime() + 1) : clock;
      const outcome = await repository.update(principal, access, id, { ...next, updateDate }, readDate);
      if (outcome === 'conflict') {
        throw new AppError('CONFLICT');
      }
      await record(principal, access, client, id, 'emailTemplate.updated', loggable(current.name, current.text, current.html), loggable(next.name, next.text, next.html));
      return resultOf({ ...found, ...next, updateDate });
    },

    remove: async (principal, access, id, client) => {
      const found = await repository.findById(principal, access, id);
      if (found === null) {
        throw new AppError('NOT_FOUND');
      }
      const users = await repository.placesUsing(principal, access, id);
      if (users.length > 0) {
        // The ids of the places outside the perimeter of the caller (a company or place administrator reaches only some of the places of the group) are never revealed: they are one anonymous detail.
        const visible = users.filter((place) => placeInScope(principal.scope, place.id, place.companyId));
        const details = visible.map((place) => ({ field: `places.${place.id.toHexString()}`, issue: 'referenced' }));
        throw new AppError('CONFLICT', { details: visible.length < users.length ? [...details, { field: 'places', issue: 'referenced' }] : details });
      }
      if (!(await repository.remove(principal, access, id))) {
        throw new AppError('NOT_FOUND');
      }
      const current = toTemplate(found);
      await record(principal, access, client, id, 'emailTemplate.deleted', loggable(current.name, current.text, current.html), undefined);
    },
  };
}
