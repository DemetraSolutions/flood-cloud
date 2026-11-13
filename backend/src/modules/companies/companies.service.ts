import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { canonicalJson } from '../../shared/http/etag.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import { MalformedDocumentError } from '../../shared/legacy-write/errors.ts';
import type { CompaniesPlacesWriter, WriteOutcome } from '../../shared/legacy-write/companies-places.writer.ts';
import type { NewCompanyFields } from '../../shared/legacy-write/fields.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { companyInScope } from '../../shared/security/scope/scope-filters.ts';
import { parseIds } from '../group-lookup/lookup.schemas.ts';
import type { MediaService } from '../media/media.service.ts';
import type { CompaniesQuery } from './companies.schemas.ts';
import { COMPANIES_LIST } from './companies.list.ts';
import type { CompaniesRepository, GroupLists } from './companies.repository.ts';
import { leafWrites, setValueAt, toCompany, toCompanySummary, valueAt } from './company.mapper.ts';
import type { Company, CompanyCreation, CompanyPatch, CompanySummary, ImageReference, MediaLogo } from './company.types.ts';
import { ARUBA_HUB, HUB, mayChooseHub } from './hubs.ts';
import { isValidItalianFiscalCode, isValidItalianVatNumber } from './validators.ts';

/** A company with the version of its stored document: the `ETag` of the response and the `If-Match` of the next write. */
export interface CompanyResult {
  readonly company: Company;
  readonly version: string;
}

/** A hub a caller may set, with the label to show. */
export interface HubOption {
  /** `aruba` or `aruba__<id of a dealer>`. */
  readonly value: string;
  readonly label: string;
}

/** A page of the compact list. */
export interface CompaniesListing {
  readonly items: readonly CompanySummary[];
  readonly page: PageInfo;
}

