import { ObjectId } from 'mongodb';
import type { ClientSession } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { GroupCreationWriter } from '../../shared/legacy-write/companies-places.writer.ts';
import type { NewCompanyFields, NewPlaceFields } from '../../shared/legacy-write/fields.ts';
import type { WriteOutcome } from '../../shared/legacy-write/companies-places.writer.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { addressProblem } from '../companies/address.ts';
import type { Country } from '../companies/companies.repository.ts';
import { PRINTABLE_ASCII, isValidItalianFiscalCode, isValidItalianVatNumber } from '../companies/validators.ts';
import type { GroupAdminStep, UsersService } from '../users/users.service.ts';
import { newElementId } from './catalogs/kit.ts';
import { endOfYearInRome, newDepartmentDocuments, newGroupApiKey, newGroupDocument } from './onboarding.documents.ts';
import type { NewTax } from './onboarding.documents.ts';
import type { OnboardingRepository } from './onboarding.repository.ts';
import type { CreateGroupBody } from './onboarding.schemas.ts';

/** The ids of what the creation of a customer made. Never a password and never the API key of the group. */
export interface CreatedCustomer {
  readonly groupId: string;
  readonly companyId: string;
  readonly placeId: string;
  readonly userId: string;
}

/** The creation of a new customer. */
export interface OnboardingService {
  /**
   * Creates a customer in one transaction on the common cluster: the group, its administrator (SA, with a provisional password he must replace at the first access), its first company, its first
   * place (with the plan and the expiration) and one department per tax rate. Either all of it exists afterwards or none of it, the database of the group included. A dealer creates the group
   * for himself; a PSA may name an active dealer, or none. Records `group.created`, `user.created`, `company.created` and `place.created`, without any secret.
   *
   * @param principal The authenticated caller (a PSA or a dealer: the route requires `groups:create`).
   * @param body Validated body.
   * @param client Request context.
   * @returns The ids of the group, the company, the place and the administrator.
   * @throws {AppError} `FORBIDDEN` (with a `notAllowed` detail per field) for what the role may not choose; `NOT_FOUND` for a dealer that does not exist, is disabled or in the trash;
   * `VALIDATION_ERROR` for the rules on the data, the password policy included; `CONFLICT` (`taken` on the username).
   */
  create(principal: AuthPrincipal, body: CreateGroupBody, client: ClientContext): Promise<CreatedCustomer>;
}

/** Collaborators of {@link createOnboardingService}. */
export interface OnboardingServiceDeps {
  readonly repository: OnboardingRepository;
  /** Prepares the administrator of the group. */
  readonly users: Pick<UsersService, 'prepareGroupAdmin'>;
  /** What the rules on the data and on the dealer need. */
  readonly directory: {
    isDealer(userId: ObjectId): Promise<boolean>;
    findCountry(code: string): Promise<Country | null>;
  };
  /** Issues the access to the new group (a new id on the cluster of the common database) to a caller who holds `groups:create`. */
  readonly newAccess: (principal: AuthPrincipal) => GroupAccess;
  /** Opens the creation of the first company and place of the new group. */
  readonly writerFor: (principal: AuthPrincipal, access: GroupAccess) => GroupCreationWriter;
  readonly activityLog: ActivityLog;
  /** Runs the operations in a transaction on the common cluster: they commit together or not at all (`Databases.transaction`). The function may run more than once. */
  readonly transaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  /** Files host of the new groups (`GROUP_FILES_HOST`), `''` for none. */
  readonly filesHost: string;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/** The id of the writes of a write outcome that is not a success: it cannot happen in a group that did not exist a moment ago, so it is a bug and the transaction is aborted. */
function written(outcome: WriteOutcome): ObjectId {
  if (outcome.outcome !== 'written') {
    throw new Error(`The creation of a customer was refused by the write service: ${outcome.outcome}`);
  }
  return outcome.id;
}

/** The legacy fields of the first company, from the form: only the keys the form gives (the rest takes the defaults of the writer). */
function companyFields(company: CreateGroupBody['company'], fiscalCode: string | null): NewCompanyFields {
  const { address, eInvoicing } = company;
  return {
    name: company.name,
    code: company.vatNumber,
    ...(fiscalCode === null ? {} : { code2: fiscalCode }),
    address: address.street,
    postcode: address.postcode,
    city: address.city,
    countryAreaCode: address.province ?? '',
    countryCode: address.country,
    ...(company.email == null ? {} : { email: company.email }),
    ...(company.phone == null ? {} : { telephone: company.phone }),
    ...(eInvoicing?.recipientCode == null ? {} : { 'fattura_elettronica.codice_destinatario': eInvoicing.recipientCode }),
    ...(eInvoicing?.pec == null ? {} : { 'fattura_elettronica.email': eInvoicing.pec }),
  };
}

/** The legacy fields of the first place, from the form: the address of the company unless the place has its own. */
function placeFields(body: CreateGroupBody, companyId: ObjectId, priceListId: string, expirationDate: Date): NewPlaceFields {
  const { place, company } = body;
  const address = place.address ?? company.address;
  return {
    name: place.name,
    companyId,
    address: address.street,
    postcode: address.postcode,
    city: address.city,
    countryAreaCode: address.province ?? '',
    countryCode: company.address.country,
    ...(place.contactName == null ? {} : { contact: place.contactName }),
    ...(place.email == null ? {} : { email: place.email }),
    ...(place.phone == null ? {} : { telephone: place.phone }),
    listId: priceListId,
    'general.priceLists': [{ id: priceListId, allYouCanEat: false, ayceCode1: null, ayceCode2: null }],
    plan: place.plan ?? 'advanced',
    expirationDate,
  };
}

/**
 * Builds the service of the creation of a customer (area 8, `groups/generate` of the legacy made atomic and idempotent). The group, its dealer, its api key, its status and its cluster are never
 * taken from the client beyond what the role may choose; no document is stored as it was sent, only the fields of the form, each at its place.
 *
 * @param deps Repositories, the preparation of the administrator, the creation writer, the activity log, the transaction runner and the clock.
 */
export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
  const { repository, users, directory, newAccess, writerFor, activityLog, transaction } = deps;

