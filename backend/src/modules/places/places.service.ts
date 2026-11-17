import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorCode, ErrorDetail } from '../../shared/http/errors.ts';
import { canonicalJson } from '../../shared/http/etag.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { CompaniesPlacesWriter, CompanyOfPlace, WriteOutcome } from '../../shared/legacy-write/companies-places.writer.ts';
import { MalformedDocumentError } from '../../shared/legacy-write/errors.ts';
import type { NewPlaceFields } from '../../shared/legacy-write/fields.ts';
import { WEEK_DAYS } from '../../shared/legacy-write/place-paths.ts';
import { SETTING_FIELDS } from '../../shared/legacy-write/place-settings.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal, ScopeHolder } from '../../shared/security/scope/principal.ts';
import { companyInScope } from '../../shared/security/scope/scope-filters.ts';
import { settleItem } from '../../shared/trash/trash.ts';
import type { TrashItemOutcome, VersionCheck } from '../../shared/trash/trash.ts';
import { addressProblem } from '../companies/address.ts';
import { leafWrites, setValueAt, valueAt } from '../companies/company.mapper.ts';
import { isValidCalendarDate } from '../companies/validators.ts';
import type { GroupLists } from '../companies/companies.repository.ts';
import { parseIds } from '../group-lookup/lookup.schemas.ts';
import type { ReferencesRepository } from '../groups/catalogs/references.repository.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { MediaService } from '../media/media.service.ts';
import type { StoreKeysService } from '../store-keys/store-keys.service.ts';
import { applyListRules } from './place-lists.rules.ts';
import { applySettingsRules } from './place-settings.rules.ts';
import { PLACE_LEAVES, toPlace, toPlaceSummary } from './place.mapper.ts';
import type { Place, PlaceCreation, PlacePatch, PlacePriceList, PlaceSummary } from './place.types.ts';
import { PLACES_LIST } from './places.list.ts';
import type { PlacesRepository } from './places.repository.ts';
import { PLANS } from './places.schemas.ts';
import type { PlacesQuery } from './places.schemas.ts';

/** A place with the version of its stored document: the `ETag` of the response and the `If-Match` of the next write. */
export interface PlaceResult {
  readonly place: Place;
  readonly version: string;
}

/** A page of the list of the places. */
export interface PlacesListing {
  readonly items: readonly PlaceSummary[];
  readonly page: PageInfo;
}