/** The management of the companies of a group (`doc/Tasks.md` area 6): the list, the detail, the creation, the modification by blocks, the trash and the deletion. */
export interface CompaniesService {
  /**
   * Lists the companies of a verified group inside the caller's perimeter, from the copies in the common database (untrashed ones by default).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: CompaniesQuery): Promise<CompaniesListing>;
  /**
   * Reads one company, from the document of the group database (so the version is the one `If-Match` expects). A company that does not exist, is of another group
   * or outside the perimeter (a CA reaches only his own) is one and the same `404`.
   *
   * @throws {AppError} `NOT_FOUND`.
   */
  get(principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId): Promise<CompanyResult>;
  /**
   * The hubs the caller may set in the e-invoicing data, with their labels: `aruba`, and the active dealers (`aruba__<id>`, labelled with the business name of the dealer or his name): a PSA all of them, a dealer
   * his own, a group or company administrator none. The same allowlist as the write ({@link mayChooseHub}).
   */
  hubs(principal: AuthPrincipal): Promise<readonly HubOption[]>;
  /**
   * Creates a company with the complete structure the legacy expects. `hub`, `transmitter`, `status`, `expirationDate` and `cervedLookup` may be sent only by a PSA or a dealer.
   *
   * @throws {AppError} `FORBIDDEN` (with `notAllowed` details), `VALIDATION_ERROR` (country, province, VAT number, fiscal code, currency, hub, price list, ids, logos: an `imageId` that is not an image of the group is `incorrect`, a descriptor that is not the stored one is `notAllowed`),
   * `CONFLICT` (`vatNumber` `taken`).
   */
  create(principal: AuthPrincipal, access: GroupAccess, body: CompanyCreation, client: ClientContext): Promise<CompanyResult>;
  /**
   * Modifies a company: any subset of the general fields and of the blocks, written key by key. Only the keys whose value differs from the stored one are written; a
   * request that changes nothing writes nothing and answers with the company as it is. `hub`, `transmitter`, `status` and `expirationDate` can be changed only by a PSA or a dealer
   * (a dealer chooses `''`, `aruba` or his own hub, and keeps another dealer's hub as it is); the others may resend the value the company has.
   *
   * @param expected The version the caller read (`If-Match`).
   * @throws {AppError} `VALIDATION_ERROR` (empty body, a rule on a field), `NOT_FOUND`, `PRECONDITION_FAILED`, `FORBIDDEN` (`notAllowed`),
   * `CONFLICT` (`vatNumber` `taken`; a block of the stored company that is not an object).
   */
  update(principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId, expected: string, patch: CompanyPatch, client: ClientContext): Promise<CompanyResult>;
  /**
   * Moves a company to the trash. The places of the company keep the reference.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` when it is already there.
   */
  trash(principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId, expected: string, client: ClientContext): Promise<CompanyResult>;
  /**
   * Takes a company out of the trash.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` when it is not there.
   */
  restore(principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId, expected: string, client: ClientContext): Promise<CompanyResult>;
  /**
   * Deletes a company that is in the trash, for good.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` when it is not in the trash, or when a place of the group (trashed ones included) still refers to it (`places` `referenced`).
   */
  remove(principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId, expected: string, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createCompaniesService}. */
export interface CompaniesServiceDeps {
  readonly repository: CompaniesRepository;
  /** Opens the write service for a group the caller was verified to reach. */
  readonly writerFor: (principal: AuthPrincipal, access: GroupAccess) => CompaniesPlacesWriter;
  /** Gives the descriptor of an image of the group, for the logos. */
  readonly images: Pick<MediaService, 'logoSource'>;
  readonly activityLog: ActivityLog;
  /** A new id for a bank account or a meal voucher issuer: a random string of 24 hexadecimal characters, as long as the ids of the legacy. */
  readonly newId: () => string;
}

/** The fields only a PSA or a dealer may change. */
const RESTRICTED_FIELDS = ['status', 'expirationDate', 'invoiceNumbering.cervedLookup', 'eInvoicing.hub', 'eInvoicing.transmitter.country', 'eInvoicing.transmitter.code'] as const;

/** What a new company has in the fields only a PSA or a dealer may set: sending the default is not a change (`hub` and `transmitter` `null`, `''` is read as `null`). */
const CREATION_DEFAULTS: Readonly<Record<string, unknown>> = {
  status: 'active',
  expirationDate: null,
  'invoiceNumbering.cervedLookup': false,
  'eInvoicing.hub': null,
  'eInvoicing.transmitter.country': null,
  'eInvoicing.transmitter.code': null,
};

/** The blocks of the representation, which the activity log names as a whole. */
const BLOCKS = ['eInvoicing', 'invoiceNumbering', 'bankAccounts', 'mealVoucherIssuers', 'customerApp', 'media'] as const;

/** What a VAT number or fiscal code of a country other than Italy may be: printable ASCII, without spaces at the ends (no invisible or non-ASCII characters, which would defeat the uniqueness check). */
const PRINTABLE_ASCII = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

const NO_LISTS: GroupLists = { currencies: new Set(), priceLists: new Set() };

/** What each outcome of the write service that is not a success becomes. A company never has `companyNotFound` (it is the answer for a place); both are a missing document. */
const notFound = (): AppError => new AppError('NOT_FOUND');
const REFUSALS: Readonly<Record<Exclude<WriteOutcome['outcome'], 'written' | 'deleted'>, () => AppError>> = {
  notFound,
  companyNotFound: notFound,
  conflict: () => new AppError('PRECONDITION_FAILED'),
  notTrashed: () => new AppError('CONFLICT'),
  vatNumberTaken: () => new AppError('CONFLICT', { details: [{ field: 'vatNumber', issue: 'taken' }] }),
  referenced: () => new AppError('CONFLICT', { details: [{ field: 'places', issue: 'referenced' }] }),
};

/** The name the activity log gives a changed key: the block for a key of a block, the path for a general one. */
const loggedName = (domain: string): string => BLOCKS.find((block) => domain.startsWith(`${block}.`) || domain === block) ?? domain;

/**
 * Builds the company service. Every read and write of one company is limited by the perimeter of the caller (a company outside it is a `404`), every write
 * goes through the write service (transaction on the group database and its copy, version check, VAT number check), and no value of a company's bank data
 * reaches the activity log.
 *
 * @param deps Repository, write service, activity log and id generator.
 */
export function createCompaniesService(deps: CompaniesServiceDeps): CompaniesService {
  const { repository, writerFor, images, activityLog, newId } = deps;

  const context = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, companyId: ObjectId) => ({
    actor: actorOf(principal),
    groupId: access.groupId,
    resource: { type: 'company', id: companyId.toHexString() },
    requestId: client.requestId,
    ...(client.ip === null ? {} : { ip: client.ip }),
  });

  /** The company the caller reaches with this id: outside the perimeter or missing is `404`. */
  const load = async (writer: CompaniesPlacesWriter, principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId) => {
    if (!companyInScope(principal.scope, companyId)) {
      throw notFound();
    }
    const found = await writer.read('companies', companyId);
    if (found === null) {
      throw notFound();
    }
    return { ...found, company: toCompany(found.document, access.groupId) };
  };

