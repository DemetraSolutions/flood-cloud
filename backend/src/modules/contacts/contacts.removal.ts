import type { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { MAX_REPORTED_REFERENCES, REFERENCE_MAX_TIME_MS } from './contacts.repository.ts';
import type { ContactReferenceKind, ContactsRepository } from './contacts.repository.ts';

/** What the deletion of a contact reads. */
export interface RemovalDeps {
  readonly repository: Pick<ContactsRepository, 'referencedBy' | 'promotionsNamingContact'>;
  /** Clock in epoch milliseconds: the budget of the checks is measured with it. */
  readonly now: () => number;
}

/** The time the eight checks of one deletion may take together, in milliseconds: when it is used up the deletion does not go on (`503`). */
export const REMOVAL_BUDGET_MS = 10_000;

/** The shortest time limit a check is given (the rest of the budget is never asked to the database as less). */
const MIN_CHECK_MS = 100;

/** The kinds a refused deletion looks for after the promotions, in the order it looks (from the cheapest): each is listed under its own name. */
const LATER_KINDS: readonly ContactReferenceKind[] = ['products', 'warehouseMovements', 'appointments', 'tableReservations', 'documents', 'sales'];

/**
 * Refuses (`409` with the references) the definitive deletion of a contact that is still named by something: another contact (a person that works for it), a promotion of the group, a product (as a supplier or as the
 * last supplier, trashed products included), a movement of the warehouse, an appointment, a table reservation, a document or a sale. The kinds are looked for one after the other, from the cheapest, and the search stops at
 * the first kind found: the `409` lists (at most 20 of) that kind only, as `<kind>.<id>` with the issue `referenced`. The searches share a budget of {@link REMOVAL_BUDGET_MS} for the contact: each one is given the time
 * that is left (at most `REFERENCE_MAX_TIME_MS`), and when the budget is used up, or a search exceeds its limit, the deletion does not go on (`503`). Moving a contact to the trash is never blocked by its references.
 *
 * @param deps The reads and the clock.
 * @param principal The authenticated caller.
 * @param access Verified access to the group.
 * @param id Id of the contact.
 * @throws {AppError} `CONFLICT` with a `referenced` detail for each reference; `SERVICE_UNAVAILABLE` when the budget is used up or a search exceeds its time limit.
 */
export async function guardContactRemoval(deps: RemovalDeps, principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<void> {
  const deadline = deps.now() + REMOVAL_BUDGET_MS;
  const refuse = (kind: string, found: readonly string[]): never => {
    throw new AppError('CONFLICT', { details: found.slice(0, MAX_REPORTED_REFERENCES).map((item) => ({ field: `${kind}.${item}`, issue: 'referenced' })) });
  };
  const search = async (kind: ContactReferenceKind): Promise<string[]> => {
    const left = deadline - deps.now();
    if (left < MIN_CHECK_MS) {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
    return deps.repository.referencedBy(principal, access, id, kind, Math.min(left, REFERENCE_MAX_TIME_MS));
  };
  const associated = await search('contactAssociations');
  if (associated.length > 0) {
    refuse('contactAssociations', associated);
  }
  const promoted = await deps.repository.promotionsNamingContact(access, id);
  if (promoted.length > 0) {
    refuse('promotions', promoted);
  }
  for (const kind of LATER_KINDS) {
    const found = await search(kind);
    if (found.length > 0) {
      refuse(kind, found);
    }
  }
}