/** The management of the places of a group (`doc/Tasks.md` area 7, step 7A): the list, the detail, the creation, the modification of the general data, the license and the hours, the trash, the deletion and the duplication. */
export interface PlacesService {
  /**
   * Lists the places of a verified group inside the caller's perimeter (a company administrator the places of his companies, a place administrator his own), from the copies in the
   * common database: the untrashed ones by default, filtered and sorted before the page is cut.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: PlacesQuery): Promise<PlacesListing>;
  /**
   * Reads one place from the document of the group database (so the version is the one `If-Match` expects). A place that does not exist, is of another group or is outside the
   * perimeter of the caller is one and the same `404`. The caller may also be the server of the place itself (a store key: its perimeter is its own place).
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: ScopeHolder, access: GroupAccess, placeId: ObjectId): Promise<PlaceResult>;
  /**
   * The invoice series (`name`, `cash`) of the company the place has now, for whoever may save the place: scoped like the place (a place outside the perimeter is `404`), and read through
   * the write service, so a place administrator, who has no `companies:read`, still picks the series. `[]` when the company is missing.
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  invoiceSeries(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId): Promise<readonly { readonly name: string; readonly cash: boolean }[]>;
  /**
   * Creates a place with the complete structure the old backoffice saves. The plan may be chosen by a PSA or a dealer (a group administrator gets `basic`), the end of the license and the
   * state by a PSA or a dealer, the Sentry switch by a PSA only; sending the default of a field is not a change.
   *
   * @throws {AppError} `FORBIDDEN` (with `notAllowed` details), `VALIDATION_ERROR` (company, country, province, price lists, invoice series, plan, time zone, hours).
   */
  create(principal: AuthPrincipal, access: GroupAccess, body: PlaceCreation, client: ClientContext): Promise<PlaceResult>;
  /**
   * Modifies a place: any subset of the general fields and of the blocks, written key by key. Only the keys whose value differs from the stored one are written; a request that
   * changes nothing writes nothing and answers with the place as it is. `plan` and `sentry` can be changed only by a PSA, `expirationDate` and `status` only by a PSA or a dealer; the
   * other fields may resend the value the place has.
   *
   * @param expected The version the caller read (`If-Match`).
   * @throws {AppError} `VALIDATION_ERROR` (empty body, a rule on a field), `NOT_FOUND`, `PRECONDITION_FAILED`, `FORBIDDEN` (`notAllowed`), `CONFLICT` (a block of the stored place that is not an object).
   */
  update(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, expected: string, patch: PlacePatch, client: ClientContext): Promise<PlaceResult>;
  /**
   * Moves a place to the trash (it also leaves the Reserve with Google feed). The legacy nulling of the address is not replicated.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` when it is already there.
   */
  trash(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, expected: string, client: ClientContext): Promise<PlaceResult>;
  /**
   * Takes a place out of the trash.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` when it is not there.
   */
  restore(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, expected: string, client: ClientContext): Promise<PlaceResult>;
  /**
   * Deletes a place that is in the trash, for good.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` when it is not in the trash, or when a user of the group still has it in his scope (`users` `referenced`).
   */
  remove(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, expected: string, client: ClientContext): Promise<void>;
  /**
   * Takes a place out of the trash for a bulk operation: exactly {@link PlacesService.restore}, with the version read just now instead of an `If-Match` (the write still checks it
   * inside its transaction, so a place changed in between is skipped). A refusal is returned as the issue, never thrown.
   *
   * @returns `{ done: true }`, or the issue: `notFound` or `notTrashed`.
   */
  restoreFromTrash(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /**
   * Deletes a place that is in the trash for a bulk operation: exactly {@link PlacesService.remove}, with the version read just now. A refusal is returned as the issue.
   *
   * @returns `{ done: true }`, or the issue: `notFound`, `notTrashed` or `referenced` (a user of the group still has the place in his scope).
   */
  deleteFromTrash(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /**
   * The ids of the places in the trash that the caller reaches, in `_id` order, at most `limit`.
   *
   * @param limit Most ids returned.
   * @param after Only the ids greater than this one, `null` for the first call.
   */
  trashedIds(principal: AuthPrincipal, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /** How many places in the trash the caller reaches. */
  countTrashed(principal: AuthPrincipal, access: GroupAccess): Promise<number>;
  /**
   * Duplicates a place, a PSA or a dealer only: everything is replicated (every key, the devices, the rooms, the storages with the same ids, the integrations with their credentials, which
   * are copied on the server and never returned), with a new id, new dates, `trash: false` and the name `<name> (Copy)`. The key of the store of step 7C is not copied: it is created again.
   *
   * @throws {AppError} `FORBIDDEN` for any other role, `NOT_FOUND`, `CONFLICT` when the place is in the trash or its company does not exist or is in the trash (`companyId` `incorrect`).
   */
  duplicate(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, client: ClientContext): Promise<PlaceResult>;
}

/** Collaborators of {@link createPlacesService}. */
export interface PlacesServiceDeps {
  readonly repository: PlacesRepository;
  /** Opens the write service for a group the caller was verified to reach: only for a backoffice user (the type keeps a store out of every write). */
  readonly writerFor: (principal: AuthPrincipal, access: GroupAccess) => CompaniesPlacesWriter;
  /** Opens the read of the places for a caller with a perimeter, a backoffice user or a store. */
  readonly readerFor: (principal: ScopeHolder, access: GroupAccess) => Pick<CompaniesPlacesWriter, 'read'>;
  readonly logger: Logger;
  /** Ends the store key of a place that goes to the trash or is deleted (step 7C): the place document is never touched. */
  readonly storeKeys: Pick<StoreKeysService, 'revokeForPlace'>;
  readonly activityLog: ActivityLog;
  /** Checks that the categories the settings refer to exist in the group. */
  readonly references: Pick<ReferencesRepository, 'missing'>;
  /** Gives the descriptor of an image of the group, for the images of the place. */
  readonly images: Pick<MediaService, 'logoSource'>;
  /** A new id for a payment type: the form of the legacy (`createId` of the old backoffice). */
  readonly newId: () => string;
}

/** What a new place has in the fields only some roles may set: sending the default is not a change. */
const CREATION_DEFAULTS: Readonly<Record<string, unknown>> = {
  'license.plan': 'basic',
  'license.expirationDate': null,
  'license.status': 'active',
  'dealerSettings.sentry': false,
  'appointments.webWidgetStatus': false,
};

/** The time zones a place may be given: the ones of the platform (`Intl.supportedValuesOf('timeZone')`, which leaves `UTC` out) and `UTC`. */
const TIME_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/** A time of day as `<input type="time">` gives it: `HH:mm`. */
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** The blocks of the representation, which the activity log names as a whole (no value of them is ever in the log). */
const BLOCKS = [
  'license',
  'openingHours',
  'cashSettings',
  'payments',
  'tables',
  'reservations',
  'delivery',
  'selfOrdering',
  'kiosk',
  'appointments',
  'externalDisplay',
  'fidelity',
  'tobacco',
  'media',
  'devices',
  'printStations',
  'rooms',
  'storages',
  'integrations',
  'dealerSettings',
] as const;

/** The switches of the integrations (and of the other fields of the settings) that are the dealers': a PSA or a dealer changes them. */
const RESERVED_SETTINGS: readonly string[] = SETTING_FIELDS.filter((field) => field.reserved === true).map((field) => field.domain);

/** The keys of the integrations that receive payments: a PSA or a dealer sets, changes or clears them (any other role is `notAllowed`, even for a clear). */
const PAYMENT_SETTINGS: readonly string[] = SETTING_FIELDS.filter((field) => field.payment === true).map((field) => field.domain);

/** Whether the caller is a PSA or a dealer (a store key is neither). */
const isPrivileged = (caller: ScopeHolder): boolean => 'role' in caller && (caller.role === 'PSA' || caller.role === 'D');

/** The place as the caller may see it: the dealer settings are for a PSA or a dealer only. */
function shownTo(caller: ScopeHolder, place: Place): Place {
  if (isPrivileged(caller)) {
    return place;
  }
  const { dealerSettings: _hidden, ...visible } = place;
  return visible;
}

/** An empty day of the week: what a creation has for every day. */
const CLOSED_DAY = { active: false, values: [] };

const NO_LISTS: GroupLists = { currencies: new Set(), priceLists: new Set(), taxes: new Set(), favorites: new Map() };

/** What each outcome of the write service that is not a success becomes: the code and the details of the error. */
const REFUSALS: Readonly<Record<'notFound' | 'companyNotFound' | 'conflict' | 'notTrashed' | 'trashed' | 'busy', { readonly code: ErrorCode; readonly details?: readonly ErrorDetail[] }>> = {
  notFound: { code: 'NOT_FOUND' },
  companyNotFound: { code: 'VALIDATION_ERROR', details: [{ field: 'companyId', issue: 'incorrect' }] },
  conflict: { code: 'PRECONDITION_FAILED' },
  notTrashed: { code: 'CONFLICT' },
  trashed: { code: 'CONFLICT' },
  busy: { code: 'CONFLICT', details: [{ field: 'devices.items', issue: 'busy' }] },
};

/** The name the activity log gives a changed key: the block for a key of a block, the path for a general one. */
const loggedName = (domain: string): string =>
  BLOCKS.find((block) => domain.startsWith(`${block}.`)) ?? (/^(?:receipt|prebilling|ordering)\./.test(domain) || domain.startsWith('printing.') ? 'printing' : domain);

type Slot = { readonly start: string; readonly end: string };
type Day = { readonly values: readonly Slot[] };

/**
 * The paths of the times that are not `HH:mm` in the slots of a day, as `<path>.values.<index>.start|end`.
 *
 * @param day The hours of the day.
 * @param path Path of the day in the representation.
 */
const timeProblems = (day: Day, path: string): string[] =>
  day.values.flatMap((slot, index) => (['start', 'end'] as const).filter((edge) => !TIME.test(slot[edge])).map((edge) => `${path}.values.${String(index)}.${edge}`));

/**
 * Builds the place service. Every read and write of one place is limited by the perimeter of the caller (a place outside it is a `404`), every write goes through the write service
 * (transaction on the group database and its copy, version check, `groups.places[]`), and what is checked is only what changes, so a place with legacy data that does not satisfy
 * a rule can still be changed in what the rule does not touch.
 *
 * @param deps Repository, write service and activity log.
 */
export function createPlacesService(deps: PlacesServiceDeps): PlacesService {
  const { repository, writerFor, readerFor, activityLog, references, images, newId, storeKeys, logger } = deps;

  const context = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, placeId: ObjectId) => ({
    actor: actorOf(principal),
    groupId: access.groupId,
    resource: { type: 'place', id: placeId.toHexString() },
    requestId: client.requestId,
    ...(client.ip === null ? {} : { ip: client.ip }),
  });

  /** The place the caller reaches with this id: outside the perimeter or missing is `404`. */
  const load = async (writer: Pick<CompaniesPlacesWriter, 'read'>, access: GroupAccess, placeId: ObjectId) => {
    const found = await writer.read('places', placeId);
    if (found === null) {
      throw new AppError('NOT_FOUND');
    }
    return { ...found, place: toPlace(found.document, access.groupId) };
  };

  /** The place as it is after a write, as the caller may see it. */
  const reload = async (writer: Pick<CompaniesPlacesWriter, 'read'>, access: GroupAccess, placeId: ObjectId, caller: ScopeHolder): Promise<PlaceResult> => {
    const { place, version } = await load(writer, access, placeId);
    return { place: shownTo(caller, place), version };
  };

  /** Runs a write; a stored block that is not an object is a `409`, every other failure goes on to the central handler (a group on another cluster is a logged `500`). */
  const attempt = async (write: () => Promise<WriteOutcome>): Promise<WriteOutcome> => {
    try {
      return await write();
    } catch (error) {
      throw error instanceof MalformedDocumentError ? new AppError('CONFLICT', { message: 'The stored place has a block that cannot be written' }) : error;
    }
  };

  /** Turns the outcome of a write that did not succeed (`written` is the success) into its error. */
  const refused = (outcome: WriteOutcome): AppError => {
    const { code, details } = REFUSALS[outcome.outcome as keyof typeof REFUSALS];
    return new AppError(code, details === undefined ? {} : { details });
  };

  const assertVersion = (found: { readonly version: string }, expected: string): void => {
    if (found.version !== expected) {
      throw new AppError('PRECONDITION_FAILED');
    }
  };

  /**
   * Checks a request against the role, the stored place and the data it refers to (company, countries, price lists, invoice series, time zones), and returns it normalized: the
   * price list of the place is always among the price lists it uses (as the old backoffice does). A field is checked when it changes (or on a creation).
   *
   * @param current The place as it is, `null` for a creation.
   * @throws {AppError} `FORBIDDEN` for a field the role cannot change, `VALIDATION_ERROR` for the rules on the data.
   */
  const prepare = async (
    principal: AuthPrincipal,
    access: GroupAccess,
    writer: CompaniesPlacesWriter,
    request: PlacePatch,
    current: Place | null,
    document: Document | null,
  ): Promise<PlacePatch> => {
    const creation = current === null;
    const privileged = principal.role === 'PSA' || principal.role === 'D';
    const changes = (path: string): boolean => {
      const requested = valueAt(request, path);
      return requested !== undefined && canonicalJson(requested) !== canonicalJson(creation ? CREATION_DEFAULTS[path] : valueAt(current, path));
    };

    // The license: the end of the license and the state a PSA's or a dealer's, the Sentry switch a PSA's.
    const forbidden: string[] = [];
    if (!privileged) {
      forbidden.push(...['license.status', 'license.expirationDate', 'appointments.webWidgetStatus', ...RESERVED_SETTINGS, ...PAYMENT_SETTINGS].filter(changes));
      // The dealer settings (the address of the server of the store, the Connector, Sentry) are not shown to the other roles, which therefore never send them.
      if (request.dealerSettings !== undefined) {
        forbidden.push('dealerSettings');
      }
    }
    // The plan is a PSA's; a dealer chooses it for a new place among the four plans but `desk-secondary`, which is the PSA's alone.
    if (principal.role !== 'PSA' && !(creation && principal.role === 'D' && request.license?.plan !== 'desk-secondary') && changes('license.plan')) {
      forbidden.push('license.plan');
    }
    // The Sentry switch is the PSA's: a dealer may not change it (the other roles are already refused the whole block).
    if (principal.role === 'D' && changes('dealerSettings.sentry')) {
      forbidden.push('dealerSettings.sentry');
    }
    if (forbidden.length > 0) {
      throw new AppError('FORBIDDEN', { details: forbidden.map((field) => ({ field, issue: 'notAllowed' })) });
    }

    const next = structuredClone(request) as Record<string, unknown>;
    const issues: ErrorDetail[] = [];
    const issue = (field: string, kind: string): void => void issues.push({ field, issue: kind });

    // The company: one of the group, not in the trash, inside the perimeter of the caller. Its invoice series are what the place chooses from.
    let company: CompanyOfPlace | null = null;
    let rejected = false;
    const companyId = request.companyId ?? current?.companyId ?? null;
    const companyChanged = changes('companyId');
    if (creation || companyChanged) {
      const id = ObjectId.createFromHexString(companyId as string);
      company = companyInScope(principal.scope, id) ? await writer.companyOfPlace(id) : null;
      if (company === null || company.trashed) {
        rejected = true;
        issue('companyId', 'incorrect');
      }
    }

    // Country and province.
    const country = request.address?.country ?? current?.address.country ?? null;
    const countryChanged = changes('address.country');
    if (creation || countryChanged || changes('address.province')) {
      const problem = await addressProblem((code) => repository.findCountry(code), country, request.address?.province ?? current?.address.province ?? '', creation || countryChanged);
      if (problem !== null) {
        issue(problem, 'incorrect');
      }
    }

    // The price lists: the ones of the group that are enabled; a list the place already uses is not judged again.
    const priceListId = request.priceListId;
    const ecommerceId = request.ecommercePriceListId;
    const requestedLists = request.priceLists;
    const known = new Set((current?.priceLists ?? []).map((list) => list.id));
    const newLists = (requestedLists ?? []).filter((list) => !known.has(list.id as string));
    let listsRead: Promise<GroupLists> | null = null;
    /** The currencies and price lists of the group, read once and only when a rule needs them. */
    const lists = (): Promise<GroupLists> => (listsRead ??= repository.groupLists(access.groupId).then((read) => read ?? NO_LISTS));
    const groupLists = (priceListId != null && changes('priceListId')) || (ecommerceId != null && changes('ecommercePriceListId')) || newLists.length > 0 ? await lists() : NO_LISTS;
    if (priceListId != null && changes('priceListId') && !groupLists.priceLists.has(priceListId)) {
      issue('priceListId', 'incorrect');
    }
    if (ecommerceId != null && changes('ecommercePriceListId') && !groupLists.priceLists.has(ecommerceId)) {
      issue('ecommercePriceListId', 'incorrect');
    }
    (requestedLists ?? []).forEach((list, index) => {
      if (!known.has(list.id as string) && !groupLists.priceLists.has(list.id as string)) {
        issue(`priceLists.${String(index)}.id`, 'incorrect');
      }
    });
    // The price list of the sales is always one of the price lists of the place.
    const chosen = priceListId === undefined ? (current?.priceListId ?? null) : priceListId;
    if (chosen !== null && (changes('priceListId') || requestedLists !== undefined)) {
      const used: readonly Partial<PlacePriceList>[] = requestedLists ?? current?.priceLists ?? [];
      if (!used.some((list) => list.id === chosen)) {
        setValueAt(next, 'priceLists', [...used, { id: chosen, allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
      }
    }

    // The invoice series: the name of a series of the company the place will have (`false` and `null` are the values the legacy stores for none).
    // A company that was rejected is not read again: its series are not told to a caller who may not reach it (the error on the company is enough).
    if (!rejected && changes('invoiceSeries')) {
      const series = request.invoiceSeries as string | false | null;
      if (typeof series === 'string') {
        company ??= companyId === null ? null : await writer.companyOfPlace(ObjectId.createFromHexString(companyId));
        if (company === null || !company.invoiceSeries.includes(series)) {
          issue('invoiceSeries', 'incorrect');
        }
      } else if (series === false) {
        issue('invoiceSeries', 'incorrect');
      }
    }

    // The plan: one of the five known ones (a historical plan stays until a PSA changes it).
    if (changes('license.plan') && !(PLANS as readonly (string | null | undefined)[]).includes(request.license?.plan)) {
      issue('license.plan', 'incorrect');
    }

    // The time zone and the hours: where they change, the zone is one of the platform and every time is `HH:mm` and every special day a date that exists.
    if (changes('openingHours.timezone') && !TIME_ZONES.has(request.openingHours?.timezone as string)) {
      issue('openingHours.timezone', 'incorrect');
    }
    for (const [path, week, special] of [
      ['openingHours', request.openingHours?.week, request.openingHours?.special],
      ['openingHours.deliveryTime', request.openingHours?.deliveryTime?.week, request.openingHours?.deliveryTime?.special],
    ] as const) {
      for (const day of WEEK_DAYS) {
        const requestedDay = week?.[day] as Day | undefined;
        const storedDay = valueAt(current, `${path}.week.${day}`) ?? CLOSED_DAY;
        if (requestedDay !== undefined && canonicalJson(requestedDay) !== canonicalJson(storedDay)) {
          timeProblems(requestedDay, `${path}.week.${day}`).forEach((field) => issue(field, 'format'));
        }
      }
      for (const [date, requestedDay] of Object.entries((special ?? {}) as Readonly<Record<string, Day>>)) {
        const storedDay = valueAt(current, `${path}.special.${date}`);
        if (canonicalJson(requestedDay) !== canonicalJson(storedDay)) {
          if (!isValidCalendarDate(date)) {
            issue(`${path}.special.${date}`, 'format');
          }
          timeProblems(requestedDay, `${path}.special.${date}`).forEach((field) => issue(field, 'format'));
        }
      }
    }

    const rules = { principal, access, writer, repository, references, images, newId, request: request as Record<string, unknown>, next, current, companyId: rejected ? (current?.companyId ?? null) : companyId, changes, issue, lists };
    await applySettingsRules(rules);
    const conflict = await applyListRules({ ...rules, document });

    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues });
    }
    if (conflict !== null) {
      throw conflict;
    }
    return next as PlacePatch;
  };

  /**
   * The keys the form keeps as copies of other keys (deprecated, but the readers of the legacy still read them): `roomsSettings.delivery`, `deliveryAutoOrderingTime` and
   * `deliverySendPrebillingOnSave` follow the take-away block, `roomsSettings.tableGroups` (with `mergeProductsPrint`, a copy of the ordering one) and `tableGroupName` follow the
   * table groups and the ordering. They are written whenever a key they copy is, from the values the place will have.
   */
  const withDeprecated = (writes: ReturnType<typeof leafWrites>, request: PlacePatch, current: Place | null): ReturnType<typeof leafWrites> => {
    const effective = (path: string): unknown => (valueAt(request, path) !== undefined ? valueAt(request, path) : valueAt(current, path));
    const out = [...writes];
    if (writes.some((write) => write.legacy.startsWith('deliveryTakeAway.'))) {
      out.push(
        { domain: 'delivery', legacy: 'roomsSettings.delivery', value: effective('delivery.takeAway.status') === true },
        { domain: 'delivery', legacy: 'roomsSettings.deliveryAutoOrderingTime', value: effective('delivery.takeAway.autoOrderingTime') ?? null },
        { domain: 'delivery', legacy: 'roomsSettings.deliverySendPrebillingOnSave', value: effective('delivery.takeAway.sendPrebillingOnSave') === true },
      );
    }
    const groups = (effective('tables.tableGroups') ?? {}) as { status?: boolean; name?: boolean; autoCreateFirst?: boolean };
    const written = writes.find((write) => write.legacy === 'roomsSettings.tableGroups');
    if (written !== undefined || writes.some((write) => write.legacy === 'ordering.mergeProductsPrint')) {
      const value = { status: groups.status === true, name: groups.name === true, autoCreateFirst: groups.autoCreateFirst === true, mergeProductsPrint: effective('printing.ordering.mergeProductsPrint') === true };
      return [
        ...out.filter((write) => write !== written),
        { domain: written?.domain ?? 'printing.ordering.mergeProductsPrint', legacy: 'roomsSettings.tableGroups', value },
        { domain: written?.domain ?? 'printing.ordering.mergeProductsPrint', legacy: 'roomsSettings.tableGroupName', value: value.name },
      ];
    }
    return out;
  };

  /** The flat map of the stored paths and values the write service takes. */
  const flat = (writes: ReturnType<typeof leafWrites>): Record<string, unknown> => Object.fromEntries(writes.map((write) => [write.legacy, write.value]));

  /**
   * Ends the store key of a place that left the operation. The write is already committed and logged: a failure here is logged (ids only) and does not change the outcome,
   * because the check the store makes on every request revokes the key at its next call.
   */
  const revokeKey = async (principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, reason: 'placeTrashed' | 'placeDeleted', client: ClientContext): Promise<void> => {
    try {
      await storeKeys.revokeForPlace(access.groupId, placeId, reason, principal, client);
    } catch (error) {
      logger.error('revoking the store key of a place failed', { groupId: access.groupId.toHexString(), placeId: placeId.toHexString(), reason, error });
    }
  };

  /**
   * A change of state (`trash`, `restore`): the place must be in the opposite state, then the write service moves it. `check` is the `If-Match` of the request, or `bulk` (an item of a bulk operation, which has no version),
   * which takes the version just read; the write checks it again inside its transaction.
   */
  const changeState = async (
    principal: AuthPrincipal,
    access: GroupAccess,
    placeId: ObjectId,
    check: VersionCheck,
    client: ClientContext,
    to: 'trashed' | 'restored',
  ): Promise<PlaceResult> => {
    const writer = writerFor(principal, access);
    const found = await load(writer, access, placeId);
    const version = check.kind === 'ifMatch' ? check.version : found.version;
    assertVersion(found, version);
    const trashing = to === 'trashed';
    if (found.place.trashed === trashing) {
      throw new AppError('CONFLICT');
    }
    const outcome = await (trashing ? writer.trash('places', placeId, version) : writer.restore('places', placeId, version));
    if (outcome.outcome !== 'written') {
      throw refused(outcome);
    }
    await recordDataChange(activityLog, {
      ...context(principal, access, client, placeId),
      action: trashing ? 'place.trashed' : 'place.restored',
      before: { trashed: !trashing },
      after: { trashed: trashing },
    });
    if (trashing) {
      // The server of the store stops with the place. A restored place gets no key back: it is activated again.
      await revokeKey(principal, access, placeId, 'placeTrashed', client);
    }
    return reload(writer, access, placeId, principal);
  };

  /** The deletion of a place from the trash; `check` as in {@link changeState}. */
  const deleteTrashed = async (principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, check: VersionCheck, client: ClientContext): Promise<void> => {
    const writer = writerFor(principal, access);
    const found = await load(writer, access, placeId);
    const version = check.kind === 'ifMatch' ? check.version : found.version;
    assertVersion(found, version);
    if (!found.place.trashed) {
      throw new AppError('CONFLICT');
    }
    if (await repository.hasUsers(access.groupId, placeId)) {
      throw new AppError('CONFLICT', { details: [{ field: 'users', issue: 'referenced' }] });
    }
    const outcome = await writer.deleteTrashed('places', placeId, version);
    if (outcome.outcome !== 'deleted') {
      throw refused(outcome);
    }
    await recordDataChange(activityLog, { ...context(principal, access, client, placeId), action: 'place.deleted', before: undefined, after: undefined });
    await revokeKey(principal, access, placeId, 'placeDeleted', client);
  };

  return {
    list: async (principal, access, query) => {
      const conditions: Filter<Document>[] = [query.trashed === 'true' ? { trash: true } : { trash: { $ne: true } }];
      if (query.companyId !== undefined) {
        conditions.push({ companyId: query.companyId });
      }
      const ids = parseIds(query.ids);
      if (ids !== null) {
        conditions.push({ _id: { $in: ids } });
      }
      if (query.status !== undefined) {
        conditions.push({ status: query.status === 'active' ? true : { $ne: true } });
      }
      if (query.plan !== undefined) {
        conditions.push({ plan: query.plan });
      }
      if (query.country !== undefined) {
        conditions.push({ countryCode: query.country });
      }
      if (query.province !== undefined) {
        conditions.push({ countryAreaCode: query.province });
      }
      const { items, page } = await repository.list(principal, access, { $and: conditions }, listParamsOf(query, PLACES_LIST));
      return { items: items.map(toPlaceSummary), page };
    },

    get: (principal, access, placeId) => reload(readerFor(principal, access), access, placeId, principal),

    invoiceSeries: async (principal, access, placeId) => {
      const writer = writerFor(principal, access);
      const { place } = await load(writer, access, placeId);
      const company = place.companyId === null ? null : await writer.companyOfPlace(ObjectId.createFromHexString(place.companyId));
      return company === null ? [] : company.series;
    },

    create: async (principal, access, body, client) => {
      const writer = writerFor(principal, access);
      const request = await prepare(principal, access, writer, body, null, null);
      const outcome = await attempt(() => writer.createPlace(flat(withDeprecated(leafWrites(request, null, null, PLACE_LEAVES), request, null)) as unknown as NewPlaceFields));
      if (outcome.outcome !== 'written') {
        throw refused(outcome);
      }
      const created = await reload(writer, access, outcome.id, principal);
      await recordDataChange(activityLog, {
        ...context(principal, access, client, outcome.id),
        action: 'place.created',
        before: undefined,
        after: { name: created.place.name, status: created.place.license.status },
      });
      return created;
    },

    update: async (principal, access, placeId, expected, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'required' }] });
      }
      const writer = writerFor(principal, access);
      const found = await load(writer, access, placeId);
      assertVersion(found, expected);
      const request = await prepare(principal, access, writer, patch, found.place, found.document);
      const leafs = leafWrites(request, found.place, found.document, PLACE_LEAVES);
      if (leafs.length === 0) {
        return { place: shownTo(principal, found.place), version: found.version };
      }
      const writes = withDeprecated(leafs, request, found.place);
      const outcome = await attempt(() => writer.updatePlace(placeId, expected, flat(writes)));
      if (outcome.outcome !== 'written') {
        throw refused(outcome);
      }
      // What changed is told by name only: no value is in the log.
      const changed = [...new Set(writes.map((write) => loggedName(write.domain)))];
      await activityLog.record({
        category: 'data',
        action: 'place.updated',
        outcome: 'success',
        ...context(principal, access, client, placeId),
        changes: changed.map((field) => ({ field, redacted: true as const })),
      });
      return reload(writer, access, placeId, principal);
    },

    trash: (principal, access, placeId, expected, client) => changeState(principal, access, placeId, { kind: 'ifMatch', version: expected }, client, 'trashed'),

    restore: (principal, access, placeId, expected, client) => changeState(principal, access, placeId, { kind: 'ifMatch', version: expected }, client, 'restored'),

    remove: (principal, access, placeId, expected, client) => deleteTrashed(principal, access, placeId, { kind: 'ifMatch', version: expected }, client),

    restoreFromTrash: (principal, access, placeId, client) => settleItem(() => changeState(principal, access, placeId, { kind: 'bulk' }, client, 'restored')),

    deleteFromTrash: (principal, access, placeId, client) => settleItem(() => deleteTrashed(principal, access, placeId, { kind: 'bulk' }, client)),

    trashedIds: (principal, access, limit, after) => repository.trashedIds(principal, access, limit, after),

    countTrashed: (principal, access) => repository.countTrashed(principal, access),

    duplicate: async (principal, access, placeId, client) => {
      if (principal.role !== 'PSA' && principal.role !== 'D') {
        throw new AppError('FORBIDDEN');
      }
      const writer = writerFor(principal, access);
      const outcome = await writer.duplicatePlace(placeId);
      if (outcome.outcome === 'companyNotFound') {
        // The request has no company to be wrong about: the company of the source is the problem, which only the administrator can repair.
        throw new AppError('CONFLICT', { details: [{ field: 'companyId', issue: 'incorrect' }] });
      }
      if (outcome.outcome !== 'written') {
        throw refused(outcome);
      }
      const created = await reload(writer, access, outcome.id, principal);
      await recordDataChange(activityLog, {
        ...context(principal, access, client, outcome.id),
        action: 'place.duplicated',
        before: undefined,
        after: { name: created.place.name, status: created.place.license.status },
        metadata: { sourceId: placeId.toHexString() },
      });
      return created;
    },
  };
}
