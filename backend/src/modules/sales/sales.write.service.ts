import { MongoServerError, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { Databases } from '../../db/databases.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { hasPermission } from '../../shared/security/rbac/policy.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal, StorePrincipal } from '../../shared/security/scope/principal.ts';
import type { StoreContactsAudit } from '../store-contacts/store-contacts.audit.ts';
import type { StoreContextService } from '../store-context/store-context.service.ts';
import { createCardsRepository } from '../fidelity-cards/fidelity-cards.repository.ts';
import { createContactsRepository } from '../contacts/contacts.repository.ts';
import type { NumberingService } from '../document-numbering/numbering.service.ts';
import { fiscalYearOf } from '../document-numbering/numbering.resolve.ts';
import { scaleForState } from '../loyalty/loyalty.compute.ts';
import type { LoyaltyAnomaly, LoyaltyEffects, LoyaltyState } from '../loyalty/loyalty.compute.ts';
import type { LoyaltyService } from '../loyalty/loyalty.service.ts';
import { actorOfCaller, isStoreCaller } from '../product-catalog/caller.ts';
import type { StoreCaller } from '../product-catalog/caller.ts';
import type { StockAnomaly, StockLine } from '../stock/stock.resolve.ts';
import type { StockRow } from '../stock/stock.repository.ts';
import type { StockService, StockTarget } from '../stock/stock.service.ts';
import { serverCheckOf } from './sales.check.ts';
import { salesPerimeter } from './sales.filters.ts';
import type { LineIssue } from './sales.lines.ts';
import { productIdsOf, stockEntriesOf } from './sales.lines.ts';
import {
  FLOOD_CLOUD_VERSION,
  FUTURE_TOLERANCE_MS,
  MAX_KEPT,
  bodyHashOf,
  buildSale,
  cancellationEntryOf,
  amountOf,
  cardCodeOf,
  currencyOf,
  customerOf,
  fiscalInfoOf,
  lineIssuesOf,
  listOf,
  loyaltyFactsOf,
  numberOrNull,
  objectIdOrNull,
  paymentFields,
  refundEntryOf,
  refundLineProblems,
  recordOf,
  refillOf,
  refillReturnedOf,
  refundedRatioOf,
  returnedByLine,
  saleKeyOf,
  textOrNull,
  versionOf,
} from './sales.document.ts';
import type { SaleActor, SaleAnomaly } from './sales.document.ts';
import { buildInvoiceDocument, hubOf, invoiceTypeOf, invoiceViewOf, isHubAllowed, queueRecordOf } from './sales.invoice.ts';
import type { InvoiceGuard } from './sales.invoice.guard.ts';
import { reduceInvoiceXml } from './sales.invoice.xml.ts';
import type { SaleInvoiceView } from './sales.invoice.ts';
import { createInvoiceRepository } from './sales.invoice.repository.ts';
import type { InvoiceRepository } from './sales.invoice.repository.ts';
import { storeSaleView } from './sales.store-view.ts';
import type { StoreSaleRefund, StoreSaleView } from './sales.store-view.ts';
import { createSalesWriteRepository, saleNotFound } from './sales.write.repository.ts';
import type { SalesWriteRepository } from './sales.write.repository.ts';
import type { SalesKeyIndexGuard } from './sales.key-index.ts';
import type { CancelSaleBody, CreateSaleBody, PatchSaleBody, RefundSaleBody, StoreSalesQuery } from './sales.write.schemas.ts';

/** Whoever writes a sale: the server of a point of sale (a store key) or a backoffice user (step VS4b). */
export type SalesCaller = StoreCaller | AuthPrincipal;

/** What every operation on a sale needs besides its body: the caller, the verified access, the company and the point of sale the operation is about, and the request. The point of sale is the perimeter: a sale of another one is not found. */
export interface SalesWriteContext {
  readonly caller: SalesCaller;
  readonly access: GroupAccess;
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
  readonly request: ClientContext;
  /** The store principal of the request (a store caller): the operator is looked up in the users it reads and the credit alerts name its key. `null` for a backoffice caller. */
  readonly store: StorePrincipal | null;
}

/** What the till prints after a sale: the state of the loyalty card it was paid with after the sale. */
export interface SaleFidelity {
  readonly cardCode: string;
  /** The credit of an advanced card after the sale; `null` for a simple card or a code no card has. */
  readonly balance: number | null;
  /** The points of the card after the sale, by collection (`collectionId` is `null` for a simple card). */
  readonly points: readonly { readonly collectionId: string | null; readonly points: number }[];
}

/** The answer to the creation of a sale. */
export interface SaleCreated {
  readonly id: string;
  readonly timestampId: string;
  readonly date: string | null;
  readonly receiptType: StoreSaleView['receiptType'];
  readonly nonFiscal: boolean;
  readonly fiscalState: StoreSaleView['fiscalState'];
  readonly number: { readonly report: number | null; readonly number: number | null } | null;
  readonly total: number;
  readonly checks: StoreSaleView['checks'];
  readonly fidelity: SaleFidelity | null;
  /** The invoice document of a sale of type `invoice` (its id, the number as printed, the year and whether it went to the send queue); `null` for any other sale, or when the sale could not be given one (the anomaly says why). */
  readonly invoice: SaleInvoiceView | null;
  /** The version of the sale (its `ETag`). */
  readonly version: string;
}

/** The answer to the creation of a sale whose key belongs to a sale that was deleted (a quote the till reworked): `200`, nothing is made, and the till learns the sale is gone. */
export interface SaleDeletedNotice {
  readonly status: 'deleted';
  /** The id the deleted sale had. */
  readonly saleId: string;
  readonly timestampId: string;
}

