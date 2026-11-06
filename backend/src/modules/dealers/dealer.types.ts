import type { ObjectId } from 'mongodb';
import type { UserStatus } from '../users/user.types.ts';

/** The postal address of a dealer's company. */
export interface DealerAddress {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  /** Province code (two letters for Italy), `null` where the country has none. */
  readonly province: string | null;
  /** ISO 3166-1 alpha-2 code, upper case. */
  readonly countryCode: string;
}

/** The company data of a dealer: what a user edits. */
export interface Company {
  /** Company name (ragione sociale). */
  readonly businessName: string;
  /** VAT number (P.IVA), unique among the dealers that have one. */
  readonly vatNumber: string | null;
  readonly fiscalCode: string | null;
  readonly address: DealerAddress | null;
  /** Certified e-mail address (PEC). */
  readonly pec: string | null;
  /** Recipient code (codice destinatario) of the electronic invoice. */
  readonly sdiCode: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

/** Where a dealer document came from: created by a PSA, by the migration of the existing dealers, or together with a `D` user. */
export type DealerSource = 'manual' | 'migration' | 'user';

/** A dealer as stored in `common.dealers`; its `id` is the id of the dealer's user. */
export interface Dealer extends Company {
  readonly id: ObjectId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: ObjectId | null;
  readonly source: DealerSource;
}

/** The user linked to a dealer, as the lists and the detail show it. */
export interface DealerUser {
  readonly id: string;
  readonly username: string;
  readonly status: UserStatus;
}

/** What `/v1/dealers` returns for a dealer. `user` is `null` only if the linked user no longer exists. */
export interface DealerResponse extends Company {
  readonly id: string;
  readonly source: DealerSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly user: DealerUser | null;
}

/** Id and name of the dealer of a `D` user, as `GET /v1/me` shows them. */
export interface DealerSummary {
  readonly id: string;
  readonly businessName: string;
}
