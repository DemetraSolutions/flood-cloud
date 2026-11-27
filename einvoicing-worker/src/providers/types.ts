/**
 * The contract between the queue engine and a provider adapter (Aruba today, others later).
 *
 * The engine knows nothing about a provider: it hands the adapter an account and a file and reads back an outcome. The
 * adapter owns authentication, the wire format, the translation of the provider's states and error codes, and the
 * provider's own limits (as data, in {@link ProviderLimits}, which the engine enforces with persistent limiters).
 *
 * Two rules for every adapter. (1) **Throw only sanitized errors**: the engine logs only the name and the code of an
 * error an adapter throws, never its message, but an error can still travel elsewhere: never put a response body, an XML
 * document, a token or a password in one. (2) **Treat `providerId` as untrusted text** (it comes from the provider and is
 * stored): validate it and encode it before using it in a URL or a path.
 *
 * @module
 */
import type { Secret } from '../secret.ts';
import type { LimitRule } from '../limits/limiters.ts';

/** A provider account, as read from the database and decrypted. */
export interface Account {
  /** The hub (`aruba`, `aruba__<dealerId>`). */
  readonly hub: string;
  /** The provider (`aruba`). */
  readonly provider: string;
  readonly username: string;
  /** The password in clear: reveal it only at the point of use, never log it. */
  readonly password: Secret;
  /** Uploads allowed in any sliding hour. */
  readonly maxPerHour: number;
  /** Uploads allowed in a calendar year, `null` for no yearly cap. */
  readonly maxPerYear: number | null;
}

/** What identifies an invoice. */
export interface InvoiceIdentity {
  /** The queue record id (24 hexadecimal characters). */
  readonly queueId: string;
  /** The seller's fiscal identifier: country and code, for example `IT01234567890`. */
  readonly sellerVat: string;
  /** `Numero` of the invoice. */
  readonly number: string;
  /** `Data` of the invoice, `YYYY-MM-DD`. */
  readonly date: string;
  /** `ProgressivoInvio` of the file. */
  readonly progressive: string;
  /** `TipoDocumento` of the invoice (`TD01`, ...). */
  readonly documentType: string;
}

/** What identifies an invoice that may already be at the provider: enough to look it up after a crash or a timeout. */
export interface InvoiceRef extends InvoiceIdentity {
  /** When the first upload of the file started, in milliseconds since the epoch: the file cannot have been taken earlier. */
  readonly since: number;
  /** Where an interrupted search stopped (`FindOutcome` `retry` `resume`): the search goes on from there instead of starting over. */
  readonly resume?: SearchPosition;
}

/** A position in a search of the provider: the time slice and the page of the slice. */
export interface SearchPosition {
  readonly slice: number;
  readonly page: number;
}

/** A file ready to be sent. */
export interface OutgoingFile extends InvoiceIdentity {
  /** The serialized, validated FatturaPA document. */
  readonly xml: string;
}

/** Outcome of an upload. */
export type UploadOutcome =
  /** The provider took the file; `providerId` is the name or id it gave (stored as `hubId`). */
  | { readonly kind: 'accepted'; readonly providerId: string }
  /** The provider refused the file for good: nothing to retry. */
  | { readonly kind: 'rejected'; readonly code: string; readonly description: string }
  /** The file may have been taken (a timeout after sending, "already sent recently"): the engine looks it up before any new attempt. */
  | { readonly kind: 'maybeSent' }
  /**
   * Nothing was taken, try again later. `scope` says who is blocked: the one `document`, every document of the `seller`,
   * the whole `account` (stepped backoff) or the `ip` (every account of the provider).
   */
  | { readonly kind: 'retry'; readonly scope: 'document' | 'seller' | 'account' | 'ip'; readonly afterMs: number; readonly code: string };