/** The business rules of the sales the points of sale (and, later, the backoffice) write. Nothing here is refused for a business rule: the till is right, the server records what differs. */
export interface SalesWriteService {
  /**
   * Creates a sale, or finds the one this `timestampId` of this point of sale already made (also when the legacy wrote it): the answer is then the original one with `created: false`, and a body that differs from the first is recorded
   * in the sale as the anomaly `duplicateDiffers`. In one transaction of the group it saves the sale in the legacy shape, moves the warehouse (`stock`), applies the loyalty effects (`loyalty`), recomputes the arithmetic (`serverCheck`)
   * and keeps every anomaly of the sources in `floodCloud.anomalies`.
   *
   * A key whose sale was deleted (the tombstone of the deletion) is never made again: the answer is `{ created: false, result: { status: 'deleted', saleId, timestampId } }`, with no effect at all.
   *
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the unique index of the key of the sales could not be created (no sale is saved without it).
   */
  create(ctx: SalesWriteContext, body: CreateSaleBody): Promise<{ readonly created: boolean; readonly result: SaleCreated | SaleDeletedNotice }>;
  /**
   * Amends a sale: the payments (merged), the customer, the loyalty card, the fiscal receipt, the lottery code and the operator. The lines and totals never change. A change of customer, card or credit reconciles the loyalty; the same patch again writes nothing.
   *
   * @param expected The version of `If-Match`, when the caller sent one.
   * @throws {AppError} `NOT_FOUND` (not a sale of this point of sale), `PRECONDITION_FAILED` when `expected` is not the version of the sale.
   */
  amend(ctx: SalesWriteContext, id: ObjectId, body: PatchSaleBody, expected: string | null): Promise<StoreSaleView>;
  /**
   * Adds a refund (whole or partial, repeatable): the same `timestampId` returns the refund already registered. The warehouse loads back the quantities returned and the loyalty takes away the points in proportion.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `VALIDATION_ERROR` for a position that is not a line of the sale or a product that is not the one of the line, `CONFLICT` (`refund` / `refundsLimit`) when the sale already has {@link MAX_REFUNDS} entries in `refund[]` (a bound of the storage of the document, not a rule of the business).
   */
  refund(ctx: SalesWriteContext, id: ObjectId, body: RefundSaleBody, expected: string | null): Promise<{ readonly created: boolean; readonly sale: StoreSaleView; readonly refund: StoreSaleRefund }>;
  /**
   * Cancels a sale: idempotent by state (a sale already canceled is returned as it is). Everything the sale did to the warehouse and to the loyalty cards, refills included, is reversed.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` (`refund` / `refundsLimit`) as for a refund.
   */
  cancel(ctx: SalesWriteContext, id: ObjectId, body: CancelSaleBody, expected: string | null): Promise<{ readonly created: boolean; readonly sale: StoreSaleView }>;
  /**
   * Deletes a sale that is not fiscal (a quote the till reworks), after reversing everything it did to the warehouse and to the loyalty cards, and leaves a tombstone of its key in the same transaction. A sale is deleted only when its `sType` is exactly `true` and it has no fiscal receipt number and is not gathered in an invoice.
   *
   * @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` with the issue `fiscal` or `invoiced`.
   */
  remove(ctx: SalesWriteContext, id: ObjectId, expected: string | null): Promise<void>;
  /** One sale of the point of sale. @throws {AppError} `NOT_FOUND`. */
  get(ctx: SalesWriteContext, id: ObjectId): Promise<StoreSaleView>;
  /** The sales of the point of sale that match a search (by `timestampId`, by the numbers of the fiscal receipt, or the last ones of a customer), at most `limit`. */
  search(ctx: SalesWriteContext, query: StoreSalesQuery): Promise<StoreSaleView[]>;
}

/** The repositories and services of one transaction. */
interface Tx {
  readonly repo: SalesWriteRepository;
  readonly stock: StockService;
  readonly loyalty: LoyaltyService;
  readonly invoices: InvoiceRepository;
  readonly numbering: NumberingService;
  readonly databases: Databases;
}

/** What the transaction of a creation hands over about the invoice of the sale: what the till shows, and what must be sent to the queue after the commit (`null` when nothing). */
interface InvoiceOutcome {
  readonly view: SaleInvoiceView;
  readonly queue: { readonly document: Document; readonly dealerId: ObjectId | null } | null;
}

/** Two deferred invoices that gather the same unpaid sales at the same moment: the one that lost starts again and finds them gathered. */
class UnpaidRace extends Error {}

/** Collaborators of {@link createSalesWriteService}. */
export interface SalesWriteDeps {
  readonly databases: Databases;
  /** The unique index of the key of the sales: asked for before a transaction opens. */
  readonly keyIndex: SalesKeyIndexGuard;
  /** The stock service that holds no transaction, to ask for its index before one opens. */
  readonly stock: Pick<StockService, 'ensureIndex'>;
  /** Builds the stock service joined to a transaction (`nested`). */
  readonly stockOver: (databases: Databases) => StockService;
  /** Builds the loyalty service joined to a transaction (`nested`). */
  readonly loyaltyOver: (databases: Databases) => LoyaltyService;
  /** The numbering service that holds no transaction, to ask for its indexes before one opens (the sales of type `invoice`). */
  readonly numbering: Pick<NumberingService, 'ensureIndexes'>;
  /** Builds the numbering service joined to a transaction (`nested`). */
  readonly numberingOver: (databases: Databases) => NumberingService;
  /** The budget of the invoices of a store key and the alert of its day. */
  readonly invoiceGuard: InvoiceGuard;
  /** Builds the repository of the invoice documents over a database accessor (the default builds the real one; a test wraps it). */
  readonly invoicesOver?: (databases: Databases) => InvoiceRepository;
  readonly activityLog: ActivityLog;
  /** The credit alert (`store.creditAlert`) of a store key or of a backoffice user, the same thresholds as the loyalty cards of the contacts. */
  readonly audit: Pick<StoreContactsAudit, 'creditAdded' | 'creditAddedByUser'>;
  /** The users the store reads from `GET /store-context/users`: the only ones an operator can be. */
  readonly storeUsers: Pick<StoreContextService, 'findUser'>;
  readonly logger: Logger;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  readonly newId?: () => ObjectId;
  /** Builds the repository over a database accessor (the default builds the real one; a test wraps it). */
  readonly repositoryOver?: (databases: Databases) => SalesWriteRepository;
}

/** Most elements `refund[]` of a sale may have: a bound of the size of the document, not a rule of the business (a cancellation is one of them). */
export const MAX_REFUNDS = 200;

const OPERATIONS = ['create', 'amend', 'refund', 'cancel', 'delete'] as const;
type Operation = (typeof OPERATIONS)[number];

const isObject = (raw: unknown): raw is Document => typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !(raw instanceof ObjectId) && !(raw instanceof Date);

/** Whether two stored values are the same, ignoring the order of the keys (dates and ids by their text). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function canonical(value: unknown): unknown {
  const plain: unknown = JSON.parse(JSON.stringify(value ?? null));
  const sort = (item: unknown): unknown => (Array.isArray(item) ? item.map(sort) : isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item);
  return sort(plain);
}

/** The anomalies of the sources, in the shape the sale keeps. */
function anomaliesOf(operation: Operation, at: Date, stock: readonly StockAnomaly[], loyalty: readonly LoyaltyAnomaly[]): SaleAnomaly[] {
  return [
    ...stock.map((anomaly): SaleAnomaly => ({ at, operation, source: 'stock', code: anomaly.code, ...('productId' in anomaly ? { productId: anomaly.productId } : {}), ...('type' in anomaly ? { type: anomaly.type } : {}) })),
    ...loyalty.map((anomaly): SaleAnomaly => ({ at, operation, source: 'loyalty', code: anomaly.code, ...(anomaly.collectionId === undefined ? {} : { collectionId: anomaly.collectionId }) })),
  ];
}

/**
 * Builds the service of the writes of the sales.
 *
 * @param deps The collaborators.
 */
