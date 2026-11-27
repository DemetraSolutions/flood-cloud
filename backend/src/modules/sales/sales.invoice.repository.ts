import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { DOCUMENTS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { readInvoiceCompany, readNumberingSetup, readPlaceCashStorages } from '../../shared/security/scope/group-mirror.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { isRecord } from '../groups/catalogs/kit.ts';
import { objectIdOrNull, recordOf } from './sales.document.ts';

/** The fields of a contact the invoice copies as its counterpart: what the electronic invoice reads of the customer and what its print shows. Never the account, the services, the notes, the price lists, the cards or the trash. */
const COUNTERPART_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  contactCode: 1,
  code: 1,
  name: 1,
  surname: 1,
  address: 1,
  postcode: 1,
  city: 1,
  countryCode: 1,
  countryAreaCode: 1,
  telephone: 1,
  email: 1,
  companyName: 1,
  companyCode: 1,
  companyCode2: 1,
  companyAddress: 1,
  companyPostcode: 1,
  companyCity: 1,
  companyCountryCode: 1,
  companyCountryAreaCode: 1,
  companyTelephone: 1,
  companyEmail: 1,
  'fattura_elettronica.formato_trasmissione': 1,
  'fattura_elettronica.identificativo': 1,
  'fattura_elettronica.codice_destinatario': 1,
  'fattura_elettronica.pec': 1,
  'fattura_elettronica.regime_fiscale': 1,
  'fattura_elettronica.split_payment': 1,
  'fattura_elettronica.riferimento_amministrazione': 1,
});

/** The reads and writes of the invoice documents of the sales of a group, always in the group database of the verified access. Built over a database accessor: the real one, or the one bound to a transaction. */
export interface InvoiceRepository {
  /** The company of the invoice as the copy in the common database has it, with the fixed projection of the fields the invoice copies; `null` when it is not of the group. */
  findCompany(caller: ScopeHolder, access: GroupAccess, companyId: ObjectId): Promise<Document | null>;
  /** The contact that is the customer of the invoice, with the fixed projection of the fields the invoice copies; `null` when it is not of the group. */
  findCounterpart(caller: ScopeHolder, access: GroupAccess, contactId: ObjectId): Promise<Document | null>;
  /** The storage of the cash desks of a point of sale (the last one, as the legacy does); `null` when it has none. */
  findCashStorage(caller: ScopeHolder, access: GroupAccess, placeId: ObjectId): Promise<ObjectId | null>;
  /** The time zone of a point of sale as the copy in the common database has it (anything: the numbering judges it); `undefined` when the group has no such place. */
  findTimeZone(caller: ScopeHolder, access: GroupAccess, companyId: ObjectId, placeId: ObjectId): Promise<unknown>;
  /** The dealer of the group (`groups.dealerId` in the common database); `null` when the group has none. */
  findDealerId(access: GroupAccess): Promise<ObjectId | null>;
  /** Inserts the document of an invoice. @throws {Error} When the document has a field this backend does not own. */
  insert(caller: ScopeHolder, access: GroupAccess, document: Document): Promise<void>;
  /** The document of the invoice of a sale: by its id when the sale knows it, else (a sale of the legacy) by the company, the date and the sale. `null` when there is none. */
  findOfSale(caller: ScopeHolder, access: GroupAccess, sale: Document): Promise<Document | null>;
  /** Moves the state of sending of a document from `from` to `to`, only if it is still `from` (the worker of the e-invoicing may have moved it meanwhile); `true` when it moved. */
  moveSendStatus(caller: ScopeHolder, access: GroupAccess, documentId: ObjectId, from: string, to: string): Promise<boolean>;
}

/**
 * Builds the repository of the invoices of the sales over a database accessor. Every read and write is in the group database of the verified access (the company in its copy in the common database), has a time limit and a bound, and a write names only the
 * fields the backend owns.
 *
 * @param databases Database accessor: the real one, or the one bound to the session of a transaction (`sessionDatabases`).
 */
export function createInvoiceRepository(databases: Databases): InvoiceRepository {
  const documents = (caller: ScopeHolder, access: GroupAccess) => groupDatabaseFor(caller, access, databases).collection('documents');
  return {
    findCompany: (caller, access, companyId) => bounded(() => readInvoiceCompany(caller, access, databases, companyId)),

    findCounterpart: (caller, access, contactId) => bounded(() => groupDatabaseFor(caller, access, databases).collection('contacts').findOne({ _id: contactId }, { projection: { ...COUNTERPART_PROJECTION }, maxTimeMS: LIST_MAX_TIME_MS })),

    findCashStorage: async (caller, access, placeId) => {
      const place = await bounded(() => readPlaceCashStorages(caller, access, databases, placeId));
      const storages = Array.isArray(place?.['storages']) ? (place['storages'] as unknown[]) : [];
      const ids = storages.flatMap((storage) => (isRecord(storage) && storage['cash'] === true ? [objectIdOrNull(storage['id'])] : [])).filter((id): id is ObjectId => id !== null);
      return ids.at(-1) ?? null;
    },

    findTimeZone: async (caller, access, companyId, placeId) => (await bounded(() => readNumberingSetup(caller, access, databases, companyId, placeId))).place?.['timezone'],

    findDealerId: async (access) => {
      const group = await bounded(() => databases.common().collection('groups').findOne({ _id: access.groupId }, { projection: { dealerId: 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
      return objectIdOrNull(group?.['dealerId']);
    },

    insert: async (caller, access, document) => {
      const stray = Object.keys(document).filter((name) => name !== '_id' && !DOCUMENTS_OWNED_FIELDS.includes(name));
      if (stray.length > 0) {
        throw new Error(`The sales module does not own the field ${stray[0]!} of a document`);
      }
      await documents(caller, access).insertOne({ ...document });
    },

    findOfSale: (caller, access, sale) => {
      const known = objectIdOrNull(recordOf(recordOf(sale['floodCloud'])['invoice'])['documentId']);
      // The documents have no index on the sale: a sale of the legacy is found through the one on the company and the date (the document has the date of the sale).
      const filter: Document = known === null ? { companyId: sale['companyId'], date: sale['date'], saleId: sale['_id'] } : { _id: known };
      return bounded(() => documents(caller, access).findOne(filter, { maxTimeMS: LIST_MAX_TIME_MS }));
    },

    moveSendStatus: async (caller, access, documentId, from, to) => (await documents(caller, access).updateOne({ _id: documentId, sendStatus: from }, { $set: { sendStatus: to } })).modifiedCount === 1,
  };
}
