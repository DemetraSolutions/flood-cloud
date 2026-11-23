import type { RequestHandler } from 'express';
import { createHmac } from 'node:crypto';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { canonicalJson, revalidates, sendRevalidatedPage, sendRevalidatedPageWith, sendRevalidatedWith } from '../../shared/http/etag.ts';
import type { ConfigurationReadAudit, ConfigurationResource } from './store-context.audit.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { StoreUsersQuery } from './store-context.users.ts';
import type { ReferenceService } from '../reference/reference.service.ts';
import type { StoreContextService } from './store-context.service.ts';

/** HTTP handlers of the store context routes. */
export interface StoreContextController {
  group: RequestHandler;
  company: RequestHandler;
  place: RequestHandler;
  /** `GET /store-context/countries`: the countries with their areas, the same list and the same tag as `GET /v1/countries`. */
  countries: RequestHandler;
  /** `GET /store-context/users`: a page of the users of the place, with their PIN in clear. */
  users: RequestHandler;
}

/**
 * Translates HTTP into {@link StoreContextService} calls. Every answer carries an `ETag` and a matching `If-None-Match` is a `304` without a body (the store polls these to learn whether its
 * configuration changed): the strong version of the stored document for the company and the place, a keyed digest of the content for the group. The answers carry credentials in clear: their routes are
 * declared `compress: false`, and nothing here logs or records a value.
 *
 * @param service The service.
 * @param versionKey The secret key of the versions (`VERSION_HMAC_KEY`), which also keys the tag of the group.
 * @param countries The reference service: the countries are platform data, read exactly as the backoffice list reads them (bounded, one response, weak content tag, nothing recorded).
 * @param audit The record of the reads that carry credentials (the group and the place, on a `200` only; the company has no credentials today).
 */
export function createStoreContextController(service: StoreContextService, versionKey: Buffer, audit: ConfigurationReadAudit, countries: Pick<ReferenceService, 'listCountries'>): StoreContextController {
  /** Sends the response and, when it is a `200` (not a `304`), records the read before it goes out. */
  const send = async (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], data: unknown, tag: string, resource: ConfigurationResource | null): Promise<void> => {
    if (resource !== null && !revalidates(req, tag)) {
      await audit.record(res.locals.store!, clientContextOf(req, res), resource);
    }
    sendRevalidatedWith(req, res, data, tag);
  };
  /** The strong tag of a body that holds credentials (the group, a page of users): HMAC-SHA-256, under the key of the versions, of the canonical form of the response together with its `kind` (domain separation: a tag of one kind is never valid for another). The response holds credentials, so the tag must not be a plain hash of it (it could be checked offline). */
  const keyedTag = (kind: 'storeGroup' | 'storeUsers', body: unknown): string => `"${createHmac('sha256', versionKey).update(canonicalJson({ kind, body })).digest('base64url')}"`;
  return {
    group: async (req, res) => {
      const { group } = await service.getGroup(res.locals.store!, res.locals.groupAccess!);
      await send(req, res, group, keyedTag('storeGroup', group), 'group');
    },
    company: async (req, res) => {
      const { company, version } = await service.getCompany(res.locals.store!, res.locals.groupAccess!);
      await send(req, res, company, entityTag(version), null);
    },
    users: async (req, res) => {
      const { users, page, companyId } = await service.getUsers(res.locals.store!, res.locals.groupAccess!, inputOf<StoreUsersQuery>(res, 'query'));
      // The body holds PINs: the tag of the page is keyed, never a plain hash of it.
      const tag = keyedTag('storeUsers', { data: users, page: { limit: page.limit, next: page.next } });
      if (!revalidates(req, tag)) {
        await audit.record(res.locals.store!, clientContextOf(req, res), 'users', companyId);
      }
      sendRevalidatedPageWith(req, res, users, page, tag);
    },
    countries: async (req, res) => {
      const { items, page } = await countries.listCountries();
      sendRevalidatedPage(req, res, items, page);
    },
    place: async (req, res) => {
      const { place, version } = await service.getPlace(res.locals.store!, res.locals.groupAccess!);
      await send(req, res, place, entityTag(version), 'place');
    },
  };
}
