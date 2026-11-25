import type { ActivityEntry, ActivityLog } from '../shared/activity-log/activity-log.ts';
import { actorOf } from '../shared/activity-log/actor.ts';
import type { ActivityAction } from '../shared/activity-log/catalog.ts';
import type { ClientContext } from '../shared/http/client-context.ts';
import { AppError } from '../shared/http/errors.ts';
import { InvalidProviderDataError } from '../shared/integrations/errors.ts';
import type { PlaceIntegrationTarget } from '../shared/integrations/ports.ts';
import type { Logger } from '../shared/logging/logger.ts';
import { ProviderHttpError } from './http/index.ts';

/** The closed set of outcomes of a call to a provider from the settings of a place, as the activity log records them. */
export type CallOutcome =
  /** The provider answered and its answer was used. */
  | 'ok'
  /** The core refused the call (permission, role, version) or the provider refused the credential. */
  | 'rejected'
  /** The provider failed, rate limited the platform or answered in an unexpected form. */
  | 'providerError'
  /** The call did not finish in time. */
  | 'timeout'
  /** The platform has no configuration for the provider, or the place has no credential. */
  | 'notConfigured'
  /** The place has the provider switched off. */
  | 'disabled'
  /** The provider accepted the request but its result could not be stored (Satispay only: the activation code is consumed). */
  | 'saveFailed';

/** Thrown by a client for a credential that cannot be sent as it is (a character that does not belong in a header): the provider is not called, and the caller answers as if the provider had refused it. Carries nothing. */
export class CredentialFormatError extends Error {
  constructor() {
    super('The credential has a form that cannot be sent');
    this.name = 'CredentialFormatError';
  }
}

/** What a call of a service fills in while it works, for the entry of the activity log. */
export interface CallProbe {
  /** How many items came back, when the call lists something. */
  count?: number;
  /** Whether the call used the test environment of the provider. */
  testMode?: boolean;
  /** Set by the work itself when it knows better than the classification of the error (the key that could not be stored). */
  outcome?: CallOutcome;
}

/** What identifies the call: who, on which place, with which request. */
export interface CallRequest extends PlaceIntegrationTarget {
  /** The group, verified by the route. */
  readonly group: NonNullable<ActivityEntry['groupId']>;
  readonly context: ClientContext;
}

/** What a kind of call declares. */
export interface CallSpec {
  /** The action of the activity log. */
  readonly action: ActivityAction;
  /** `security` for the actions that spend something single use (the activation code of Satispay), `data` for the others. */
  readonly category: 'data' | 'security';
  /** Name of the provider, for the log of a failure. */
  readonly provider: string;
  /** The field a refused credential is reported on (`integrations.dojo.apiKey`, `integrations.tsh.secret`, `activationCode`), or `null` when the credential is the platform's own (a refusal is then the platform's problem: a `502`). */
  readonly credentialField: string | null;
  /** The statuses of the provider that mean the credential was refused, `401` and `403` when absent (Satispay also answers `404` for an activation code it does not know). */
  readonly refusedStatuses?: readonly number[];
}

/** Collaborators of {@link createProviderCalls}. */
export interface ProviderCallsDeps {
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Clock in epoch milliseconds, `Date.now` by default. */
  readonly now?: () => number;
}

/** Runs a call to a provider and records it. */
export interface ProviderCalls {
  /**
   * Runs `work`, then records it in the activity log with a closed outcome and answers its failures in the vocabulary of the API: a credential the provider refused (`401`, `403`) is a `422` on the field of the
   * credential, anything else that went wrong with the provider (unreachable, timeout, `429`, a server error, an answer that is not what was asked for, data the place refuses) is a `502 PROVIDER_ERROR` with
   * no detail and no `Retry-After`. The errors of the core ({@link AppError}, from the port or the configuration) pass through, recorded as `disabled`, `notConfigured` or `rejected`. Anything else is not
   * the business of the log and goes on as it is, unless `work` named an outcome for it. The entry never holds a credential, a code, a key, a token, a URL, an address or what the provider said.
   *
   * @param spec What kind of call it is.
   * @param request Who calls, on which place.
   * @param work The call: the work of the service, which may tell the entry how many items came back.
   * @returns What `work` returned.
   * @throws {AppError} `VALIDATION_ERROR` (credential refused), `PROVIDER_ERROR`, or what `work` threw.
   */
  run<T>(spec: CallSpec, request: CallRequest, work: (probe: CallProbe) => Promise<T>): Promise<T>;
}