  /** What a role may not choose, as the fields of the body. */
  const forbiddenFields = (principal: AuthPrincipal, body: CreateGroupBody): string[] => {
    const fields: string[] = [];
    if (principal.role !== 'PSA') {
      if (body.group.dealerId !== undefined) {
        fields.push('group.dealerId');
      }
      if (body.group.demo === true) {
        fields.push('group.demo');
      }
      if (body.place.plan === 'desk-secondary') {
        fields.push('place.plan');
      }
    }
    return fields;
  };

  /** The dealer of the group: a dealer is his own, a PSA names an active dealer or none. */
  const dealerOf = async (principal: AuthPrincipal, body: CreateGroupBody): Promise<ObjectId | null> => {
    if (principal.role === 'D') {
      return principal.userId;
    }
    const chosen = body.group.dealerId;
    if (chosen === undefined) {
      return null;
    }
    if (!(await directory.isDealer(chosen))) {
      throw new AppError('NOT_FOUND');
    }
    return chosen;
  };

  /** The rules on the data of the form; the fiscal code the company will have (upper case for an Italian one) is the second value. */
  const checkData = async (principal: AuthPrincipal, body: CreateGroupBody): Promise<{ readonly issues: ErrorDetail[]; readonly fiscalCode: string | null }> => {
    const issues: ErrorDetail[] = [];
    const issue = (field: string, kind: string): void => void issues.push({ field, issue: kind });
    const { company, place } = body;
    const country = company.address.country;
    const italian = country === 'IT';

    const problem = await addressProblem((code) => directory.findCountry(code), country, company.address.province ?? '', true);
    if (problem !== null) {
      issue(`company.${problem}`, 'incorrect');
    }
    if (place.address !== undefined) {
      const placeProblem = await addressProblem((code) => directory.findCountry(code), country, place.address.province ?? '', false);
      if (placeProblem !== null) {
        issue('place.address.province', 'incorrect');
      }
    }
    if (!(italian ? isValidItalianVatNumber(company.vatNumber) : company.vatNumber.length >= 2 && PRINTABLE_ASCII.test(company.vatNumber))) {
      issue('company.vatNumber', 'format');
    }
    let fiscalCode: string | null = null;
    if (company.fiscalCode != null) {
      fiscalCode = italian ? company.fiscalCode.toUpperCase() : company.fiscalCode;
      if (italian ? !isValidItalianFiscalCode(fiscalCode) : !PRINTABLE_ASCII.test(fiscalCode)) {
        issue('company.fiscalCode', 'format');
      }
    }
    // An Italian company is invoiced through the exchange system: it needs a recipient code or a PEC, either one.
    if (italian && company.eInvoicing?.recipientCode == null && company.eInvoicing?.pec == null) {
      issue('company.eInvoicing.recipientCode', 'required');
    }
    // One department per tax rate: the cash register sells under a department, so two rates cannot share it.
    const seen = new Set<number>();
    body.taxes.forEach((tax, index) => {
      if (seen.has(tax.department)) {
        issue(`taxes.${String(index)}.department`, 'incorrect');
      }
      seen.add(tax.department);
    });
    return { issues, fiscalCode };
  };

