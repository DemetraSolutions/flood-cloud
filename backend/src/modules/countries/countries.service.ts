import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { CountryUsage } from '../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { CountryReference } from '../reference/reference.mapper.ts';
import { countryVersionOf, toCountry } from './countries.mapper.ts';
import type { CountriesRepository } from './countries.repository.ts';
import type { CreateCodedBody, RenameBody } from './countries.schemas.ts';

/** A country with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface CountryResult {
  readonly country: CountryReference;
  readonly version: string;
}

/** An area of a country: where it is, and what a write of it needs to log. */
interface AreaTarget {
  readonly country: Document;
  /** The area as stored: its name is whatever the document holds, `undefined` when it has none. */
  readonly stored: Document;
  /** The name of the area as the API shows it. */
  readonly name: string;
}

/** The countries of the platform and their areas (provinces): reading one with its version, and the writes of the PSA (`doc/Tasks.md` 9-ter). */
export interface CountriesService {
  /**
   * One country with its areas and its version.
   *
   * @param code The country code, two uppercase letters.
   * @throws {AppError} `NOT_FOUND`.
   */
  get(code: string): Promise<CountryResult>;
  /**
   * Creates a country in the legacy shape (`areas: []`, `insertDate`, `updateDate: null`) and records `country.created`.
   *
   * @param principal The authenticated caller.
   * @param body Validated body: the code (normalized) and the name.
   * @param client Request context, for the activity log.
   * @throws {AppError} `CONFLICT` with a `code` / `taken` detail when a country has that code.
   */
  create(principal: AuthPrincipal, body: CreateCodedBody, client: ClientContext): Promise<CountryResult>;
  /**
   * Changes the name of a country and records `country.updated`. A request that changes nothing writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED` when the country is not at the version the client read.
   */
  rename(principal: AuthPrincipal, code: string, expected: string, body: RenameBody, client: ClientContext): Promise<CountryResult>;
  /**
   * Deletes a country and records `country.deleted`.
   *
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED` (also when the country changed between the read and the delete); `CONFLICT` with `inUse` details when a company or a place (trashed ones included) has the country; `SERVICE_UNAVAILABLE` when the check of the use times out (nothing is deleted).
   */
  remove(principal: AuthPrincipal, code: string, expected: string, client: ClientContext): Promise<void>;
  /**
   * Adds an area to a country and records `countryArea.created`. The add is one atomic update of the list (never a rewrite of it).
   *
   * @throws {AppError} `NOT_FOUND`; `PRECONDITION_FAILED`; `CONFLICT` with a `code` / `taken` detail when the country has an area with that code.
   */
  addArea(principal: AuthPrincipal, code: string, expected: string, body: CreateCodedBody, client: ClientContext): Promise<CountryResult>;
  /**
   * Changes the name of an area and records `countryArea.updated`. A request that changes nothing writes and records nothing.
   *
   * @throws {AppError} `NOT_FOUND` (the country or the area); `PRECONDITION_FAILED`.
   */
  renameArea(principal: AuthPrincipal, code: string, areaCode: string, expected: string, body: RenameBody, client: ClientContext): Promise<CountryResult>;
  /**
   * Removes an area from a country and records `countryArea.deleted`.
   *
   * @throws {AppError} `NOT_FOUND` (the country or the area); `PRECONDITION_FAILED`; `CONFLICT` with `inUse` details when a company or a place has the country and the area.
   */
  removeArea(principal: AuthPrincipal, code: string, areaCode: string, expected: string, client: ClientContext): Promise<CountryResult>;
}

/** Collaborators of {@link createCountriesService}. */
export interface CountriesServiceDeps {
  readonly repository: CountriesRepository;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new countries. */
  readonly newId?: () => ObjectId;
}

/** The `409` of a deletion refused: one `inUse` detail per company or place listed (`companies.<id>`, `places.<id>`, at most the listed ones of each kind). */
function inUseError(usage: CountryUsage): AppError {
  const details: ErrorDetail[] = [
    ...usage.companies.ids.map((id) => ({ field: `companies.${id.toHexString()}`, issue: 'inUse' })),
    ...usage.places.ids.map((id) => ({ field: `places.${id.toHexString()}`, issue: 'inUse' })),
  ];
  return new AppError('CONFLICT', { details });
}

/**
 * Builds the service of the countries. Whoever calls it has the `countries:manage` permission (the route says so): the service does no role check of its own.
 *
 * @param deps Repository, activity log, version key, clock and id generator.
 */