/** The states every provider's states are normalized to; they are written as `sendStatus` as they are. */
export type NormalizedStatus =
  | 'takingCharge'
  | 'sent'
  | 'processingError'
  | 'rejected'
  | 'delivered'
  | 'notDelivered'
  | 'deliveryImpossible'
  | 'accepted'
  | 'refused'
  | 'effectiveDate';

/** One reason of a rejection, as the provider reports it from the SdI notification. */
export interface SdiError {
  readonly code: string;
  readonly description: string;
}

/** Outcome of a status request. */
export type StatusOutcome =
  | { readonly kind: 'status'; readonly status: NormalizedStatus; readonly sdiErrors?: readonly SdiError[] }
  /** The provider does not know the file. */
  | { readonly kind: 'notFound' }
  /** Not now: `account` blocks this account's status requests, `ip` every account of the provider. */
  | { readonly kind: 'retry'; readonly scope: 'account' | 'ip'; readonly afterMs: number; readonly code: string };

/** Outcome of the lookup of a file that may have been sent. */
export type FindOutcome =
  | { readonly kind: 'found'; readonly providerId: string }
  /** The search was **complete** and the file is not there: only then may the engine upload. */
  | { readonly kind: 'notFound' }
  /** The search could not be completed (too long a window, too many pages): the file may be there, a person must check. Never upload. */
  | { readonly kind: 'unknown' }
  /** Not now; `resume` says where to go on from. */
  | { readonly kind: 'retry'; readonly afterMs: number; readonly code: string; readonly resume?: SearchPosition };

/** The limits of a provider, as data. */
export interface ProviderLimits {
  /** Limits per IP, shared by every account of the provider. */
  readonly ip: {
    /** Between two uploads. */
    readonly upload: LimitRule;
    /** Between two status or lookup requests. */
    readonly status: LimitRule;
    /** Between two sign-ins (used by the adapter itself). */
    readonly auth: LimitRule;
  };
  /** Pacing and backoff of one account (its `maxPerHour` and `maxPerYear` come from the account). */
  readonly account: {
    /** Minimum time between two uploads of an account, for its hourly cap. */
    readonly minIntervalMs: (maxPerHour: number) => number;
    readonly jitterMs: number;
    /** Waits of the successive `account` retries; the last one repeats. At least one. */
    readonly backoffStepsMs: readonly number[];
  };
  /**
   * The longest one adapter call can take (waits and requests included). The worker sizes the round budget, the record
   * lease and the liveness window from it: a call must never outlast them.
   */
  readonly maxCallMs: number;
}

/** A provider adapter. */
export interface ProviderAdapter {
  /** The provider this adapter serves (`aruba`). */
  readonly provider: string;
  /** The transmitter written in `IdTrasmittente` unless the company has its own. */
  readonly transmitter: { readonly IdPaese: string; readonly IdCodice: string };
  readonly limits: ProviderLimits;
  /**
   * Sends a file. Network failures after the request left must be reported as `maybeSent`, not thrown.
   *
   * @param account The account to send through.
   * @param file The file and what identifies it.
   * @param signal Aborted when the lease is lost or the worker stops.
   */
  upload(account: Account, file: OutgoingFile, signal: AbortSignal): Promise<UploadOutcome>;
  /**
   * Asks for the state of an uploaded file.
   *
   * @param account The account it was sent through.
   * @param providerId The id the provider gave at upload.
   * @param signal Aborted when the lease is lost or the worker stops.
   */
  status(account: Account, providerId: string, signal: AbortSignal): Promise<StatusOutcome>;
  /**
   * Looks for a file that may have been sent before a crash or a timeout.
   *
   * @param account The account it may have been sent through.
   * @param ref What identifies the invoice.
   * @param signal Aborted when the lease is lost or the worker stops.
   */
  findSent(account: Account, ref: InvoiceRef, signal: AbortSignal): Promise<FindOutcome>;
  /** Drops what is cached for a hub (tokens): its account was disabled, removed or changed. */
  forget(hub: string): void;
}
