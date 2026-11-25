import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { InvalidProviderDataError } from '../../shared/integrations/errors.ts';
import type { PlaceIntegrationTarget, PlaceIntegrationsPort, TshCategory } from '../../shared/integrations/ports.ts';
import type { CompaniesPlacesWriter } from '../../shared/legacy-write/companies-places.writer.ts';
import { MalformedDocumentError } from '../../shared/legacy-write/errors.ts';
import { SETTING_FIELDS, TSH_PROPERTY_ID, UNSETTABLE_PATHS } from '../../shared/legacy-write/place-settings.ts';
import type { SettingKind } from '../../shared/legacy-write/place-settings.ts';
import { hasPermission } from '../../shared/security/rbac/policy.ts';
import { groupAccessFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { INVALID } from '../../shared/validation/schema.ts';
import { valueAt } from '../companies/company.mapper.ts';
import { tshCategoriesSchema } from './place-settings.schemas.ts';
import { isPrivileged } from './places.service.ts';

/** Collaborators of {@link createPlaceIntegrationsPort}. */
export interface PlaceIntegrationsPortDeps {
  /** The group lookup, to verify the group of the target against the perimeter of the principal again. */
  readonly groups: Pick<GroupsRepository, 'findAccess' | 'resolveCluster'>;
  /** Opens the write service for a group the caller was verified to reach (the one the place service uses). */
  readonly writerFor: (principal: AuthPrincipal, access: GroupAccess) => CompaniesPlacesWriter;
  readonly activityLog: ActivityLog;
}

/** How many times a write that finds the place changed under it is tried again (the provider has already answered, so the result is not to be lost). */
const WRITE_ATTEMPTS = 3;

/** The form of the key id of Satispay: the one of the field (`satispay.keyId`), so what is written here is what a request could have written. */
const KEY_ID_FORM = SETTING_FIELDS.find((field) => field.domain === 'integrations.satispay.keyId')!.kind as Extract<SettingKind, { t: 'secret' }>;

const isKeyId = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= KEY_ID_FORM.max && (KEY_ID_FORM.pattern as RegExp).test(value);

/** The text a credential holds, `null` when it has none (a missing key, `null`, an empty or a mistyped value). */
const textAt = (document: Document, path: string): string | null => {
  const value = valueAt(document, path);
  return typeof value === 'string' && value !== '' ? value : null;
};

const invalid = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue } satisfies ErrorDetail] });

/**
 * Builds the place port of the integrations module (`doc/Tasks.md` section 9-octies.3): what a call to a provider needs from the place and what it writes back, behind the checks of the core.
 * It reads and writes only through the write service of the places (so the version, the copy in the common database and `groups.places[]` are the ones of every other write), never calls a
 * provider, and returns only the minimum value of each method.
 *
 * @param deps The group lookup, the write service opener and the activity log.
 * @returns The port.
 */
