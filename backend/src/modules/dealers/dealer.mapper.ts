import type { Document, ObjectId } from 'mongodb';
import type { Company, Dealer, DealerResponse, DealerSource, DealerUser } from './dealer.types.ts';

/** Fields read from `common.dealers` (all of them; `createdBy` is internal and not part of the response). */
export const DEALER_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  businessName: 1,
  vatNumber: 1,
  fiscalCode: 1,
  address: 1,
  pec: 1,
  sdiCode: 1,
  email: 1,
  phone: 1,
  createdAt: 1,
  updatedAt: 1,
  createdBy: 1,
  source: 1,
});

/** The company data of a document or a dealer, in the order they are stored. */
export function companyOf(source: Company): Company {
  return {
    businessName: source.businessName,
    vatNumber: source.vatNumber,
    fiscalCode: source.fiscalCode,
    address: source.address === null ? null : { ...source.address },
    pec: source.pec,
    sdiCode: source.sdiCode,
    email: source.email,
    phone: source.phone,
  };
}

/**
 * The company of a dealer created together with a `D` user, or from an existing one: the user name as the
 * company name and nothing else, which the owner completes later.
 *
 * @param username The user name of the `D` user.
 */
export function minimalCompany(username: string): Company {
  return { businessName: username, vatNumber: null, fiscalCode: null, address: null, pec: null, sdiCode: null, email: null, phone: null };
}

/**
 * The document to insert in `common.dealers`. Every field is present (absent values are `null`), the shape every reader expects.
 *
 * @param id Id of the dealer's user.
 * @param company The company data.
 * @param source How the dealer came to be.
 * @param createdBy The administrator who created it, `null` for a migration.
 * @param now Creation time.
 */
export function toNewDocument(id: ObjectId, company: Company, source: DealerSource, createdBy: ObjectId | null, now: Date): Document {
  return { _id: id, ...companyOf(company), createdAt: now, updatedAt: now, createdBy, source };
}

/** Reads a stored dealer. This backend is the only writer of the collection, so the stored types are trusted. */
export function fromDocument(document: Document): Dealer {
  return {
    id: document['_id'] as ObjectId,
    ...companyOf(document as unknown as Company),
    createdAt: document['createdAt'] as Date,
    updatedAt: document['updatedAt'] as Date,
    createdBy: document['createdBy'] as ObjectId | null,
    source: document['source'] as DealerSource,
  };
}

/**
 * The response form of a dealer: an explicit allowlist, dates in ISO 8601, with the user linked to it.
 *
 * @param dealer The dealer.
 * @param user The linked user, or `null` when he does not exist.
 */
export function toResponse(dealer: Dealer, user: DealerUser | null): DealerResponse {
  return {
    id: dealer.id.toHexString(),
    ...companyOf(dealer),
    source: dealer.source,
    createdAt: dealer.createdAt.toISOString(),
    updatedAt: dealer.updatedAt.toISOString(),
    user,
  };
}