  /** The company as it is after a write. */
  const reload = async (writer: CompaniesPlacesWriter, access: GroupAccess, companyId: ObjectId): Promise<CompanyResult> => {
    const found = await writer.read('companies', companyId);
    if (found === null) {
      throw notFound();
    }
    return { company: toCompany(found.document, access.groupId), version: found.version };
  };

  /** Runs a write; a stored block that is not an object is a `409`, every other failure goes on to the central handler (a group on another cluster is a logged `500`). */
  const attempt = async (write: () => Promise<WriteOutcome>): Promise<WriteOutcome> => {
    try {
      return await write();
    } catch (error) {
      throw error instanceof MalformedDocumentError ? new AppError('CONFLICT', { message: 'The stored company has a block that cannot be written' }) : error;
    }
  };

  /** Turns the outcome of a write that did not succeed (`written` and `deleted` are the successes) into its error. */
  const refused = (outcome: WriteOutcome): AppError => REFUSALS[outcome.outcome as keyof typeof REFUSALS]();

  const assertVersion = (found: { readonly version: string }, expected: string): void => {
    if (found.version !== expected) {
      throw new AppError('PRECONDITION_FAILED');
    }
  };

  /**
   * Checks a request against the role, the stored company and the data it refers to (countries, currencies, price lists, dealers), and returns it
   * normalized: ids given to the new accounts and issuers, the minimum orders merged with the ones the company has, the defaults of a creation. A field is
   * checked when it changes (or on a creation), so a company with legacy data that does not satisfy a rule can still be changed in what the rule does not touch.
   *
   * @param current The company as it is, `null` for a creation.
   * @throws {AppError} `FORBIDDEN` for a field the role cannot change, `VALIDATION_ERROR` for the rules on the data.
   */
  const prepare = async (principal: AuthPrincipal, access: GroupAccess, request: CompanyPatch, current: Company | null): Promise<CompanyPatch> => {
    const creation = current === null;
    const privileged = principal.role === 'PSA' || principal.role === 'D';
    const changes = (path: string): boolean => {
      const requested = valueAt(request, path);
      return requested !== undefined && canonicalJson(requested) !== canonicalJson(creation ? CREATION_DEFAULTS[path] : valueAt(current, path));
    };

    const forbidden: string[] = privileged ? [] : RESTRICTED_FIELDS.filter(changes);
    const hub = request.eInvoicing?.hub;
    const hubId = typeof hub === 'string' ? HUB.exec(hub) : null;
    if (principal.role === 'D' && changes('eInvoicing.hub') && typeof hub === 'string' && !mayChooseHub(principal, hub)) {
      forbidden.push('eInvoicing.hub');
    }
    if (forbidden.length > 0) {
      throw new AppError('FORBIDDEN', { details: forbidden.map((field) => ({ field, issue: 'notAllowed' })) });
    }

    const next = structuredClone(request) as Record<string, unknown>;
    const issues: ErrorDetail[] = [];
    const issue = (field: string, kind: string): void => void issues.push({ field, issue: kind });

    // Country and province.
    const country = request.address?.country ?? current?.address.country ?? null;
    const countryChanged = changes('address.country');
    if (creation || countryChanged || changes('address.province')) {
      const province = request.address?.province ?? current?.address.province ?? '';
      const found = country === null ? null : await repository.findCountry(country);
      if (found === null && (creation || countryChanged)) {
        issue('address.country', 'incorrect');
      } else if (found?.areas != null && province !== '' && !found.areas.has(province)) {
        issue('address.province', 'incorrect');
      }
    }

    // VAT number and fiscal code: the Italian rules when the country is Italy.
    const italian = country === 'IT';
    const vatNumber = request.vatNumber ?? current?.vatNumber ?? '';
    if ((creation || changes('vatNumber') || countryChanged) && !(italian ? isValidItalianVatNumber(vatNumber) : vatNumber.length >= 2 && PRINTABLE_ASCII.test(vatNumber))) {
      issue('vatNumber', 'format');
    }
    const fiscalCode = request.fiscalCode === undefined ? (current?.fiscalCode ?? null) : request.fiscalCode;
    if (fiscalCode !== null && (changes('fiscalCode') || countryChanged)) {
      const code = italian ? fiscalCode.toUpperCase() : fiscalCode;
      if (italian ? !isValidItalianFiscalCode(code) : !PRINTABLE_ASCII.test(code)) {
        issue('fiscalCode', 'format');
      } else if (request.fiscalCode !== undefined) {
        setValueAt(next, 'fiscalCode', code);
      }
    }

    // The lists of the group: currency, price list and minimum orders.
    const currency = request.currency ?? (creation ? 'EUR' : undefined);
    const minimumOrder = request.customerApp?.ecommerce?.minimumOrder;
    const priceListId = request.customerApp?.ecommerce?.priceListId;
    const needsLists = creation || changes('currency') || (priceListId != null && changes('customerApp.ecommerce.priceListId')) || minimumOrder !== undefined;
    const lists = needsLists ? ((await repository.groupLists(access.groupId)) ?? NO_LISTS) : NO_LISTS;
    if (currency !== undefined && (creation || changes('currency')) && !lists.currencies.has(currency)) {
      issue('currency', request.currency === undefined ? 'required' : 'incorrect');
    } else if (creation && request.currency === undefined) {
      setValueAt(next, 'currency', currency);
    }
    if (priceListId != null && changes('customerApp.ecommerce.priceListId') && !lists.priceLists.has(priceListId)) {
      issue('customerApp.ecommerce.priceListId', 'incorrect');
    }
    if (minimumOrder !== undefined) {
      const stored = current?.customerApp.ecommerce.minimumOrder ?? {};
      for (const [code, amount] of Object.entries(minimumOrder)) {
        if (stored[code] !== amount && !lists.currencies.has(code)) {
          issue(`customerApp.ecommerce.minimumOrder.${code}`, 'incorrect');
        }
      }
      setValueAt(next, 'customerApp.ecommerce.minimumOrder', { ...stored, ...minimumOrder });
    }

    // The hub: a closed list. A dealer's id must be the id of a dealer that exists.
    if (typeof hub === 'string' && changes('eInvoicing.hub')) {
      // A dealer's own id needs no lookup: he is one.
      const own = principal.role === 'D' && hubId?.[1] === principal.userId.toHexString();
      if (hubId === null || (hubId[1] !== undefined && !own && !(await repository.isDealer(ObjectId.createFromHexString(hubId[1]))))) {
        issue('eInvoicing.hub', 'incorrect');
      }
    }

    // The accounts and the issuers: an id is one the company already has, a new element gets one.
    for (const field of ['bankAccounts', 'mealVoucherIssuers'] as const) {
      const items = request[field];
      if (items !== undefined) {
        const known = new Set((current?.[field] ?? []).map((item) => item.id));
        const used = new Set<string>();
        setValueAt(
          next,
          field,
          items.map((item, index) => {
            if (item.id !== undefined && (!known.has(item.id) || used.has(item.id))) {
              issue(`${field}.${String(index)}.id`, 'incorrect');
            }
            const id = item.id ?? newId();
            used.add(id);
            return { ...item, id };
          }),
        );
      }
    }

    // A logo can be removed, sent back as it is, or set from an image of the group (`{ imageId }`): the descriptor is built from the stored image, never from the request.
    for (const logo of ['customersAppLogoLight', 'customersAppLogoDark'] as const) {
      const path = `media.${logo}`;
      const value = valueAt(request, path) as ImageReference | MediaLogo | null | undefined;
      if (value != null && 'imageId' in value) {
        const source = await images.logoSource(principal, access, ObjectId.createFromHexString(value.imageId), current === null ? null : ObjectId.createFromHexString(current.id));
        if (source === null) {
          issue(path, 'incorrect');
        } else {
          setValueAt(next, path, source);
        }
      } else if (value !== null && changes(path)) {
        issue(path, 'notAllowed');
      }
    }

    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues });
    }
    return next as CompanyPatch;
  };

  /** The flat map of the stored paths and values the write service takes. */
  const flat = (writes: ReturnType<typeof leafWrites>): Record<string, unknown> => Object.fromEntries(writes.map((write) => [write.legacy, write.value]));

  /** A change of state (`trash`, `restore`): the company must be in the opposite state, then the write service moves it. */
  const changeState = async (
    principal: AuthPrincipal,
    access: GroupAccess,
    companyId: ObjectId,
    expected: string,
    client: ClientContext,
    to: 'trashed' | 'restored',
  ): Promise<CompanyResult> => {
    const writer = writerFor(principal, access);
    const found = await load(writer, principal, access, companyId);
    assertVersion(found, expected);
    const trashing = to === 'trashed';
    if (found.company.trashed === trashing) {
      throw new AppError('CONFLICT');
    }
    const outcome = await (trashing ? writer.trash('companies', companyId, expected) : writer.restore('companies', companyId, expected));
    if (outcome.outcome !== 'written') {
      throw refused(outcome);
    }
    await recordDataChange(activityLog, {
      ...context(principal, access, client, companyId),
      action: trashing ? 'company.trashed' : 'company.restored',
      before: { trashed: !trashing },
      after: { trashed: trashing },
    });
    return reload(writer, access, companyId);
  };

  return {
    list: async (principal, access, query) => {
      const conditions: Filter<Document>[] = [query.trashed === 'true' ? { trash: true } : { trash: { $ne: true } }];
      const ids = parseIds(query.ids);
      if (ids !== null) {
        conditions.push({ _id: { $in: ids } });
      }
      if (query.status !== undefined) {
        conditions.push({ status: query.status === 'active' ? true : { $ne: true } });
      }
      if (query.country !== undefined) {
        conditions.push({ countryCode: query.country });
      }
      if (query.province !== undefined) {
        conditions.push({ countryAreaCode: query.province });
      }
      const { items, page } = await repository.list(principal, access, { $and: conditions }, listParamsOf(query, COMPANIES_LIST));
      return { items: items.map(toCompanySummary), page };
    },

    hubs: async (principal) => {
      const options: HubOption[] = [{ value: ARUBA_HUB, label: 'Aruba' }];
      if (principal.role === 'PSA' || principal.role === 'D') {
        const dealers = await repository.listDealers(principal.role === 'D' ? principal.userId : null);
        options.push(...dealers.map((dealer) => ({ value: `${ARUBA_HUB}__${dealer.id}`, label: dealer.label })));
      }
      return options.filter((option) => mayChooseHub(principal, option.value));
    },

    get: async (principal, access, companyId) => {
      const { company, version } = await load(writerFor(principal, access), principal, access, companyId);
      return { company, version };
    },

    create: async (principal, access, body, client) => {
      const request = await prepare(principal, access, body, null);
      const writer = writerFor(principal, access);
      const outcome = await attempt(() => writer.createCompany(flat(leafWrites(request, null, null)) as unknown as NewCompanyFields));
      if (outcome.outcome !== 'written') {
        throw refused(outcome);
      }
      const created = await reload(writer, access, outcome.id);
      await recordDataChange(activityLog, {
        ...context(principal, access, client, outcome.id),
        action: 'company.created',
        before: undefined,
        after: { name: created.company.name, status: created.company.status },
      });
      return created;
    },

    update: async (principal, access, companyId, expected, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'required' }] });
      }
      const writer = writerFor(principal, access);
      const found = await load(writer, principal, access, companyId);
      assertVersion(found, expected);
      const request = await prepare(principal, access, patch, found.company);
      const writes = leafWrites(request, found.company, found.document);
      if (writes.length === 0) {
        return { company: found.company, version: found.version };
      }
      const outcome = await attempt(() => writer.updateCompany(companyId, expected, flat(writes)));
      if (outcome.outcome !== 'written') {
        throw refused(outcome);
      }
      // What changed is told by name only: the values (the IBAN, the VAT number…) are never in the log.
      const changed = [...new Set(writes.map((write) => loggedName(write.domain)))];
      await activityLog.record({
        category: 'data',
        action: 'company.updated',
        outcome: 'success',
        ...context(principal, access, client, companyId),
        changes: changed.map((field) => ({ field, redacted: true as const })),
      });
      return reload(writer, access, companyId);
    },

    trash: (principal, access, companyId, expected, client) => changeState(principal, access, companyId, expected, client, 'trashed'),

    restore: (principal, access, companyId, expected, client) => changeState(principal, access, companyId, expected, client, 'restored'),

    remove: async (principal, access, companyId, expected, client) => {
      if (!companyInScope(principal.scope, companyId)) {
        throw notFound();
      }
      const outcome = await writerFor(principal, access).deleteTrashed('companies', companyId, expected);
      if (outcome.outcome !== 'deleted') {
        throw refused(outcome);
      }
      await recordDataChange(activityLog, { ...context(principal, access, client, companyId), action: 'company.deleted', before: undefined, after: undefined });
    },
  };
}