  return {
    create: async (principal, body, client) => {
      const refused = forbiddenFields(principal, body);
      if (refused.length > 0) {
        throw new AppError('FORBIDDEN', { details: refused.map((field) => ({ field, issue: 'notAllowed' })) });
      }
      const dealerId = await dealerOf(principal, body);
      const { issues, fiscalCode } = await checkData(principal, body);
      if (issues.length > 0) {
        throw new AppError('VALIDATION_ERROR', { details: issues });
      }

      const access = newAccess(principal);
      const groupId = access.groupId;
      const now = new Date(deps.now());
      const ids = { priceList: newElementId(), measureUnit: newElementId(), loadRule: newElementId(), unloadRule: newElementId(), returnRule: newElementId() };
      const taxes: NewTax[] = body.taxes.map((tax) => ({ id: newElementId(), rate: tax.rate, department: tax.department }));
      const group = newGroupDocument({ id: groupId, name: body.group.name, dealerId, demo: body.group.demo ?? false, features: body.group.features ?? {}, taxes, ids, filesHost: deps.filesHost, apiKey: newGroupApiKey(), now });
      const departments = newDepartmentDocuments(groupId, taxes, now);
      const admin: GroupAdminStep = await users.prepareGroupAdmin(principal, {
        username: body.user.username,
        password: body.user.password,
        firstName: body.user.firstName ?? null,
        lastName: body.user.lastName ?? null,
        email: body.user.email ?? null,
        phone: body.user.phone ?? null,
        access,
        dealerId,
        priceListId: ids.priceList,
      });
      const writer = writerFor(principal, access);
      const company = writer.insertCompany(companyFields(body.company, fiscalCode));

      // The group, the administrator, the company, the place and the departments exist together or not at all: the database of the group is created by the inserts of this very transaction.
      const created = await transaction(async (session) => {
        await repository.insertGroup(group, session);
        await admin.run(session);
        const companyId = written(await company(session));
        const placeId = written(await writer.insertPlace(placeFields(body, companyId, ids.priceList, body.place.expirationDate ?? endOfYearInRome(now)))(session));
        await repository.insertDepartments(principal, access, departments, session);
        return { companyId, placeId };
      });

      // The database of the group exists now: it gets the unique index on the code of the loyalty cards the legacy gives every group.
      await repository.createCardIndex(principal, access);
      // The collection of the sales gets the index of the purchases of a customer too (step V1), so the first read for a customer finds it.
      await repository.createSalesIndex(principal, access);

      const context = { actor: actorOf(principal), groupId, requestId: client.requestId, ...(client.ip === null ? {} : { ip: client.ip }) };
      await recordDataChange(activityLog, {
        ...context,
        resource: { type: 'group', id: groupId.toHexString() },
        action: 'group.created',
        before: undefined,
        after: { name: body.group.name, demo: group['demo'], dealerId: dealerId === null ? null : dealerId.toHexString(), taxes: body.taxes.length },
      });
      await recordDataChange(activityLog, {
        ...context,
        resource: { type: 'company', id: created.companyId.toHexString() },
        action: 'company.created',
        before: undefined,
        after: { name: body.company.name, status: 'active' },
      });
      await recordDataChange(activityLog, {
        ...context,
        resource: { type: 'place', id: created.placeId.toHexString() },
        action: 'place.created',
        before: undefined,
        after: { name: body.place.name, status: 'active' },
      });
      await recordDataChange(activityLog, { ...context, resource: { type: 'user', id: admin.id.toHexString() }, action: 'user.created', before: undefined, after: admin.snapshot });
      return { groupId: groupId.toHexString(), companyId: created.companyId.toHexString(), placeId: created.placeId.toHexString(), userId: admin.id.toHexString() };
    },
  };
}
