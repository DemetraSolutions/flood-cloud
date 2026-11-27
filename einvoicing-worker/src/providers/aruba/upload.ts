/**
 * The upload of an invoice and the translation of Aruba's answer into an outcome of the contract.
 *
 * Aruba answers `200` with an `errorCode` even for business errors; only the code tells what happened. The rules of the
 * outcome (what is retried, by whom, after how long) are documented in `doc/Technical-Guide.md` §13.
 *
 * **Anti-tappo** (the legacy's rule, kept): an excess of the tier's hourly bucket answers `429` at once, and *any* request
 * restarts the bucket's one-hour expiry, so hammering makes it worse. The first `429` (or code `0099`, undocumented but
 * treated by the legacy, in production, as the same limit) on a seller pauses that seller for 62 minutes (so the other
 * sellers of the hub keep flowing); a second one in a row on a **different** seller means the whole account is blocked
 * and the account backs off in steps (10, 25, 62 minutes, persisted by the engine). The "last seller that was limited"
 * of each hub is kept **in memory**: after a restart the first `429` is treated as a first one (the engine's seller
 * cooldown and account backoff are persisted, this only decides which of the two applies). It is cleared on the next
 * accepted upload and when the hub is forgotten.
 *
 * @module
 */
import { accountKey } from '../../engine/pacing.ts';
import type { Account, OutgoingFile, UploadOutcome } from '../types.ts';
import { authorizedCall } from './context.ts';
import type { ArubaContext } from './context.ts';
import { PROVIDER_ID_PATTERN, SMALL_RESPONSE_BYTES } from './settings.ts';
import { cleanText, isRecord, parseJson } from './text.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The uploader of one adapter. */
export interface Uploader {
  /** Uploads a file; see the module description for the outcomes. */
  upload(account: Account, file: OutgoingFile, signal: AbortSignal): Promise<UploadOutcome>;
  /** Clears the anti-tappo state of a hub. */
  forget(hub: string): void;
}

/** Statuses that say the request itself is wrong: no retry can fix them. Any other status that is not a `200` leaves the outcome unknown. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413, 415]);

const retry = (scope: 'document' | 'seller' | 'account' | 'ip', afterMs: number, code: string): UploadOutcome => ({ kind: 'retry', scope, afterMs, code });

/**
 * Creates the uploader.
 *
 * @param ctx Collaborators.
 * @returns The uploader.
 */
export function createUploader(ctx: ArubaContext): Uploader {
  /** The seller that was limited last, by hub; cleared by an accepted upload. */
  const lastLimited = new Map<string, string>();

  /**
   * A short pause of the whole account that does not escalate: the account's upload limiter is held for a minute, and the
   * outcome is only a document retry (an `account` retry would step the persistent backoff 10, 25, 62 minutes).
   */
  const pauseAccount = async (hub: string, code: string): Promise<UploadOutcome> => {
    await ctx.limiters.coolDown(accountKey(hub, 'upload'), ctx.clock() + MINUTE);
    return retry('document', MINUTE, code);
  };

  const rateLimited = (hub: string, seller: string, code: string): UploadOutcome => {
    const previous = lastLimited.get(hub);
    lastLimited.set(hub, seller);
    if (previous !== undefined && previous !== seller) {
      ctx.logger.warn('two different sellers were limited in a row: the account backs off', { hub, code });
      return retry('account', 10 * MINUTE, code);
    }
    return retry('seller', 62 * MINUTE, code);
  };

  /** The outcome of a `200` answer, by its `errorCode`. */
  const byCode = async (account: Account, file: OutgoingFile, body: Record<string, unknown>): Promise<UploadOutcome> => {
    const hub = account.hub;
    const code = cleanText(body['errorCode'], 20);
    const description = cleanText(body['errorDescription'], 1000);
    switch (code) {
      case '0000': {
        const name: unknown = body['uploadFileName'];
        if (typeof name === 'string' && PROVIDER_ID_PATTERN.test(name)) {
          lastLimited.delete(hub);
          return { kind: 'accepted', providerId: name };
        }
        ctx.logger.warn('Aruba accepted the file without a usable file name: it will be looked up', { hub });
        return { kind: 'maybeSent' };
      }
      case '0034':
        return { kind: 'maybeSent' };
      case '0099':
        return rateLimited(hub, file.sellerVat, 'ARUBA_0099');
      case '0093':
        return retry('seller', HOUR, 'ARUBA_0093');
      case '0001':
      case '0013':
        // A generic failure or a failed save may come after Aruba stored the file: look it up before any new upload.
        return { kind: 'maybeSent' };
      case '0095':
        return retry('document', 15 * MINUTE, 'ARUBA_0095');
      case '0012':
        ctx.sessions.dropAccessToken(hub);
        return await pauseAccount(hub, 'ARUBA_0012');
      case '0097':
        ctx.logger.error('the Aruba storage of the account is full: nothing can be sent', { hub });
        return retry('account', 6 * HOUR, 'ARUBA_0097');
      default:
        return { kind: 'rejected', code, description };
    }
  };

  return {
    async upload(account, file, signal) {
      const hub = account.hub;
      const json = JSON.stringify({ dataFile: Buffer.from(file.xml, 'utf8').toString('base64'), credential: '', domain: '', senderPIVA: '', skipExtraSchema: false, dryRun: false });
      const call = await authorizedCall(ctx, hub, signal, { method: 'POST', url: `${ctx.hosts.ws}/services/invoice/upload`, json, timeoutMs: ctx.timeouts.upload, maxBytes: SMALL_RESPONSE_BYTES });
      if (call.kind === 'wait') {
        if (call.code === 'HTTP_401') {
          return await pauseAccount(hub, 'HTTP_401');
        }
        // An abort (the lease is lost) holds nothing back: neither the IP nor the account.
        return call.code === 'ABORTED' ? retry('document', call.afterMs, 'ABORTED') : retry(call.scope, call.afterMs, call.code);
      }
      if (call.kind === 'failed') {
        // Only a failure to connect proves the file did not leave; anything after that may have been taken.
        return call.failure === 'connect' ? retry('ip', MINUTE, 'CONNECT') : { kind: 'maybeSent' };
      }
      const { status, text } = call.response;
      if (status === 429) {
        return rateLimited(hub, file.sellerVat, 'HTTP_429');
      }
      if (status !== 200) {
        // A server error, a timeout (408), a conflict (409) or anything unexpected may come after Aruba took the file: the
        // engine looks it up before any new upload. Only a request that is plainly wrong is refused for good.
        return REFUSED_STATUSES.has(status) ? { kind: 'rejected', code: `HTTP_${status}`, description: `Aruba ha rifiutato la richiesta (HTTP ${status})` } : { kind: 'maybeSent' };
      }
      const parsed = parseJson(text);
      if (!parsed.ok || !isRecord(parsed.value)) {
        ctx.logger.warn('the Aruba answer to an upload was not understood: the file will be looked up', { hub });
        return { kind: 'maybeSent' };
      }
      return await byCode(account, file, parsed.value);
    },
    forget(hub) {
      lastLimited.delete(hub);
    },
  };
}

