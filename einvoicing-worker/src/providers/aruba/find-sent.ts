/**
 * The search for an invoice that may already be at Aruba (after a crash, or a timeout after the request left).
 *
 * Aruba has no lookup by invoice number, so the search lists the seller's uploaded invoices in a time window and matches
 * the number, the invoice date and the document type on the client. The window starts one hour before `ref.since` (the
 * first upload attempt, or the end of the last complete search) and ends now; it is cut in slices of less than two days
 * (the most Aruba allows), searched in time order so a hit ends the search early, at most ten pages of a hundred a slice.
 *
 * **`notFound` is only ever the answer of a complete search**: if the window is longer than seven slices, or a slice
 * still has more pages after the tenth, or Aruba gives no way to tell whether a page is the last, the answer is
 * `unknown` (the engine stops the record for a person and never uploads it again on its own).
 *
 * Pagination. The end of a slice is read from Aruba's page metadata: `last === true`, or `number + 1 >= totalPages`; when
 * neither is present a full page means "more" and a short page after the first means "last", while a short **first** page
 * proves nothing (Aruba may have capped the page size) and is `unknown`. Page numbers start at {@link PAGE_BASE}; if the
 * first page of a slice answers `number: PAGE_BASE` with `first: false` the API counts from zero and the slice is read
 * again from page 0.
 *
 * Every request after the first goes through the per-IP status limiter (the engine took the turn for the first). One call
 * works for at most {@link FIND_BUDGET_MS}, sign-in included, and no wait is longer than {@link MAX_SLOT_WAIT_MS}: what is
 * left is a `retry` carrying where to go on from (`resume`), which the engine stores and hands back.
 *
 * @module
 */
import { ipKey } from '../../engine/pacing.ts';
import { romeDate } from '../../time.ts';
import type { Account, FindOutcome, InvoiceRef } from '../types.ts';
import { authorizedCall } from './context.ts';
import type { ArubaContext } from './context.ts';
import { ARUBA_LIMITS, FIND_BUDGET_MS, LARGE_RESPONSE_BYTES, MAX_SLOT_WAIT_MS, PROVIDER_ID_PATTERN } from './settings.ts';
import { takeSlot } from './slots.ts';
import { cleanText, isRecord, parseJson } from './text.ts';

const HOUR = 3_600_000;
/** Less than two days, the longest window Aruba accepts. */
const SLICE_MS = 47 * HOUR;
const MAX_SLICES = 7;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
/**
 * The number of the first page, as sent in `page`. **Assumption**: Aruba counts pages from 1 (its documented default); a
 * response that contradicts it is detected (see the module description). If the demo shows otherwise, flip this one value.
 */
export const PAGE_BASE = 1;
const STATUS_KEY = ipKey('aruba', 'status');

/** A retry that says where to go on from. */
const retry = (afterMs: number, code: string, slice: number, page: number): FindOutcome => ({ kind: 'retry', afterMs, code, resume: { slice, page } });

/** The day (`YYYY-MM-DD`, Europe/Rome) of an `invoiceDate`, which Aruba gives as a date or a date with time and offset. */
function invoiceDay(value: unknown): string | undefined {
  const text = cleanText(value, 40);
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) {
    return text;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : romeDate(time);
}

/** Whether an invoice of a search result is the one looked for. The document type is compared when Aruba gives one. */
function matches(invoice: unknown, ref: InvoiceRef): boolean {
  if (!isRecord(invoice) || cleanText(invoice['number'], 100) !== ref.number || invoiceDay(invoice['invoiceDate']) !== ref.date) {
    return false;
  }
  return [invoice['docType'], invoice['invoiceType']].map((type) => cleanText(type, 10).toUpperCase()).every((type) => !/^TD[0-9]{2}$/.test(type) || type === ref.documentType);
}

/** What a page says about the pages after it. */
type More = 'last' | 'more' | 'unknown';

/** Whether there are pages after this one (see the module description). */
function moreAfter(body: Record<string, unknown>, length: number, firstPage: boolean): More {
  if (body['last'] === true) {
    return 'last';
  }
  const { number, totalPages } = body;
  if (typeof number === 'number' && typeof totalPages === 'number') {
    return number + 1 >= totalPages ? 'last' : 'more';
  }
  if (body['last'] === false || length >= PAGE_SIZE) {
    return 'more';
  }
  return firstPage ? 'unknown' : 'last';
}

/** The search of one adapter. */
export interface Finder {
  /** Looks for a file that may have been sent; see the module description. */
  findSent(account: Account, ref: InvoiceRef, signal: AbortSignal): Promise<FindOutcome>;
}

