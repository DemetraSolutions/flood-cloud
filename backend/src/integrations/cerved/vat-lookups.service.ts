import type { CervedClient } from './cerved-client.ts';
import { CervedError } from './cerved-error.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { isValidItalianVatDigits, normalizeVatNumber } from '../../shared/legacy-write/vat.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { toVatLookupResult } from './vat-lookups.mapper.ts';
import type { VatLookupResult } from './vat-lookups.mapper.ts';

/** The lookup of a company by its Italian VAT number on Cerved. */
export interface VatLookupsService {
  /**
   * Looks a company up. The VAT number is normalized (trimmed, the optional `IT` prefix dropped) and checked (eleven digits and the check digit) before anything is asked
   * to the provider. The subject must have **exactly** that VAT number. The PEC comes from a second call: when it fails the answer is the same, without the PEC.
   * Every lookup that reaches the provider, or would have (no key), leaves an entry in the activity log; nothing of the provider's answer is ever logged.
   *
   * @param principal The authenticated caller (the route requires `groups:create`).
   * @param vatNumber The VAT number as typed in the URL.
   * @param client Request context, for the activity log.
   * @throws {AppError} `VALIDATION_ERROR` (`vatNumber`: `format` or `checksum`), `NOT_FOUND` (no subject with that VAT number), `SERVICE_UNAVAILABLE` (no key, or the provider failed: no detail).
   */
  lookup(principal: AuthPrincipal, vatNumber: string, client: ClientContext): Promise<VatLookupResult>;
}

/** Dependencies of {@link createVatLookupsService}. */
export interface VatLookupsDeps {
  readonly cerved: CervedClient;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
}

/** The `VALIDATION_ERROR` of the lookup. */
const invalid = (issue: 'format' | 'checksum'): AppError => new AppError('VALIDATION_ERROR', { details: [{ field: 'vatNumber', issue }] });

/**
 * Builds the lookup service.
 *
 * @param deps The Cerved client, the activity log and the logger.
 */
export function createVatLookupsService(deps: VatLookupsDeps): VatLookupsService {
  const { cerved, activityLog, logger } = deps;
  return {
    lookup: async (principal, requested, client) => {
      const vatNumber = normalizeVatNumber(requested.trim());
      if (!/^\d{11}$/.test(vatNumber)) {
        throw invalid('format');
      }
      if (!isValidItalianVatDigits(vatNumber)) {
        throw invalid('checksum');
      }
      /** The log of the lookup: the VAT number is business data of a company, so it goes to the activity log (seen by the PSA) and nowhere else. */
      const record = (outcome: 'found' | 'notFound' | 'unavailable'): Promise<void> =>
        activityLog.record({
          category: 'data',
          action: 'vatLookup.performed',
          outcome: outcome === 'unavailable' ? 'failure' : 'success',
          actor: actorOf(principal),
          resource: { type: 'vatLookup', id: vatNumber },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: { outcome },
        });
      const unavailable = async (): Promise<never> => {
        await record('unavailable');
        throw new AppError('SERVICE_UNAVAILABLE');
      };
      if (!cerved.available) {
        return unavailable();
      }
      let company;
      try {
        company = await cerved.findCompanyByVat(vatNumber);
      } catch (error) {
        return error instanceof CervedError ? unavailable() : Promise.reject(error as Error);
      }
      if (company === null) {
        await record('notFound');
        throw new AppError('NOT_FOUND');
      }
      let pec: string | null = null;
      if (company.subjectId !== null) {
        try {
          pec = await cerved.findPec(company.subjectId);
        } catch (error) {
          if (!(error instanceof CervedError)) {
            throw error;
          }
          // The PEC is a courtesy: the answer is the same without it. Only what failed is logged, never an address, a VAT number or a key.
          logger.warn('cerved profile lookup failed', { errorName: error.name, reason: error.reason });
        }
      }
      await record('found');
      return toVatLookupResult(company, pec);
    },
  };
}
