import type { RequestHandler } from 'express';
import { createHmac } from 'node:crypto';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { canonicalJson, revalidates, sendRevalidatedWith } from '../../shared/http/etag.ts';
import type { ConfigurationReadAudit, ConfigurationResource } from './store-context.audit.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import type { StoreContextService } from './store-context.service.ts';

/** HTTP handlers of the store context routes. */
export interface StoreContextController {
  group: RequestHandler;
  company: RequestHandler;
  place: RequestHandler;
}

/**
 * Translates HTTP into {@link StoreContextService} calls. Every answer carries an `ETag` and a matching `If-None-Match` is a `304` without a body (the store polls these to learn whether its
 * configuration changed): the strong version of the stored document for the company and the place, a keyed digest of the content for the group. The answers carry credentials in clear: their routes are
 * declared `compress: false`, and nothing here logs or records a value.
 *
 * @param service The service.
 * @param versionKey The secret key of the versions (`VERSION_HMAC_KEY`), which also keys the tag of the group.
 * @param audit The record of the reads that carry credentials (the group and the place, on a `200` only; the company has no credentials today).
 */
export function createStoreContextController(service: StoreContextService, versionKey: Buffer, audit: ConfigurationReadAudit): StoreContextController {
  /** Sends the response and, when it is a `200` (not a `304`), records the read before it goes out. */
  const send = async (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], data: unknown, tag: string, resource: ConfigurationResource | null): Promise<void> => {
    if (resource !== null && !revalidates(req, tag)) {
      await audit.record(res.locals.store!, clientContextOf(req, res), resource);
    }
    sendRevalidatedWith(req, res, data, tag);
  };
  /** The strong tag of the group: HMAC-SHA-256, under the key of the versions, of the canonical form of the response. The response holds credentials, so the tag must not be a plain hash of it (it could be checked offline). */
  const groupTag = (group: unknown): string => `"${createHmac('sha256', versionKey).update(canonicalJson(group)).digest('base64url')}"`;
  return {
    group: async (req, res) => {
      const { group } = await service.getGroup(res.locals.store!, res.locals.groupAccess!);
      await send(req, res, group, groupTag(group), 'group');
    },
    company: async (req, res) => {
      const { company, version } = await service.getCompany(res.locals.store!, res.locals.groupAccess!);
      await send(req, res, company, entityTag(version), null);
    },
    place: async (req, res) => {
      const { place, version } = await service.getPlace(res.locals.store!, res.locals.groupAccess!);
      await send(req, res, place, entityTag(version), 'place');
    },
  };
}
