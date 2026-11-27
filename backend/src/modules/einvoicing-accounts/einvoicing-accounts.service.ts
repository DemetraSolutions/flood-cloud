import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { dealerArubaPasswordContext, encryptCredential, PLATFORM_ARUBA_PASSWORD_CONTEXT } from '../../shared/security/credential-cipher.ts';
import type { CredentialRecipient } from '../../shared/security/credential-cipher.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { arubaAccountOf, versionOf, viewOf } from './aruba-account.ts';
import type { AccountTarget, ArubaAccount, ArubaAccountView } from './aruba-account.ts';
import type { EInvoicingAccountsRepository } from './einvoicing-accounts.repository.ts';
import type { ArubaAccountBody } from './einvoicing-accounts.schemas.ts';

/** An account as the API shows it, with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface AccountResult {
  readonly view: ArubaAccountView;
  readonly version: string;
}

/** The Aruba accounts of the e-invoicing: the dealers' own and the platform's. */
export interface EInvoicingAccountsService {
  /**
   * Reads an account, or says that there is none.
   *
   * @param target The account.
   * @throws {AppError} `NOT_FOUND` for a dealer that does not exist.
   */
  get(target: AccountTarget): Promise<AccountResult>;
  /**
   * Creates or changes an account. The password is encrypted here and never leaves the server again; without one the stored ciphertext is kept. Records `dealer.eInvoicingAccountSaved` or `platform.eInvoicingAccountSaved` with the names of the changed fields.
   *
   * @param principal The authenticated administrator (the route requires `eInvoicingAccounts:manage`).
   * @param target The account.
   * @param expected The version the client read.
   * @param body The validated account.
   * @param client Request context.
   * @throws {AppError} `SERVICE_UNAVAILABLE` without the public key, `NOT_FOUND` (dealer), `PRECONDITION_FAILED` (stale version), `VALIDATION_ERROR` (`password` required for a new account), `CONFLICT` (`username` taken by another account).
   */
  save(principal: AuthPrincipal, target: AccountTarget, expected: string, body: ArubaAccountBody, client: ClientContext): Promise<AccountResult>;
  /**
   * Removes an account. Records `dealer.eInvoicingAccountRemoved` or `platform.eInvoicingAccountRemoved`.
   *
   * @param principal The authenticated administrator.
   * @param target The account.
   * @param expected The version the client read.
   * @param client Request context.
   * @throws {AppError} `NOT_FOUND` (no such dealer, or nothing stored), `PRECONDITION_FAILED` (stale version).
   */
  remove(principal: AuthPrincipal, target: AccountTarget, expected: string, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createEInvoicingAccountsService}. */
export interface EInvoicingAccountsServiceDeps {
  readonly repository: EInvoicingAccountsRepository;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** The public key the passwords are encrypted for; `null` when it is not configured (saving then answers `503`). */
  readonly credentialsRecipient: CredentialRecipient | null;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/** The fields of an account an event may name, in the order they are listed. */
const TRACKED = ['enabled', 'username', 'maxPerHour', 'maxPerYear'] as const;

/**
 * Builds the service of the Aruba accounts.
 *
 * @param deps Repository, activity log, keys and clock.
 */
export function createEInvoicingAccountsService(deps: EInvoicingAccountsServiceDeps): EInvoicingAccountsService {
  const { repository, activityLog, versionKey } = deps;
  const resultOf = (target: AccountTarget, account: ArubaAccount | null): AccountResult => ({ view: viewOf(target, account), version: versionOf(target, account, versionKey) });
  const readOrThrow = async (target: AccountTarget) => {
    const read = await repository.read(target);
    if (read === null) {
      throw new AppError('NOT_FOUND');
    }
    return read;
  };
  const record = (principal: AuthPrincipal, client: ClientContext, target: AccountTarget, kind: 'Saved' | 'Removed', metadata: Readonly<Record<string, string | boolean>>): Promise<void> =>
    activityLog.record({
      category: 'data',
      action: `${target.kind}.eInvoicingAccount${kind}`,
      outcome: 'success',
      actor: actorOf(principal),
      resource: target.kind === 'dealer' ? { type: 'dealer', id: target.dealerId.toHexString() } : { type: 'integrations', id: 'INTEGRATIONS' },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    });

  return {
    get: async (target) => resultOf(target, arubaAccountOf((await readOrThrow(target)).raw)),

    save: async (principal, target, expected, body, client) => {
      if (deps.credentialsRecipient === null) {
        throw new AppError('SERVICE_UNAVAILABLE');
      }
      const read = await readOrThrow(target);
      const before = arubaAccountOf(read.raw);
      if (versionOf(target, before, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      if (before === null && body.password === undefined) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'password', issue: 'required' }] });
      }
      if (before?.username !== body.username && (await repository.isUsernameTaken(body.username, target))) {
        throw new AppError('CONFLICT', { details: [{ field: 'username', issue: 'taken' }] });
      }
      const changed = TRACKED.filter((field) => before === null || before[field] !== body[field]);
      if (changed.length === 0 && body.password === undefined) {
        return resultOf(target, before);
      }
      const context = target.kind === 'dealer' ? dealerArubaPasswordContext(target.dealerId.toHexString()) : PLATFORM_ARUBA_PASSWORD_CONTEXT;
      const next: ArubaAccount = {
        enabled: body.enabled,
        username: body.username,
        // Either a new password or, since the first one is mandatory, the stored ciphertext.
        password: body.password === undefined ? before!.password : encryptCredential(deps.credentialsRecipient, body.password, context),
        maxPerHour: body.maxPerHour,
        maxPerYear: body.maxPerYear,
        updatedAt: new Date(deps.now()),
        updatedBy: principal.userId,
      };
      if (!(await repository.replace(target, read, next))) {
        throw new AppError('PRECONDITION_FAILED');
      }
      await record(principal, client, target, 'Saved', { fields: changed.join(','), passwordChanged: body.password !== undefined });
      return resultOf(target, next);
    },

    remove: async (principal, target, expected, client) => {
      const read = await readOrThrow(target);
      const before = arubaAccountOf(read.raw);
      // A stored value that is damaged (the API shows it as "not configured") can still be removed; only its absence is a 404.
      if (read.raw === undefined) {
        throw new AppError('NOT_FOUND');
      }
      if (versionOf(target, before, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      if (!(await repository.remove(target, read, principal.userId, new Date(deps.now())))) {
        throw new AppError('PRECONDITION_FAILED');
      }
      await record(principal, client, target, 'Removed', {});
    },
  };
}