export function createSalesWriteService(deps: SalesWriteDeps): SalesWriteService {
  const { databases, keyIndex, activityLog, logger } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const repositoryOver = deps.repositoryOver ?? createSalesWriteRepository;
  const invoicesOver = deps.invoicesOver ?? createInvoiceRepository;
  const nowDate = (): Date => new Date(deps.now());

  /** Runs `work` in a transaction on the cluster of the group, over the repositories and services joined to it (the driver may repeat `work`: it keeps nothing between attempts but its result). */
  const run = <T>(ctx: SalesWriteContext, work: (tx: Tx) => Promise<T>): Promise<T> =>
    inGroupTransaction(ctx.caller, ctx.access, databases, (session) => {
      const dbs = sessionDatabases(databases, session, ctx.access.groupId);
      return work({ repo: repositoryOver(dbs), stock: deps.stockOver(dbs), loyalty: deps.loyaltyOver(dbs), invoices: invoicesOver(dbs), numbering: deps.numberingOver(dbs), databases: dbs });
    });

  /** The indexes a write needs, outside any transaction: the unique key of the sales (no sale is saved without it) and the origins of the warehouse. */
  const prepare = async (ctx: SalesWriteContext, invoice = false): Promise<void> => {
    if (!(await keyIndex.ensure(ctx.caller, ctx.access))) {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
    await deps.stock.ensureIndex(ctx.caller, ctx.access);
    if (invoice) {
      // No number is given without the unique index of the counters: the sale of an invoice is not made then.
      try {
        await deps.numbering.ensureIndexes(ctx.caller, ctx.access);
      } catch (error) {
        logger.error('the indexes of the numbering of the invoices are not available', { error });
        throw new AppError('SERVICE_UNAVAILABLE');
      }
    }
  };

  const actorOf = (ctx: SalesWriteContext): SaleActor => (isStoreCaller(ctx.caller) ? { kind: 'store', storeKeyId: ctx.caller.keyId } : { kind: 'user', userId: (ctx.caller as AuthPrincipal).userId });

  /** The user a write is made by: the operator the point of sale declared when he is a user of the group (an unknown one is never saved), the user for a backoffice caller. */
  const operatorOf = async (ctx: SalesWriteContext, declared: ObjectId | null | undefined): Promise<{ readonly userId: ObjectId | null; readonly anomalies: string[] }> => {
    if (!isStoreCaller(ctx.caller)) {
      return { userId: (ctx.caller as AuthPrincipal).userId, anomalies: [] };
    }
    if (declared === undefined || declared === null) {
      return { userId: null, anomalies: [] };
    }
    // Only a user of the set the store reads from `GET /store-context/users` can be an operator.
    const found = await deps.storeUsers.findUser(ctx.store!, ctx.access, declared);
    return found === null ? { userId: null, anomalies: ['operatorUnknown'] } : { userId: declared, anomalies: found.status === 'active' ? [] : ['operatorInactive'] };
  };

  /** Who the movements of the warehouse and of the cards are made by: the store key with the operator it declared, or the authenticated user himself, whatever the sale's own cashier (`userId`) is. */
  const effectsActor = (ctx: SalesWriteContext, userId: ObjectId | null): { readonly userId: ObjectId | null; readonly storeKeyId?: ObjectId } => (isStoreCaller(ctx.caller) ? { userId, storeKeyId: ctx.caller.keyId } : { userId: (ctx.caller as AuthPrincipal).userId });

  /** A backoffice user who moves the credit of an advanced card (refills, credit used, a card changed) needs also the right to change the loyalty cards (`fidelity:update`): `403` otherwise. The till has the credit it is given. */
  const assertCreditRight = (ctx: SalesWriteContext): void => {
    if (!isStoreCaller(ctx.caller) && !hasPermission(ctx.caller as AuthPrincipal, 'fidelity:update')) {
      throw new AppError('FORBIDDEN');
    }
  };

  /** The `floodCloud` anomaly of an invoice. */
  const invoiceAnomaly = (at: Date, code: string, extra: Pick<SaleAnomaly, 'ids' | 'fields'> = {}): SaleAnomaly => ({ at, operation: 'create', source: 'sale', code, ...extra });

  /** What the backoffice is refused, with the positions: a user who sends something wrong is told (`422`), the till (which is right) only gets an anomaly. */
  const refuse = (ctx: SalesWriteContext, problems: readonly ErrorDetail[]): void => {
    if (problems.length > 0 && !isStoreCaller(ctx.caller)) {
      throw new AppError('VALIDATION_ERROR', { details: problems });
    }
  };

  /**
   * Makes the invoice of a sale of type `invoice`, in the transaction of the sale. Before anything is written it judges the sale: with no customer, or a date outside the window of the invoices (from the 1st of January of the previous year to tomorrow), there is **no number and no
   * document** (the sale is saved with the anomaly; the backoffice is refused with `422`). Then: the unpaid sales it gathers (claimed atomically, within the perimeter of the writer), its number and sectional, its `progressivo_invio` (only when its hub may carry the invoices of the group),
   * and the document with the copies of the company and of the customer read from the database and the `XML` of the till checked by domain. The sale keeps the reference in `floodCloud.invoice` and the anomalies. `degraded` is the last attempt of a till after a lost race on the unpaid sales:
   * it gathers none and says so.
   */
  const makeInvoice = async (tx: Tx, ctx: SalesWriteContext, body: CreateSaleBody, sale: Document, at: Date, degraded: boolean): Promise<{ readonly sale: Document; readonly invoice: InvoiceOutcome | null }> => {
    const found: SaleAnomaly[] = [];
    const problems: ErrorDetail[] = [];
    const store = isStoreCaller(ctx.caller);
    const withFound = (): Document => {
      const cloud = sale['floodCloud'] as Document;
      return { ...sale, floodCloud: { ...cloud, anomalies: [...listOf(cloud['anomalies']), ...found].slice(-MAX_KEPT) } };
    };
    const company = await tx.invoices.findCompany(ctx.caller, ctx.access, ctx.companyId);
    if (company === null) {
      found.push(invoiceAnomaly(at, 'invoiceCompanyMissing'));
      return { sale: withFound(), invoice: null };
    }
    const contactId = body.customer?.contactId ?? null;
    const counterpart = contactId === null ? null : await tx.invoices.findCounterpart(ctx.caller, ctx.access, contactId);
    if (counterpart === null) {
      refuse(ctx, [{ field: 'customer', issue: 'incorrect' }]);
      found.push(invoiceAnomaly(at, 'invoiceCounterpartMissing'));
      return { sale: withFound(), invoice: null };
    }
    // The date of an invoice is in a window: not before the 1st of January of the previous year (time zone of the point of sale), not after tomorrow. Outside it nothing is numbered.
    const fiscal = fiscalYearOf(at, await tx.invoices.findTimeZone(ctx.caller, ctx.access, ctx.companyId, ctx.placeId));
    const windowStart = fiscalYearOf(new Date(fiscal.start.getTime() - 1), fiscal.timeZone).start;
    if (body.date.getTime() < windowStart.getTime() || body.date.getTime() > at.getTime() + FUTURE_TOLERANCE_MS) {
      refuse(ctx, [{ field: 'date', issue: 'outOfRange' }]);
      found.push(invoiceAnomaly(at, 'invoiceDateOutOfRange'));
      return { sale: withFound(), invoice: null };
    }
    const requested = [...new Map((body.unpaidSaleIds ?? []).map((id) => [id.toHexString(), id])).values()];
    const type = invoiceTypeOf(body.invoice?.type, requested.length > 0);
    if (type === 'TD24' && requested.length === 0) {
      problems.push({ field: 'invoice.type', issue: 'incorrect' });
      found.push(invoiceAnomaly(at, 'invoiceTypeWithoutUnpaid'));
    }
    // The `XML` of the till, checked by domain: what is out of it is left out (anomaly) or refused (backoffice).
    const reduced = reduceInvoiceXml(body.invoice?.xml, { company, counterpart });
    for (const code of ['invoiceXmlInvalid', 'invoiceIbanUnknown', 'invoiceSplitPaymentDenied'] as const) {
      const fields = reduced.issues.filter((issue) => issue.code === code).map((issue) => issue.path);
      if (fields.length > 0) {
        problems.push(...fields.map((field) => ({ field: `invoice.xml.${field}`, issue: code === 'invoiceXmlInvalid' ? 'incorrect' : code === 'invoiceIbanUnknown' ? 'unknownIban' : 'notAllowed' })));
        found.push(invoiceAnomaly(at, code, { fields }));
      }
    }
    refuse(ctx, problems);
    // The hub: an invoice goes to the queue only through a hub that may carry the invoices of the group (a dealer's hub only for that dealer's groups).
    const hub = hubOf(company);
    const dealerId = hub === null ? null : await tx.invoices.findDealerId(ctx.access);
    const send = hub !== null && isHubAllowed(hub, dealerId);
    if (hub !== null && !send) {
      found.push(invoiceAnomaly(at, 'invoiceHubMismatch'));
    }
    // The unpaid sales a deferred invoice gathers: the ones that qualify (same company and customer, within the perimeter of the writer) are marked in this transaction, atomically; the others are left alone.
    const gathered: string[] = [];
    if (requested.length > 0 && degraded) {
      found.push(invoiceAnomaly(at, 'unpaidSaleRace', { ids: requested.map((id) => id.toHexString()) }));
    } else if (requested.length > 0) {
      const scope: Document = store ? { placeId: { $in: [ctx.placeId, ctx.placeId.toHexString()] } } : salesPerimeter((ctx.caller as AuthPrincipal).scope);
      const criteria = { companyId: ctx.companyId, customerId: contactId!, scope };
      const valid = await tx.repo.findGatherable(ctx.caller, ctx.access, requested, criteria);
      const validHex = new Set(valid.map((id) => id.toHexString()));
      const invalid = requested.filter((id) => !validHex.has(id.toHexString()));
      if (invalid.length > 0) {
        const invalidHex = new Set(invalid.map((id) => id.toHexString()));
        if (!store) {
          throw new AppError('CONFLICT', { details: (body.unpaidSaleIds ?? []).flatMap((id, index) => (invalidHex.has(id.toHexString()) ? [{ field: `unpaidSaleIds.${String(index)}`, issue: 'invalid' }] : [])) });
        }
        found.push(invoiceAnomaly(at, 'unpaidSaleInvalid', { ids: invalid.map((id) => id.toHexString()) }));
      }
      if (valid.length > 0 && (await tx.repo.gather(ctx.caller, ctx.access, valid, criteria, at)) !== valid.length) {
        throw new UnpaidRace();
      }
      gathered.push(...valid.map((id) => id.toHexString()));
    }
    const reservation = await tx.numbering.reserveNumber(ctx.caller, ctx.access, { companyId: ctx.companyId, placeId: ctx.placeId, series: 'invoice', date: body.date });
    found.push(...reservation.anomalies.map((anomaly) => invoiceAnomaly(at, anomaly.code)));
    // The progressive of the sending only for an invoice that goes to the queue (the others consume none).
    const progressive = send ? await tx.numbering.reserveSendProgressive(ctx.caller, ctx.access, { companyId: ctx.companyId, placeId: ctx.placeId, date: body.date }) : null;
    const documentId = newId();
    const document = buildInvoiceDocument({
      documentId,
      sale,
      reservation,
      progressive: progressive === null ? null : progressive.progressive,
      type,
      company,
      counterpart,
      storageId: await tx.invoices.findCashStorage(ctx.caller, ctx.access, ctx.placeId),
      xml: reduced.xml,
      unpaidIds: gathered,
      sendStatus: hub === null ? null : 'notQueued',
      groupId: send ? ctx.access.groupId : null,
      now: at,
    });
    await tx.invoices.insert(ctx.caller, ctx.access, document);
    const marked = withFound();
    const cloud = marked['floodCloud'] as Document;
    return {
      sale: { ...marked, floodCloud: { ...cloud, invoice: { documentId, number: reservation.number, prefixSuffix: reservation.prefixSuffix, year: reservation.year } } },
      invoice: { view: invoiceViewOf(document, reservation.year), queue: send ? { document, dealerId } : null },
    };
  };

  /** The invoice a sale already has, for a repetition of its creation: the same document and number, never a new one. A document of this backend that never reached the queue (it was meant for it: it has a `progressivo_invio`) and has no mark of an attempt is queued again. */
  const existingInvoice = async (tx: Tx, ctx: SalesWriteContext, sale: Document): Promise<InvoiceOutcome | null> => {
    if (sale['receiptType'] !== 'invoice') {
      return null;
    }
    const document = await tx.invoices.findOfSale(ctx.caller, ctx.access, sale);
    if (document === null) {
      return null;
    }
    const reference = recordOf(recordOf(sale['floodCloud'])['invoice']);
    const again = reference['documentId'] !== undefined && reference['queuedAt'] === undefined && document['sendStatus'] === 'notQueued' && document['counterpart'] != null && typeof recordOf(document['fattura_elettronica'])['progressivo_invio'] === 'number';
    return { view: invoiceViewOf(document, numberOrNull(reference['year'])), queue: again ? { document, dealerId: await tx.invoices.findDealerId(ctx.access) } : null };
  };

  /**
   * Hands the record of an invoice to the send queue, after the sale was committed (the document always exists before it is in the queue), **at most once**: first the sale records the attempt (`floodCloud.invoice.queuedAt`, a write that only one caller wins), then the record is
   * written (idempotent on the `_id` of the document), then the document moves to `queued`. Never an error: the sale is saved. If the queue refuses, the mark is taken back so a repetition of the sale tries again; if taking it back fails, the mark stays and the document stays
   * `notQueued` for the backoffice to see (the safe side: an invoice is never queued twice). A failure is logged without data.
   */
  const enqueue = async (ctx: SalesWriteContext, sale: Document, queue: NonNullable<InvoiceOutcome['queue']>): Promise<string> => {
    const repository = repositoryOver(databases);
    const saleId = sale['_id'] as ObjectId;
    const documentId = queue.document['_id'] as ObjectId;
    try {
      if (!(await repository.markQueued(ctx.caller, ctx.access, saleId, nowDate()))) {
        // Another request is queueing it (or did): nothing to do here.
        return queue.document['sendStatus'] as string;
      }
    } catch (error) {
      logger.error('marking an invoice for the send queue failed', { error });
      return 'notQueued';
    }
    try {
      await databases.queueInbox().enqueue(queueRecordOf(queue.document, sale, queue.dealerId) as Document & { _id: ObjectId });
    } catch (error) {
      logger.error('handing an invoice to the send queue failed', { error });
      try {
        await repository.unmarkQueued(ctx.caller, ctx.access, saleId);
      } catch (releaseError) {
        logger.error('taking back the mark of an invoice for the send queue failed', { error: releaseError });
      }
      return 'notQueued';
    }
    try {
      await invoicesOver(databases).moveSendStatus(ctx.caller, ctx.access, documentId, 'notQueued', 'queued');
    } catch (error) {
      logger.error('marking an invoice as queued failed', { error });
    }
    return 'queued';
  };

  /** The state the warehouse and the loyalty want for a sale as it is now. */
  const stateOf = (sale: Document): LoyaltyState => {
    if (sale['fiscalState'] === 'canceled') {
      return { kind: 'canceled' };
    }
    const ratio = refundedRatioOf(sale);
    const refillReturned = refillReturnedOf(sale);
    return ratio > 0 || refillReturned > 0 ? { kind: 'refunded', refundedRatio: ratio, refillReturned } : { kind: 'active' };
  };

  const stockTargetOf = (ctx: SalesWriteContext, sale: Document, date: Date): StockTarget | null => {
    if (sale['fiscalState'] === 'canceled') {
      return null;
    }
    const { unload, load } = stockEntriesOf(listOf(sale['products']), returnedByLine(sale));
    return { companyId: ctx.companyId, placeId: ctx.placeId, date, unload: unload as StockLine[], load: load as StockLine[] };
  };

  /**
   * The loyalty effects of a whole sale. A `partitioned` sale (the mother of a split table: it holds the products, the fiscal receipts are its parts) has none: the points accrue on the parts. `asStored` works them out with the legacy formulas on the facts as stored, to adopt a
   * sale of the legacy.
   */
  const effectsOf = async (tx: Tx, ctx: SalesWriteContext, sale: Document, asStored: boolean): Promise<{ readonly effects: LoyaltyEffects | null; readonly anomalies: LoyaltyAnomaly[] }> => {
    if (sale['receiptType'] === 'partitioned') {
      return { effects: null, anomalies: [] };
    }
    const computed = asStored
      ? await tx.loyalty.legacyLoyaltyOfSale(ctx.caller, ctx.access, loyaltyFactsOf(sale, true), cardCodeOf(sale), currencyOf(sale))
      : await tx.loyalty.loyaltyOfSale(ctx.caller, ctx.access, loyaltyFactsOf(sale), cardCodeOf(sale), currencyOf(sale));
    return { effects: computed.effects.advanced === null && computed.effects.simple === null ? null : computed.effects, anomalies: computed.anomalies };
  };

  /** The sale with the container of this backend: the first operation of the new backend on a sale of the legacy adopts it, with the state the legacy already applied (decision 4 of the contract: the warehouse from its movements, the loyalty from the facts saved). */
  const adopted = async (tx: Tx, ctx: SalesWriteContext, sale: Document, at: Date): Promise<Document> => {
    if (sale['floodCloud'] !== undefined) {
      return sale;
    }
    const canceled = sale['fiscalState'] === 'canceled';
    const stockBaseline: StockRow[] = canceled ? [] : await tx.stock.legacyBaseline(ctx.caller, ctx.access, sale['_id'] as ObjectId);
    const { effects, anomalies: found } = await effectsOf(tx, ctx, sale, true);
    const anomalies: SaleAnomaly[] = [{ at, operation: 'amend', source: 'sale', code: 'legacyStateApproximated' }, ...anomaliesOf('amend', at, [], found)];
    return {
      ...sale,
      floodCloud: {
        v: FLOOD_CLOUD_VERSION,
        createdBy: { kind: 'legacy' },
        serverCheck: null,
        anomalies,
        loyalty: { applied: canceled ? null : effects, full: effects, cardCode: cardCodeOf(sale) },
        operations: [],
        legacy: { adoptedAt: at, stockBaseline, refundCount: listOf(sale['refund']).length },
        cancellation: null,
      },
    };
  };

  /** What the till prints of the card after the sale: the credit and the points of the advanced card, or the points of the contact that has the simple one. */
  const fidelityOf = async (tx: Tx, ctx: SalesWriteContext, sale: Document, applied: LoyaltyEffects | null): Promise<SaleFidelity | null> => {
    const code = cardCodeOf(sale);
    if (code === null) {
      return null;
    }
    if (applied !== null && applied.advanced !== null) {
      const cardId = applied.advanced.cardId;
      // The card the sale applied, by its id (never by code: codes may differ by spaces); a card that is gone shows nothing.
      const found = recordOf(await createCardsRepository(tx.databases).findById(ctx.caller, ctx.access, cardId));
      const points = Object.entries(recordOf(found['pointsCollections'])).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
      return { cardCode: code, balance: numberOrNull(found['balance']), points: points.map(([collectionId, value]) => ({ collectionId, points: value })) };
    }
    if (applied !== null && applied.simple !== null && applied.simple.contactId !== undefined) {
      const held = listOf(recordOf(await createContactsRepository(tx.databases).cardsOf(ctx.caller, ctx.access, applied.simple.contactId))['fidelities']).find((candidate) => candidate['code'] === code);
      return { cardCode: code, balance: null, points: [{ collectionId: null, points: amountOf(recordOf(held)['points']) }] };
    }
    return { cardCode: code, balance: null, points: [] };
  };

  /**
   * Brings the warehouse and the loyalty cards of a sale to the state it has now (in memory: the caller writes it) and returns the container of this backend updated with it. `recompute` works out the loyalty effects of the whole sale again (a
   * customer, a card or a credit changed); otherwise the ones saved are scaled to the state.
   */
  const settle = async (
    tx: Tx,
    ctx: SalesWriteContext,
    sale: Document,
    options: { readonly operation: Operation; readonly at: Date; readonly date: Date; readonly userId: ObjectId | null; readonly recompute: boolean; readonly extra: readonly SaleAnomaly[]; readonly reference: string | null; readonly deleting?: true },
  ): Promise<{ readonly cloud: Document; readonly anomalies: SaleAnomaly[]; readonly applied: LoyaltyEffects | null }> => {
    const cloud = sale['floodCloud'] as Document;
    const saved = recordOf(cloud['loyalty']);
    const legacy = recordOf(cloud['legacy']);
    const actor = effectsActor(ctx, options.userId);
    const origin = { kind: 'sale' as const, id: sale['_id'] as ObjectId };
    const settled = options.deleting === true ? { ...sale, fiscalState: 'canceled' } : sale;
    const stock = await tx.stock.reconcileOrigin(ctx.caller, ctx.access, origin, stockTargetOf(ctx, settled, options.date), actor, (Array.isArray(legacy['stockBaseline']) ? legacy['stockBaseline'] : []) as StockRow[]);
    let full = (saved['full'] ?? null) as LoyaltyEffects | null;
    const found: LoyaltyAnomaly[] = [];
    if (options.recompute) {
      const computed = await effectsOf(tx, ctx, sale, false);
      full = computed.effects;
      found.push(...computed.anomalies);
    }
    const customer = objectIdOrNull(recordOf(sale['customer'])['_id']);
    const desired = full === null ? null : scaleForState(full, options.deleting === true ? { kind: 'canceled' } : stateOf(sale));
    const loyalty = await tx.loyalty.reconcileSaleLoyalty(ctx.caller, ctx.access, { saleId: origin.id, customerId: customer, date: sale['date'] as Date }, desired, (saved['applied'] ?? null) as LoyaltyEffects | null, actor);
    const anomalies = [...options.extra, ...anomaliesOf(options.operation, options.at, stock.anomalies, [...found, ...loyalty.anomalies])];
    const previous = listOf(cloud['anomalies']) as unknown as SaleAnomaly[];
    const operations = listOf(cloud['operations']);
    return {
      anomalies,
      applied: loyalty.applied,
      cloud: {
        ...cloud,
        anomalies: [...previous, ...anomalies].slice(-MAX_KEPT),
        loyalty: { applied: loyalty.applied, full, cardCode: cardCodeOf(sale) },
        operations: [...operations, { kind: options.operation, at: options.at, by: actorOf(ctx), ref: options.reference }].slice(-MAX_KEPT),
      },
    };
  };

  /** Reads a sale of the point of sale, checks the version the caller read and adopts it when the legacy wrote it. */
  const load = async (tx: Tx, ctx: SalesWriteContext, id: ObjectId, expected: string | null): Promise<Document> => {
    const sale = await tx.repo.findOfPlace(ctx.caller, ctx.access, ctx.placeId, id);
    if (sale === null) {
      throw saleNotFound();
    }
    if (expected !== null && expected !== versionOf(sale)) {
      throw new AppError('PRECONDITION_FAILED');
    }
    return sale;
  };

  /** Refuses (`409`) a write that would take `refund[]` of a sale beyond {@link MAX_REFUNDS}: a refund also leaves the place of the cancellation. */
  const assertRefundRoom = (sale: Document, adds: number): void => {
    if (listOf(sale['refund']).length + adds > MAX_REFUNDS) {
      throw new AppError('CONFLICT', { details: [{ field: 'refund', issue: 'refundsLimit' }] });
    }
  };

  /** Writes the change of a sale and returns it as the store sees it. */
  const write = async (tx: Tx, ctx: SalesWriteContext, sale: Document, set: Document): Promise<Document> => {
    if (!(await tx.repo.update(ctx.caller, ctx.access, sale['_id'] as ObjectId, { $set: set }))) {
      throw saleNotFound();
    }
    return { ...sale, ...set };
  };

  const record = async (ctx: SalesWriteContext, action: 'sale.created' | 'sale.amended' | 'sale.refunded' | 'sale.canceled' | 'sale.deleted', sale: Document, userId: ObjectId | null, metadata: Readonly<Record<string, string | number | boolean | null>>): Promise<void> => {
    try {
      await recordDataChange(activityLog, {
        action,
        actor: actorOfCaller(ctx.caller),
        groupId: ctx.access.groupId,
        resource: { type: 'sale', id: (sale['_id'] as ObjectId).toHexString() },
        before: undefined,
        after: undefined,
        requestId: ctx.request.requestId,
        ...(ctx.request.ip === null ? {} : { ip: ctx.request.ip }),
        metadata: { timestampId: textOrNull(sale['timestampId']), ...metadata, ...(isStoreCaller(ctx.caller) && userId !== null ? { operatorId: userId.toHexString() } : {}) },
      });
    } catch (error) {
      logger.error('recording the activity of a sale failed', { error });
    }
  };

  /** The alert of the credit a store sale added to an advanced card (its refills): never an error, the sale is saved already. */
  const alertCredit = async (ctx: SalesWriteContext, sale: Document, userId: ObjectId | null, applied: LoyaltyEffects | null): Promise<void> => {
    if (applied === null || applied.advanced === null) {
      return;
    }
    try {
      const cardId = applied.advanced.cardId.toHexString();
      await (ctx.store === null
        ? deps.audit.creditAddedByUser(ctx.caller as AuthPrincipal, ctx.access.groupId, ctx.request, cardId, refillOf(sale))
        : deps.audit.creditAdded(ctx.store, userId === null ? null : { id: userId }, ctx.request, cardId, refillOf(sale)));
    } catch (error) {
      logger.error('raising the credit alert of a sale failed', { error });
    }
  };

  /** A write of the backoffice, unlike one of the till, can be refused for a state that does not allow it (the till is right, a user corrects a record): `409` with the issue. */
  const refuseIf = (ctx: SalesWriteContext, condition: boolean, field: string, issue: string): void => {
    if (condition && !isStoreCaller(ctx.caller)) {
      throw new AppError('CONFLICT', { details: [{ field, issue }] });
    }
  };

  /** Whether a settlement changed the credit of an advanced card (what the sale had applied before and what it applies now differ in the balance): a refund or a cancellation that touches only points moves none. */
  const creditMoved = (sale: Document, now: LoyaltyEffects | null): boolean => {
    const was = (recordOf(recordOf(sale['floodCloud'])['loyalty'])['applied'] ?? null) as LoyaltyEffects | null;
    return (was?.advanced?.balance ?? 0) !== (now?.advanced?.balance ?? 0);
  };

  const anomalyCount = (sale: Document): number => listOf(recordOf(sale['floodCloud'])['anomalies']).length;

  const createdOf = (sale: Document, fidelity: SaleFidelity | null, invoice: SaleInvoiceView | null): SaleCreated => {
    const view = storeSaleView(sale);
    return {
      id: view.id,
      timestampId: String(sale['timestampId']),
      date: view.date,
      receiptType: view.receiptType,
      nonFiscal: view.nonFiscal,
      fiscalState: view.fiscalState,
      number: view.fiscalReceiptInfo === null ? null : { report: view.fiscalReceiptInfo.report, number: view.fiscalReceiptInfo.number },
      total: view.totals.total,
      checks: view.checks,
      fidelity,
      invoice,
      version: view.version,
    };
  };

  /** One attempt of the creation: finds the sale of the key or makes it, all in one transaction. */
  const createOnce = async (ctx: SalesWriteContext, body: CreateSaleBody, degraded: boolean): Promise<{ readonly created: boolean; readonly sale: Document | null; readonly deleted: ObjectId | null; readonly fidelity: SaleFidelity | null; readonly userId: ObjectId | null; readonly applied: LoyaltyEffects | null; readonly invoice: InvoiceOutcome | null }> =>
    run(ctx, async (tx) => {
      const at = nowDate();
      const hash = bodyHashOf(body);
      const existing = await tx.repo.findByKey(ctx.caller, ctx.access, ctx.placeId, body.timestampId);
      if (existing !== null) {
        const cloud = recordOf(existing['floodCloud']);
        const anomalies = listOf(cloud['anomalies']) as unknown as SaleAnomaly[];
        let sale = existing;
        if (typeof cloud['bodyHash'] === 'string' && cloud['bodyHash'] !== hash && !anomalies.some((anomaly) => anomaly.code === 'duplicateDiffers')) {
          sale = await write(tx, ctx, existing, { floodCloud: { ...cloud, anomalies: [...anomalies, { at, operation: 'create', source: 'sale', code: 'duplicateDiffers' } satisfies SaleAnomaly].slice(-MAX_KEPT) } });
        }
        const applied = (recordOf(cloud['loyalty'])['applied'] ?? null) as LoyaltyEffects | null;
        return { created: false, sale, deleted: null, fidelity: await fidelityOf(tx, ctx, sale, applied), userId: null, applied, invoice: await existingInvoice(tx, ctx, sale) };
      }
      // A key whose sale was deleted is never made again, whatever the body says: the till learns the sale is gone, and nothing else happens.
      const tombstone = await tx.repo.findTombstone(ctx.caller, ctx.access, saleKeyOf(ctx.placeId, body.timestampId));
      if (tombstone !== null) {
        return { created: false, sale: null, deleted: tombstone.saleId, fidelity: null, userId: null, applied: null, invoice: null };
      }
      const catalog = new Map((await tx.repo.findCatalog(ctx.caller, ctx.access, productIdsOf(body.products))).map((product) => [product._id.toHexString(), product]));
      const contact = body.customer === undefined || body.customer === null ? null : await tx.repo.findContact(ctx.caller, ctx.access, body.customer.contactId);
      const operator = await operatorOf(ctx, body.operatorId);
      const id = newId();
      const built = buildSale({ body, id, companyId: ctx.companyId, placeId: ctx.placeId, userId: operator.userId, now: at, catalog, contact, customerNamed: body.customer !== undefined && body.customer !== null, createdBy: actorOf(ctx), operatorAnomalies: operator.anomalies });
      const check = serverCheckOf(built.sale, built.lineIssues, at);
      const sale: Document = { ...built.sale, floodCloud: { v: FLOOD_CLOUD_VERSION, key: saleKeyOf(ctx.placeId, body.timestampId), createdBy: actorOf(ctx), bodyHash: hash, serverCheck: check, anomalies: [], loyalty: { applied: null, full: null, cardCode: null }, operations: [], legacy: null, cancellation: null } };
      // The backoffice is refused a refill the payment does not cover (the till keeps the anomaly: it is right).
      refuseIf(ctx, built.anomalies.some((anomaly) => anomaly.code === 'refillNotCovered'), 'payments', 'refillNotCovered');
      const settled = await settle(tx, ctx, sale, { operation: 'create', at, date: body.date, userId: operator.userId, recompute: true, extra: built.anomalies, reference: null });
      if (settled.applied !== null && settled.applied.advanced !== null && (refillOf(sale) > 0 || amountOf(sale['paymentDiscountAmount']) > 0)) {
        assertCreditRight(ctx);
      }
      let saved: Document = { ...sale, floodCloud: settled.cloud };
      let invoice: InvoiceOutcome | null = null;
      if (body.receiptType === 'invoice') {
        ({ sale: saved, invoice } = await makeInvoice(tx, ctx, body, saved, at, degraded));
      }
      await tx.repo.insert(ctx.caller, ctx.access, saved);
      return { created: true, sale: saved, deleted: null, fidelity: await fidelityOf(tx, ctx, saved, settled.applied), userId: operator.userId, applied: settled.applied, invoice };
    });

  return {
    create: async (ctx, body) => {
      const isInvoice = body.receiptType === 'invoice';
      await prepare(ctx, isInvoice);
      if (isInvoice && ctx.store !== null) {
        await deps.invoiceGuard.admit(ctx.store);
      }
      let outcome: Awaited<ReturnType<typeof createOnce>>;
      let degraded = false;
      for (let attempt = 1; ; attempt += 1) {
        try {
          outcome = await createOnce(ctx, body, degraded);
          break;
        } catch (error) {
          // Two requests with the same key at the same moment: the one that lost starts again and finds what the winner made. Two deferred invoices that gather the same unpaid sales: the one that lost starts again (up to three
          // times) and finds them gathered; if it keeps losing, the backoffice is told (`409`) and the till saves its invoice without gathering them (`unpaidSaleRace`).
          const race = error instanceof UnpaidRace;
          if (!race && !(error instanceof MongoServerError && error.code === 11000)) {
            throw error;
          }
          if (attempt >= (race ? 3 : 2)) {
            if (!race) {
              throw error;
            }
            if (!isStoreCaller(ctx.caller)) {
              throw new AppError('CONFLICT', { details: [{ field: 'unpaidSaleIds', issue: 'race' }] });
            }
            degraded = true;
          }
        }
      }
      if (outcome.sale === null) {
        return { created: false, result: { status: 'deleted', saleId: outcome.deleted!.toHexString(), timestampId: body.timestampId } };
      }
      if (outcome.created) {
        await record(ctx, 'sale.created', outcome.sale, outcome.userId, { receiptType: body.receiptType, total: body.totals.total, anomalies: anomalyCount(outcome.sale), duplicate: false });
        // The credit a store sale added to a card (its refills) goes through the same alert thresholds as the credit added from the cards of the contacts.
        await alertCredit(ctx, outcome.sale, outcome.userId, outcome.applied);
      }
      if (outcome.created && outcome.invoice !== null && ctx.store !== null) {
        await deps.invoiceGuard.created(ctx.store, ctx.request);
      }
      // The record of the invoice goes to the send queue only now that the sale and its document are committed.
      const invoice = outcome.invoice === null ? null : outcome.invoice.queue === null ? outcome.invoice.view : { ...outcome.invoice.view, sendStatus: await enqueue(ctx, outcome.sale, outcome.invoice.queue) };
      return { created: outcome.created, result: createdOf(outcome.sale, outcome.fidelity, invoice) };
    },

    amend: async (ctx, id, body, expected) => {
      await prepare(ctx);
      const outcome = await run(ctx, async (tx) => {
        const at = nowDate();
        const found = await load(tx, ctx, id, expected);
        const operator = body.operatorId === undefined ? { userId: objectIdOrNull(found['userId']), anomalies: [] as string[] } : await operatorOf(ctx, body.operatorId);
        const wanted: Document = {};
        const extra: SaleAnomaly[] = operator.anomalies.map((code) => ({ at, operation: 'amend', source: 'sale', code }));
        const flag = (code: string): void => {
          extra.push({ at, operation: 'amend', source: 'sale', code });
        };
        if (body.payments !== undefined) {
          Object.assign(wanted, paymentFields(body.payments));
        }
        if (body.customer !== undefined) {
          const contact = body.customer === null ? null : await tx.repo.findContact(ctx.caller, ctx.access, body.customer.contactId);
          if (body.customer !== null && contact === null) {
            flag('customerMissing');
          } else if (contact?.trashed === true) {
            flag('customerTrashed');
          }
          const copy = customerOf(contact);
          wanted['customer'] = copy.customer;
          wanted['customerType'] = copy.customerType;
        }
        if (body.fidelityCardCode !== undefined) {
          wanted['fidelityCard'] = body.fidelityCardCode === null ? null : { code: body.fidelityCardCode };
        }
        if (body.fiscalReceiptInfo !== undefined) {
          wanted['fiscalReceiptInfo'] = fiscalInfoOf(body.fiscalReceiptInfo);
        }
        if (body.lotteryCode !== undefined) {
          wanted['lotteryId'] = body.lotteryCode;
        }
        if (body.operatorId !== undefined) {
          wanted['userId'] = operator.userId;
        }
        const changed = Object.keys(wanted).filter((key) => !same(found[key], wanted[key]));
        if (changed.length === 0) {
          return { changed: false as const, sale: found, userId: operator.userId, fields: [] as string[], alert: null };
        }
        refuseIf(ctx, found['fiscalState'] === 'canceled', 'fiscalState', 'canceled');
        refuseIf(ctx, found['status'] === 'invoiced' && (changed.includes('customer') || changed.includes('fidelityCard')), 'status', 'invoiced');
        if (found['status'] === 'invoiced') {
          flag('amendAfterInvoiced');
        }
        const sale = await adopted(tx, ctx, found, at);
        const set: Document = Object.fromEntries(changed.map((key) => [key, wanted[key]]));
        const next = { ...sale, ...set };
        const recompute = ['customer', 'fidelityCard', 'paymentDiscountAmount'].some((key) => changed.includes(key));
        const settled = await settle(tx, ctx, next, { operation: 'amend', at, date: at, userId: operator.userId, recompute, extra, reference: null });
        const was = (recordOf(recordOf(sale['floodCloud'])['loyalty'])['applied'] ?? null) as LoyaltyEffects | null;
        if ((changed.includes('paymentDiscountAmount') || changed.includes('fidelityCard')) && (was?.advanced != null || settled.applied?.advanced != null)) {
          assertCreditRight(ctx);
        }
        const issues = lineIssuesOf(recordOf(sale['floodCloud'])['serverCheck'], listOf(next['products']).length);
        const saved = await write(tx, ctx, sale, { ...set, updateDate: at, floodCloud: { ...settled.cloud, serverCheck: serverCheckOf(next, issues, at) } });
        // The card the sale had before: a different one now gets the refills of the sale as credit.
        const before = (recordOf(recordOf(sale['floodCloud'])['loyalty'])['applied'] ?? null) as LoyaltyEffects | null;
        const cardChanged = settled.applied !== null && settled.applied.advanced !== null && (before === null || before.advanced === null || !before.advanced.cardId.equals(settled.applied.advanced.cardId));
        return { changed: true as const, sale: saved, userId: operator.userId, fields: changed, alert: cardChanged ? settled.applied : null };
      });
      if (outcome.changed) {
        await record(ctx, 'sale.amended', outcome.sale, outcome.userId, { fields: outcome.fields.join(','), anomalies: anomalyCount(outcome.sale) });
        await alertCredit(ctx, outcome.sale, outcome.userId, outcome.alert);
      }
      return storeSaleView(outcome.sale);
    },

    refund: async (ctx, id, body, expected) => {
      await prepare(ctx);
      const outcome = await run(ctx, async (tx) => {
        const at = nowDate();
        const found = await load(tx, ctx, id, expected);
        const done = listOf(found['refund']).find((entry) => entry['timestampId'] === body.timestampId);
        if (done !== undefined) {
          return { created: false as const, sale: found, userId: null, entry: done };
        }
        refuseIf(ctx, found['fiscalState'] === 'canceled', 'fiscalState', 'canceled');
        assertRefundRoom(found, 2);
        const problems = refundLineProblems(found, body);
        if (problems.length > 0) {
          throw new AppError('VALIDATION_ERROR', { details: problems.map((field) => ({ field, issue: 'incorrect' })) });
        }
        const operator = await operatorOf(ctx, body.operatorId);
        const sale = await adopted(tx, ctx, found, at);
        const { entry, exceeds } = refundEntryOf(sale, body, operator.userId);
        const extra: SaleAnomaly[] = operator.anomalies.map((code) => ({ at, operation: 'refund', source: 'sale', code }));
        refuseIf(ctx, exceeds, 'products', 'refundExceeds');
        if (exceeds) {
          extra.push({ at, operation: 'refund', source: 'sale', code: 'refundExceedsSold' });
        }
        const canceled = sale['fiscalState'] === 'canceled';
        if (canceled) {
          extra.push({ at, operation: 'refund', source: 'sale', code: 'refundAfterCancel' });
        }
        const set: Document = { refund: [...listOf(sale['refund']), entry], returnedGoods: entry['returnedGoods'], returnedGoodsValue: entry['returnedGoodsValue'], fiscalState: canceled ? 'canceled' : 'refunded', updateDate: at };
        const next = { ...sale, ...set };
        const settled = await settle(tx, ctx, next, { operation: 'refund', at, date: body.date, userId: operator.userId, recompute: false, extra, reference: body.timestampId });
        if (creditMoved(sale, settled.applied)) {
          assertCreditRight(ctx);
        }
        const saved = await write(tx, ctx, sale, { ...set, floodCloud: settled.cloud });
        return { created: true as const, sale: saved, userId: operator.userId, entry };
      });
      if (outcome.created) {
        await record(ctx, 'sale.refunded', outcome.sale, outcome.userId, { refundTimestampId: body.timestampId, total: (outcome.entry['returnedGoodsValue'] as Document)['priceTaxed'] as number, anomalies: anomalyCount(outcome.sale) });
      }
      const view = storeSaleView(outcome.sale);
      return { created: outcome.created, sale: view, refund: view.refunds.find((entry) => entry.timestampId === body.timestampId)! };
    },

    cancel: async (ctx, id, body, expected) => {
      await prepare(ctx);
      const outcome = await run(ctx, async (tx) => {
        const at = nowDate();
        const found = await load(tx, ctx, id, expected);
        if (found['fiscalState'] === 'canceled') {
          return { created: false as const, sale: found, userId: null };
        }
        assertRefundRoom(found, 1);
        const operator = await operatorOf(ctx, body.operatorId);
        const sale = await adopted(tx, ctx, found, at);
        const extra: SaleAnomaly[] = operator.anomalies.map((code) => ({ at, operation: 'cancel', source: 'sale', code }));
        if (sale['fiscalState'] === 'refunded') {
          extra.push({ at, operation: 'cancel', source: 'sale', code: 'cancelAfterRefund' });
        }
        const entry = cancellationEntryOf(sale, body, operator.userId);
        const set: Document = { refund: [...listOf(sale['refund']), entry], fiscalState: 'canceled', updateDate: at };
        const next = { ...sale, ...set };
        const settled = await settle(tx, ctx, next, { operation: 'cancel', at, date: body.date, userId: operator.userId, recompute: false, extra, reference: null });
        if (creditMoved(sale, settled.applied)) {
          assertCreditRight(ctx);
        }
        const saved = await write(tx, ctx, sale, { ...set, floodCloud: { ...settled.cloud, cancellation: { date: body.date, userId: operator.userId, fiscalReceiptInfo: fiscalInfoOf(body.fiscalReceiptInfo) } } });
        return { created: true as const, sale: saved, userId: operator.userId };
      });
      if (outcome.created) {
        await record(ctx, 'sale.canceled', outcome.sale, outcome.userId, { total: amountOf(outcome.sale['finalTotalCheckout']), anomalies: anomalyCount(outcome.sale) });
      }
      return { created: outcome.created, sale: storeSaleView(outcome.sale) };
    },

    remove: async (ctx, id, expected) => {
      await prepare(ctx);
      const sale = await run(ctx, async (tx) => {
        const at = nowDate();
        const found = await load(tx, ctx, id, expected);
        // Only a quote: `sType` exactly `true` (never a text or a number a client could make truthy) and no fiscal receipt number (a quote that was given one is a fiscal sale).
        const number = recordOf(found['fiscalReceiptInfo'])['number'];
        if (found['sType'] !== true || (number !== null && number !== undefined)) {
          throw new AppError('CONFLICT', { details: [{ field: 'nonFiscal', issue: 'fiscal' }] });
        }
        if (found['status'] === 'invoiced') {
          throw new AppError('CONFLICT', { details: [{ field: 'status', issue: 'invoiced' }] });
        }
        // A sale that has an invoice (its document and its number exist) is never deleted.
        if (found['receiptType'] === 'invoice') {
          throw new AppError('CONFLICT', { details: [{ field: 'receiptType', issue: 'invoice' }] });
        }
        const sale = await adopted(tx, ctx, found, at);
        await tx.repo.insertTombstone(ctx.caller, ctx.access, { key: saleKeyOf(ctx.placeId, String(found['timestampId'])), saleId: id, deletedAt: at });
        await settle(tx, ctx, sale, { operation: 'delete', at, date: at, userId: null, recompute: false, extra: [], reference: null, deleting: true });
        if (!(await tx.repo.remove(ctx.caller, ctx.access, id))) {
          throw saleNotFound();
        }
        return sale;
      });
      await record(ctx, 'sale.deleted', sale, null, { total: amountOf(sale['finalTotalCheckout']) });
    },

    get: async (ctx, id) => {
      const sale = await repositoryOver(databases).findOfPlace(ctx.caller, ctx.access, ctx.placeId, id);
      if (sale === null) {
        throw saleNotFound();
      }
      return storeSaleView(sale);
    },

    search: async (ctx, query) => {
      const repository = repositoryOver(databases);
      const filter: Filter<Document> =
        query.timestampId !== undefined
          ? { timestampId: query.timestampId }
          : query.contactId !== undefined
            ? { 'customer._id': query.contactId }
            : { ...(query.receiptNumber === undefined ? {} : { 'fiscalReceiptInfo.number': query.receiptNumber }), ...(query.reportNumber === undefined ? {} : { 'fiscalReceiptInfo.reportNumber': query.reportNumber }), ...(query.serialNumber === undefined ? {} : { 'device.settings.serialNumber': query.serialNumber }) };
      return (await repository.search(ctx.caller, ctx.access, ctx.placeId, filter, query.limit ?? 10)).map(storeSaleView);
    },
  };
}
