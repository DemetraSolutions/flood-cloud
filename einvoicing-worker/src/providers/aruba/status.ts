/**
 * The state of an uploaded file: the detail of the invoice, translated into the normalized states of the contract, and for
 * a discard the reasons from the SdI notification.
 *
 * Aruba's states are Italian words; they are compared case-insensitively and with the spaces folded. A state that is not
 * in the table (Aruba also has `Ricevuta`) is logged once and treated as `sent`, which keeps the invoice polled.
 *
 * @module
 */
import { ipKey } from '../../engine/pacing.ts';
import type { Account, NormalizedStatus, SdiError, StatusOutcome } from '../types.ts';
import { authorizedCall } from './context.ts';
import type { ArubaContext } from './context.ts';
import { errorsFromDescription, errorsFromDetail, errorsFromNotification } from './errors.ts';
import { LARGE_RESPONSE_BYTES, MAX_SLOT_WAIT_MS, NOTIFICATIONS_RULE, PROVIDER_ID_PATTERN } from './settings.ts';
import { takeSlot } from './slots.ts';
import { cleanText, isRecord, parseJson } from './text.ts';

const STATES: ReadonlyMap<string, NormalizedStatus> = new Map<string, NormalizedStatus>([
  ['presa in carico', 'takingCharge'],
  ['errore elaborazione', 'processingError'],
  ['inviata', 'sent'],
  ['scartata', 'rejected'],
  ['non consegnata', 'notDelivered'],
  ['recapito impossibile', 'deliveryImpossible'],
  ['consegnata', 'delivered'],
  ['accettata', 'accepted'],
  ['rifiutata', 'refused'],
  ['decorrenza termini', 'effectiveDate'],
]);

/** Most distinct unknown states remembered (to log each once). */
const MAX_UNKNOWN_STATES = 50;

const NOTIFICATIONS_KEY = ipKey('aruba', 'notifications');

const retryIp = (afterMs: number, code: string): StatusOutcome => ({ kind: 'retry', scope: 'ip', afterMs, code });

/** What the notification of a discard gave. */
type Reasons = { readonly kind: 'errors'; readonly errors: readonly SdiError[] } | Extract<StatusOutcome, { kind: 'retry' }>;

/** The status reader of one adapter. */
export interface StatusReader {
  /** The state of an uploaded file; see the module description. */
  status(account: Account, providerId: string, signal: AbortSignal): Promise<StatusOutcome>;
}

/**
 * Creates the status reader.
 *
 * @param ctx Collaborators.
 * @returns The reader.
 */