/**
 * Creates the finder.
 *
 * @param ctx Collaborators.
 * @returns The finder.
 */
export function createFinder(ctx: ArubaContext): Finder {
  return {
    async findSent(account, ref, signal) {
      const hub = account.hub;
      const began = ctx.clock();
      const start = ref.since - HOUR;
      const slices = Math.max(1, Math.ceil((began - start) / SLICE_MS));
      if (slices > MAX_SLICES) {
        ctx.logger.warn('the file is too old to be searched at Aruba: a person must check it', { hub, queueId: ref.queueId });
        return { kind: 'unknown' };
      }
      let first = true;
      for (let slice = ref.resume?.slice ?? 0; slice < slices; slice += 1) {
        const from = start + slice * SLICE_MS;
        const to = Math.max(from, Math.min(from + SLICE_MS, began));
        let base = PAGE_BASE;
        let page = slice === ref.resume?.slice ? ref.resume.page : base;
        for (let pages = 0; pages < MAX_PAGES; pages += 1) {
          const remaining = FIND_BUDGET_MS - (ctx.clock() - began);
          if (remaining <= 0) {
            return retry(60_000, 'FIND_BUDGET', slice, page);
          }
          if (!first) {
            const refusal = await takeSlot(ctx, STATUS_KEY, ARUBA_LIMITS.ip.status, Math.min(MAX_SLOT_WAIT_MS, remaining), signal);
            if (refusal !== undefined) {
              return retry(refusal.afterMs, refusal.code === 'ABORTED' ? 'ABORTED' : 'FIND_BUDGET', slice, page);
            }
          }
          first = false;
          const query = [
            ['senderCountry', ref.sellerVat.slice(0, 2)],
            ['senderVatcode', ref.sellerVat.slice(2)],
            ['creationStartDate', new Date(from).toISOString()],
            ['creationEndDate', new Date(to).toISOString()],
            ['page', String(page)],
            ['size', String(PAGE_SIZE)],
          ]
            .map(([name, value]) => `${name}=${encodeURIComponent(value as string)}`)
            .join('&');
          const call = await authorizedCall(ctx, hub, signal, { method: 'GET', url: `${ctx.hosts.ws}/api/v2/invoices-out?${query}`, timeoutMs: ctx.timeouts.request, maxBytes: LARGE_RESPONSE_BYTES });
          if (call.kind === 'wait') {
            return retry(call.afterMs, call.code, slice, page);
          }
          if (call.kind === 'failed') {
            return call.failure === 'aborted' ? retry(1_000, 'ABORTED', slice, page) : retry(60_000, `NETWORK_${call.failure.toUpperCase()}`, slice, page);
          }
          if (call.response.status === 429) {
            await ctx.limiters.coolDown(STATUS_KEY, ctx.clock() + 65_000);
            return retry(65_000, 'HTTP_429', slice, page);
          }
          const parsed = call.response.status === 200 ? parseJson(call.response.text) : undefined;
          if (parsed === undefined || !parsed.ok || !isRecord(parsed.value)) {
            return retry(60_000, call.response.status === 200 ? 'MALFORMED' : `HTTP_${call.response.status}`, slice, page);
          }
          const body = parsed.value;
          const content = Array.isArray(body['content']) ? (body['content'] as unknown[]) : [];
          for (const entry of content) {
            if (isRecord(entry) && Array.isArray(entry['invoices']) && (entry['invoices'] as unknown[]).some((invoice) => matches(invoice, ref))) {
              const filename: unknown = entry['filename'];
              if (typeof filename === 'string' && PROVIDER_ID_PATTERN.test(filename)) {
                return { kind: 'found', providerId: filename };
              }
              ctx.logger.error('Aruba has the file but its name is not one the worker can use: a person must check it', { hub, queueId: ref.queueId });
              return retry(HOUR, 'INVALID_PROVIDER_ID', slice, page);
            }
          }
          if (base === PAGE_BASE && page === PAGE_BASE && body['first'] === false && body['number'] === PAGE_BASE) {
            // Aruba counts from zero: page 1 was its second page. Read the slice again from page 0.
            base = PAGE_BASE - 1;
            page = base;
            pages -= 1;
            continue;
          }
          const more = moreAfter(body, content.length, page === base);
          if (more === 'unknown') {
            return { kind: 'unknown' };
          }
          if (more === 'last') {
            break;
          }
          if (pages === MAX_PAGES - 1) {
            ctx.logger.warn('a slice of the search has more pages than the worker reads: a person must check the file', { hub, queueId: ref.queueId });
            return { kind: 'unknown' };
          }
          page += 1;
        }
      }
      return { kind: 'notFound' };
    },
  };
}