export function createCountriesService(deps: CountriesServiceDeps): CountriesService {
  const { repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const resultOf = (document: Document): CountryResult => ({ country: toCountry(document), version: countryVersionOf(document, versionKey) });
  const read = async (code: string): Promise<CountryResult> => {
    const found = await repository.findByCode(code);
    if (found === null) {
      throw new AppError('NOT_FOUND');
    }
    return resultOf(found);
  };

  /** The country at the version the client read. */
  const current = async (code: string, expected: string): Promise<Document> => {
    const found = await repository.findByCode(code);
    if (found === null) {
      throw new AppError('NOT_FOUND');
    }
    if (countryVersionOf(found, versionKey) !== expected) {
      throw new AppError('PRECONDITION_FAILED');
    }
    return found;
  };
  /** The area of a country at the version the client read; a legacy code in another case is the same area. */
  const currentArea = async (code: string, areaCode: string, expected: string): Promise<AreaTarget> => {
    const country = await current(code, expected);
    const sameArea = (candidate: { readonly code: string }): boolean => candidate.code.toUpperCase() === areaCode;
    const area = toCountry(country).areas.find(sameArea);
    if (area === undefined) {
      throw new AppError('NOT_FOUND');
    }
    // The same area, as the document holds it (the list is one: `toCountry` found the area in it), so the guard of the write is made of the stored values and not of the fallbacks of the API.
    const stored = (country['areas'] as Document[]).find((candidate) => typeof candidate['code'] === 'string' && sameArea({ code: candidate['code'] }))!;
    return { country, stored, name: area.name };
  };
  /** What a write that found nothing to change means: the country is still there (`412`, it changed since it was read) or it is gone (`404`). */
  const lost = async (code: string): Promise<AppError> => new AppError((await repository.findByCode(code)) === null ? 'NOT_FOUND' : 'PRECONDITION_FAILED');
  const record = (principal: AuthPrincipal, client: ClientContext, action: DataAction, resource: { type: string; id: string }, metadata: Record<string, string>, before?: Record<string, string>, after?: Record<string, string>) =>
    recordDataChange(activityLog, {
      actor: actorOf(principal),
      resource,
      action,
      before,
      after,
      metadata,
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });
  const now = () => new Date(deps.now());

  return {
    get: read,

    create: async (principal, body, client) => {
      const document: Document = { _id: newId(), code: body.code, name: body.name, areas: [], insertDate: now(), updateDate: null };
      if ((await repository.insert(document)) === 'taken') {
        throw new AppError('CONFLICT', { details: [{ field: 'code', issue: 'taken' }] });
      }
      await record(principal, client, 'country.created', { type: 'country', id: body.code }, { countryCode: body.code }, undefined, { code: body.code, name: body.name });
      return resultOf(document);
    },

    rename: async (principal, code, expected, body, client) => {
      const found = await current(code, expected);
      const before = toCountry(found).name;
      if (body.name === before) {
        return resultOf(found);
      }
      if (!(await repository.setName(found['_id'] as ObjectId, found['name'], body.name, now()))) {
        throw await lost(code);
      }
      await record(principal, client, 'country.updated', { type: 'country', id: code }, { countryCode: code }, { name: before }, { name: body.name });
      return read(code);
    },

    remove: async (principal, code, expected, client) => {
      const found = await current(code, expected);
      const usage = await repository.usageOf(code, null);
      if (usage.companies.ids.length > 0 || usage.places.ids.length > 0) {
        throw inUseError(usage);
      }
      if (!(await repository.remove(found['_id'] as ObjectId, { code: found['code'], name: found['name'], areas: found['areas'] }))) {
        throw await lost(code);
      }
      await record(principal, client, 'country.deleted', { type: 'country', id: code }, { countryCode: code }, { code, name: toCountry(found).name }, undefined);
    },

    addArea: async (principal, code, expected, body, client) => {
      const found = await current(code, expected);
      const outcome = await repository.addArea(found['_id'] as ObjectId, { code: body.code, name: body.name }, now());
      if (outcome === 'missing') {
        throw new AppError('NOT_FOUND');
      }
      if (outcome === 'taken') {
        throw new AppError('CONFLICT', { details: [{ field: 'code', issue: 'taken' }] });
      }
      await record(principal, client, 'countryArea.created', { type: 'countryArea', id: `${code}-${body.code}` }, { countryCode: code, areaCode: body.code }, undefined, { code: body.code, name: body.name });
      return read(code);
    },

    renameArea: async (principal, code, areaCode, expected, body, client) => {
      const target = await currentArea(code, areaCode, expected);
      if (body.name === target.name) {
        return resultOf(target.country);
      }
      if (!(await repository.setAreaName(target.country['_id'] as ObjectId, areaCode, target.stored['name'], body.name, now()))) {
        throw await lost(code);
      }
      await record(principal, client, 'countryArea.updated', { type: 'countryArea', id: `${code}-${areaCode}` }, { countryCode: code, areaCode }, { name: target.name }, { name: body.name });
      return read(code);
    },

    removeArea: async (principal, code, areaCode, expected, client) => {
      const target = await currentArea(code, areaCode, expected);
      const usage = await repository.usageOf(code, areaCode);
      if (usage.companies.ids.length > 0 || usage.places.ids.length > 0) {
        throw inUseError(usage);
      }
      if (!(await repository.removeArea(target.country['_id'] as ObjectId, areaCode, target.stored['name'], now()))) {
        throw await lost(code);
      }
      await record(principal, client, 'countryArea.deleted', { type: 'countryArea', id: `${code}-${areaCode}` }, { countryCode: code, areaCode }, { code: areaCode, name: target.name }, undefined);
      return read(code);
    },
  };
}