/** The outcome an error of the core is recorded as. */
function outcomeOfAppError(error: AppError): CallOutcome {
  const detail = error.details?.[0];
  if (error.code === 'SERVICE_UNAVAILABLE' || (error.code === 'VALIDATION_ERROR' && detail?.issue === 'required')) {
    return 'notConfigured';
  }
  return error.code === 'VALIDATION_ERROR' && detail?.field.endsWith('.status') === true ? 'disabled' : 'rejected';
}

/** How a failure of a call is recorded and answered. */
interface Classified {
  readonly outcome: CallOutcome;
  /** The HTTP status of the provider, `null` when there was none. */
  readonly status: number | null;
  /** What the client gets. */
  readonly thrown: AppError;
}

/** The statuses of a provider that mean it refused the credential, unless the call declares its own. */
const DEFAULT_REFUSED_STATUSES: readonly number[] = Object.freeze([401, 403]);

/** The `422` of a credential the provider refused, or that cannot be sent at all. */
const refusedCredential = (field: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue: 'incorrect' }] });

/**
 * Decides how a failure is recorded and answered: the errors of the core pass through, a refused credential is a `422` on its field, anything else wrong with the provider is a `502`. A failure that is
 * none of these is `null`. The provider failures are logged here with who, what, why and the status; never the URL (a key may sit in its query), a header or a body: the error carries none of them.
 */
function classify(error: unknown, spec: CallSpec, context: { readonly logger: Logger; readonly elapsed: () => number }): Classified | null {
  if (error instanceof AppError) {
    return { outcome: outcomeOfAppError(error), status: null, thrown: error };
  }
  if (error instanceof CredentialFormatError) {
    return { outcome: 'rejected', status: null, thrown: refusedCredential(spec.credentialField as string) };
  }
  if (error instanceof ProviderHttpError) {
    context.logger.warn('provider call failed', { provider: error.provider, operation: error.operation, reason: error.reason, status: error.status, durationMs: context.elapsed() });
    if (error.reason === 'status' && (spec.refusedStatuses ?? DEFAULT_REFUSED_STATUSES).includes(error.status as number) && spec.credentialField !== null) {
      return { outcome: 'rejected', status: error.status, thrown: refusedCredential(spec.credentialField) };
    }
    return { outcome: error.reason === 'timeout' ? 'timeout' : 'providerError', status: error.status, thrown: new AppError('PROVIDER_ERROR') };
  }
  return error instanceof InvalidProviderDataError ? { outcome: 'providerError', status: null, thrown: new AppError('PROVIDER_ERROR') } : null;
}

/**
 * Builds the runner of the calls to the providers. It is the one place where the failures of the providers become the errors of the API and the entries of the activity log, so every provider answers
 * the same way and none can leak what the provider said.
 *
 * @param deps The activity log, the logger and the clock.
 * @returns The runner.
 */
export function createProviderCalls(deps: ProviderCallsDeps): ProviderCalls {
  const { activityLog, logger } = deps;
  const now = deps.now ?? Date.now;
  return {
    run: async (spec, request, work) => {
      const started = now();
      const probe: CallProbe = {};
      const record = async (outcome: CallOutcome, status: number | null): Promise<void> => {
        await activityLog.record({
          category: spec.category,
          action: spec.action,
          outcome: outcome === 'ok' ? 'success' : ['rejected', 'disabled', 'notConfigured'].includes(outcome) ? 'denied' : 'failure',
          actor: actorOf(request.principal),
          groupId: request.group,
          resource: { type: 'place', id: request.placeId },
          requestId: request.context.requestId,
          ...(request.context.ip === null ? {} : { ip: request.context.ip }),
          metadata: { outcome, providerStatus: status, durationMs: now() - started, ...(probe.count === undefined ? {} : { count: probe.count }), ...(probe.testMode === undefined ? {} : { testMode: probe.testMode }) },
        });
      };
      let result: Awaited<ReturnType<typeof work>>;
      try {
        result = await work(probe);
      } catch (error) {
        const failure = classify(error, spec, { logger, elapsed: () => now() - started });
        const outcome = probe.outcome ?? failure?.outcome;
        if (outcome === undefined) {
          // Not a failure of the provider nor of the core (a database error, a bug): not for the log of the integrations.
          throw error;
        }
        await record(outcome, failure?.status ?? null);
        throw failure?.thrown ?? error;
      }
      await record('ok', null);
      return result;
    },
  };
}
