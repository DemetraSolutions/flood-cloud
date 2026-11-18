import { createHmac } from 'node:crypto';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { canonicalJson } from '../../shared/http/etag.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { priceListOf } from './price-list.ts';
import type { PriceList } from './price-list.ts';
import type { SettingsRepository } from './settings.repository.ts';
import type { PriceListBody } from './settings.schemas.ts';

/** The price list with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface PriceListResult {
  readonly list: PriceList;
  readonly version: string;
}

/** The settings of the platform: for now the price list of the activations. */
export interface SettingsService {
  /** The price list in force (the default one while none was saved) with its version. */
  getPriceList(): Promise<PriceListResult>;
  /**
   * Replaces the price list.
   *
   * @param principal The authenticated administrator (the route requires `activations:manage`).
   * @param expected The version the client read.
   * @param body The validated whole list.
   * @param client Request context.
   * @throws {AppError} `PRECONDITION_FAILED` when the list is no longer the one that was read.
   */
  replacePriceList(principal: AuthPrincipal, expected: string, body: PriceListBody, client: ClientContext): Promise<PriceListResult>;
}

/** Collaborators of {@link createSettingsService}. */
export interface SettingsServiceDeps {
  readonly repository: SettingsRepository;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * The version of a price list: HMAC-SHA256 with the secret key of the server, in base64url, of its canonical JSON.
 *
 * @param list The price list.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function priceListVersion(list: PriceList, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson({ kind: 'priceList', list })).digest('base64url');
}

/**
 * Builds the service of the settings. Whoever calls it has the `activations:manage` permission (the route says so).
 *
 * @param deps Repository, activity log, version key and clock.
 */
export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { repository, activityLog, versionKey } = deps;
  const resultOf = (list: PriceList): PriceListResult => ({ list, version: priceListVersion(list, versionKey) });
  return {
    getPriceList: async () => resultOf(priceListOf(await repository.readPriceList())),

    replacePriceList: async (principal, expected, body, client) => {
      const read = await repository.readPriceList();
      const before = priceListOf(read);
      if (priceListVersion(before, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const next = priceListOf(body);
      if (canonicalJson(next) === canonicalJson(before)) {
        return resultOf(before);
      }
      if (!(await repository.replacePriceList(read, next, principal.userId, new Date(deps.now())))) {
        throw new AppError('PRECONDITION_FAILED');
      }
      await recordDataChange(activityLog, {
        actor: actorOf(principal),
        resource: { type: 'priceList', id: 'PRICE_LIST' },
        action: 'priceList.updated',
        before: { ...before },
        after: { ...next },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
      });
      return resultOf(next);
    },
  };
}
