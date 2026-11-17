import { AppError, DEFAULT_MESSAGES } from '../http/errors.ts';

/**
 * Why an item of a bulk trash operation was skipped (`doc/API.md`, trash section). `notFound` also covers an id outside the caller's perimeter or in
 * another group, so the answer never says whether such an item exists.
 */
export const TRASH_ISSUES = Object.freeze(['notFound', 'notTrashed', 'referenced', 'taken', 'forbidden'] as const);

/** A reason to skip an item of a bulk trash operation. */
export type TrashIssue = (typeof TRASH_ISSUES)[number];

/**
 * Which version an operation on one item of the trash checks: the `If-Match` of a single-item request, or none because the operation is one item of a bulk call (which has no versions: the
 * version is the one read just now, and the write checks it again atomically). The two cases are explicit, so a missing `If-Match` can never be taken for a bulk call.
 */
export type VersionCheck = { readonly kind: 'ifMatch'; readonly version: string } | { readonly kind: 'bulk' };

/** What a single item of a bulk operation became: done, or skipped for one reason. */
export type TrashItemOutcome = { readonly done: true } | { readonly done: false; readonly issue: TrashIssue };

/**
 * The ISO 8601 form of the trash date of a stored document: `null` when the field is absent or is not a valid `Date` (a document the legacy trashed has none, and
 * a stray value must never reach the answer).
 *
 * @param value The stored `trashDate`.
 * @returns The ISO string, or `null`.
 */
export function trashedAtOf(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/**
 * The reason an error of a single-item operation (restore or delete from the trash) means that the item is skipped in a bulk one. The bulk path runs the very same
 * service functions as the single-item routes, so the refusals are the ones those routes answer with:
 * - `NOT_FOUND` is `notFound`;
 * - `PRECONDITION_FAILED` (the item changed between the read and the write, for example restored by someone else) and a plain `CONFLICT` with its standard message (not in the right state, or
 *   restored by someone else first) are `notTrashed`;
 * - a `CONFLICT` with the detail `referenced` is `referenced`, and with the detail `taken` is `taken` (the VAT number of a company);
 * - `FORBIDDEN` is `forbidden`.
 * Any other `CONFLICT` (a document with a malformed block, or a detail this table does not know) is not a state of the trash: it is a fault of the data, and it goes on as an error.
 *
 * @param error The error thrown by the item operation.
 * @returns The issue, or `null` when the error is not a refusal of this kind (it is then a fault and goes on).
 */
export function issueOf(error: unknown): TrashIssue | null {
  if (!(error instanceof AppError)) {
    return null;
  }
  switch (error.code) {
    case 'NOT_FOUND':
      return 'notFound';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'PRECONDITION_FAILED':
      return 'notTrashed';
    case 'CONFLICT': {
      const detail = error.details?.[0]?.issue;
      if (detail === undefined) {
        return error.message === DEFAULT_MESSAGES.CONFLICT ? 'notTrashed' : null;
      }
      return detail === 'referenced' || detail === 'taken' ? detail : null;
    }
    default:
      return null;
  }
}

/**
 * Runs one item operation of a bulk call: a refusal of the operation becomes a skipped item, so that one item never aborts the others; anything else (a fault) is thrown.
 *
 * @param work The single-item operation (the same one the single-item route calls).
 * @returns `{ done: true }` when it succeeded, otherwise the issue.
 * @throws {unknown} Whatever is not a refusal of the operation.
 */
export async function settleItem(work: () => Promise<unknown>): Promise<TrashItemOutcome> {
  try {
    await work();
    return { done: true };
  } catch (error) {
    const issue = issueOf(error);
    if (issue === null) {
      throw error;
    }
    return { done: false, issue };
  }
}