export function createPlaceIntegrationsPort(deps: PlaceIntegrationsPortDeps): PlaceIntegrationsPort {
  const { groups, writerFor, activityLog } = deps;

  /**
   * The checks every method starts with, in order: the group (`404`), the permission (`403`) and the place, outside the perimeter or in the trash (`404`). The write service applies the
   * perimeter of the principal to the read, so a place of another company or group is a place that does not exist.
   */
  const open = async (target: PlaceIntegrationTarget) => {
    const { principal } = target;
    const access = await groupAccessFor(groups, principal, target.groupId);
    if (access === null) {
      throw new AppError('NOT_FOUND');
    }
    if (!hasPermission(principal, 'places:update')) {
      throw new AppError('FORBIDDEN');
    }
    // An id that is not a valid ObjectId is a place that does not exist.
    const placeId = /^[0-9a-f]{24}$/.test(target.placeId) ? ObjectId.createFromHexString(target.placeId) : null;
    const writer = writerFor(principal, access);
    const found = placeId === null ? null : await writer.read('places', placeId);
    if (placeId === null || found === null || found.document['trash'] === true) {
      throw new AppError('NOT_FOUND');
    }
    return { principal, access, writer, placeId, document: found.document, version: found.version };
  };

  /** The role rule of the payment keys: only a PSA or a dealer activates Satispay (the same `notAllowed` as a write of the key). */
  const assertPaymentRole = (principal: AuthPrincipal): void => {
    if (!isPrivileged(principal)) {
      throw new AppError('FORBIDDEN', { details: [{ field: 'integrations.satispay.keyId', issue: 'notAllowed' }] });
    }
  };

  /** The switch of a provider must be on (`422` on the field of the switch otherwise). */
  const assertOn = (document: Document, provider: string): void => {
    if (valueAt(document, `integrations.${provider}.status`) !== true) {
      throw invalid(`integrations.${provider}.status`, 'incorrect');
    }
  };

  /** The credentials of a provider: each must be there (`422` `required` on the field of the first missing one), returned as stored. */
  const credentials = <Key extends string>(document: Document, provider: string, keys: readonly Key[]): Record<Key, string> => {
    const found = {} as Record<Key, string>;
    for (const key of keys) {
      const value = textAt(document, `integrations.${provider}.${key}`);
      if (value === null) {
        throw invalid(`integrations.${provider}.${key}`, 'required');
      }
      found[key] = value;
    }
    return found;
  };

  const assertVersion = (version: string, expected: string): void => {
    if (version !== expected) {
      throw new AppError('PRECONDITION_FAILED');
    }
  };

  /** A write that did not happen because the stored place cannot hold it (a block that is not an object) is a `409`; any other failure goes on to the central handler. */
  const attempt = async <Result>(write: () => Promise<Result>): Promise<Result> => {
    try {
      return await write();
    } catch (error) {
      throw error instanceof MalformedDocumentError ? new AppError('CONFLICT', { message: 'The stored place has a block that cannot be written' }) : error;
    }
  };

  /** The entry of the activity log of a write of the integrations: the block that changed, by name, never a value (the specific events of the providers are the module's). */
  const logWrite = (principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId): Promise<void> =>
    activityLog.record({
      category: 'data',
      action: 'place.updated',
      outcome: 'success',
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'place', id: placeId.toHexString() },
      changes: [{ field: 'integrations', redacted: true as const }],
    });

  return {
    dojoCredentials: async (target) => {
      const { document } = await open(target);
      assertOn(document, 'dojo');
      return credentials(document, 'dojo', ['apiKey']);
    },

    tshCredentials: async (target) => {
      const { document } = await open(target);
      assertOn(document, 'tsh');
      const { id, secret, propertyId } = credentials(document, 'tsh', ['id', 'secret', 'propertyId']);
      // The id of the property goes into the path of the calls to the provider: whatever is stored is checked again here.
      if (!TSH_PROPERTY_ID.test(propertyId)) {
        throw invalid('integrations.tsh.propertyId', 'pattern');
      }
      return { id, secret, propertyId, testMode: valueAt(document, 'integrations.tsh.testMode') === true };
    },

    checkSatispayActivation: async (target, ifMatch) => {
      const { principal, document, version } = await open(target);
      assertPaymentRole(principal);
      assertOn(document, 'satispay');
      assertVersion(version, ifMatch);
    },

    saveSatispayKeyId: async (target, ifMatch, keyId) => {
      if (!isKeyId(keyId)) {
        throw new InvalidProviderDataError('satispayKeyId');
      }
      // The provider has accepted the code: from here the key is written whatever the place has become (a switch turned off, a concurrent edit), and only the checks that protect the place stay.
      for (let attempts = 0; attempts < WRITE_ATTEMPTS; attempts += 1) {
        const { principal, access, writer, placeId, version } = await open(target);
        assertPaymentRole(principal);
        const outcome = await attempt(() => writer.updatePlace(placeId, version, { 'integrations.satispay.keyId': keyId }, UNSETTABLE_PATHS));
        if (outcome.outcome === 'written') {
          await logWrite(principal, access, placeId);
          // The version is handed out only if it is the one the caller read, so the answer never names a state the caller did not see.
          return { etag: version === ifMatch ? outcome.version : null };
        }
        if (outcome.outcome === 'notFound') {
          throw new AppError('NOT_FOUND');
        }
      }
      throw new AppError('CONFLICT');
    },

    saveTshCategories: async (target, ifMatch, categories: readonly TshCategory[]) => {
      const { principal, access, writer, placeId, document, version } = await open(target);
      assertOn(document, 'tsh');
      assertVersion(version, ifMatch);
      const parsed = tshCategoriesSchema.parse(categories, '', { report: () => INVALID }, 1);
      if (parsed === INVALID) {
        throw new InvalidProviderDataError('tshCategories');
      }
      const outcome = await attempt(() => writer.updatePlace(placeId, ifMatch, { 'integrations.tsh.tshCategories': parsed }));
      if (outcome.outcome === 'notFound') {
        throw new AppError('NOT_FOUND');
      }
      if (outcome.outcome !== 'written') {
        throw new AppError('PRECONDITION_FAILED');
      }
      await logWrite(principal, access, placeId);
      return { etag: outcome.version };
    },

    checkGeocoding: async (target) => {
      const { document } = await open(target);
      assertOn(document, 'googleMaps');
    },
  };
}