export function createStatusReader(ctx: ArubaContext): StatusReader {
  const unknownStates = new Set<string>();

  const normalize = (raw: unknown): NormalizedStatus => {
    const text = cleanText(raw, 60).toLowerCase().replace(/\s+/g, ' ');
    const known = STATES.get(text);
    if (known !== undefined) {
      return known;
    }
    if (!unknownStates.has(text) && unknownStates.size < MAX_UNKNOWN_STATES) {
      unknownStates.add(text);
      ctx.logger.warn('Aruba reported a state that is not in the table: treated as sent', { state: text });
    }
    return 'sent';
  };

  /** The reasons of a discard from the SdI notification (`NS`) of the file. */
  const reasonsFromNotification = async (hub: string, providerId: string, signal: AbortSignal): Promise<Reasons> => {
    const refusal = await takeSlot(ctx, NOTIFICATIONS_KEY, NOTIFICATIONS_RULE, MAX_SLOT_WAIT_MS, signal);
    if (refusal !== undefined) {
      return { kind: 'retry', scope: 'account', afterMs: refusal.afterMs, code: `NOTIFICATIONS_${refusal.code}` };
    }
    const call = await authorizedCall(ctx, hub, signal, {
      method: 'GET',
      url: `${ctx.hosts.ws}/api/v2/invoices-out/notifications?filename=${encodeURIComponent(providerId)}`,
      timeoutMs: ctx.timeouts.request,
      maxBytes: LARGE_RESPONSE_BYTES,
    });
    if (call.kind === 'wait') {
      return { kind: 'retry', scope: call.scope, afterMs: call.afterMs, code: call.code };
    }
    if (call.kind === 'response' && call.response.status === 429) {
      await ctx.limiters.coolDown(NOTIFICATIONS_KEY, ctx.clock() + 65_000);
      return { kind: 'retry', scope: 'account', afterMs: 65_000, code: 'HTTP_429' };
    }
    const parsed = call.kind === 'response' && call.response.status === 200 ? parseJson(call.response.text) : undefined;
    const notifications = parsed?.ok === true && isRecord(parsed.value) ? parsed.value['notifications'] : undefined;
    const found = (Array.isArray(notifications) ? (notifications as unknown[]) : []).find((item) => isRecord(item) && cleanText(item['docType'], 10).toUpperCase() === 'NS' && typeof item['file'] === 'string');
    const errors = isRecord(found) ? errorsFromNotification(found['file'] as string) : undefined;
    if (errors === undefined) {
      // The status is still reported: the reasons are a courtesy, and the file may simply not be there yet.
      ctx.logger.warn('the reasons of a discard could not be read from the notification', { hub });
      return { kind: 'errors', errors: [] };
    }
    return { kind: 'errors', errors };
  };

  return {
    async status(account, providerId, signal) {
      const hub = account.hub;
      if (!PROVIDER_ID_PATTERN.test(providerId)) {
        ctx.logger.warn('the stored file name is not one Aruba gives: nothing is asked', { hub });
        return { kind: 'notFound' };
      }
      const call = await authorizedCall(ctx, hub, signal, {
        method: 'GET',
        url: `${ctx.hosts.ws}/api/v2/invoices-out/detail?filename=${encodeURIComponent(providerId)}&includeFile=false`,
        timeoutMs: ctx.timeouts.request,
        maxBytes: LARGE_RESPONSE_BYTES,
      });
      if (call.kind === 'wait') {
        return { kind: 'retry', scope: call.scope, afterMs: call.afterMs, code: call.code };
      }
      if (call.kind === 'failed') {
        // An abort (the lease is lost) is not the IP's fault: nothing is held back but this one check.
        return call.failure === 'aborted' ? { kind: 'retry', scope: 'account', afterMs: 1_000, code: 'ABORTED' } : retryIp(60_000, `NETWORK_${call.failure.toUpperCase()}`);
      }
      const { status, text } = call.response;
      if (status === 404) {
        return { kind: 'notFound' };
      }
      if (status === 429) {
        return retryIp(65_000, 'HTTP_429');
      }
      if (status >= 500) {
        return retryIp(60_000, `HTTP_${status}`);
      }
      if (status !== 200) {
        return { kind: 'retry', scope: 'account', afterMs: 600_000, code: `HTTP_${status}` };
      }
      if (text.trim() === '') {
        return { kind: 'notFound' };
      }
      const parsed = parseJson(text);
      if (!parsed.ok || !isRecord(parsed.value)) {
        return retryIp(60_000, 'MALFORMED');
      }
      const invoices: unknown = parsed.value['invoices'];
      const invoice = Array.isArray(invoices) ? (invoices[0] as unknown) : undefined;
      if (!isRecord(invoice)) {
        return { kind: 'notFound' };
      }
      const normalized = normalize(invoice['status']);
      if (normalized === 'processingError') {
        return { kind: 'status', status: normalized, sdiErrors: errorsFromDescription(invoice['statusDescription']) };
      }
      if (normalized !== 'rejected') {
        return { kind: 'status', status: normalized };
      }
      const fromDetail = errorsFromDetail(parsed.value['sdiErrors']);
      if (fromDetail.length > 0) {
        return { kind: 'status', status: normalized, sdiErrors: fromDetail };
      }
      const reasons = await reasonsFromNotification(hub, providerId, signal);
      return reasons.kind === 'retry' ? reasons : { kind: 'status', status: normalized, sdiErrors: reasons.errors };
    },
  };
}
