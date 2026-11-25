import type { Country } from '../companies/companies.repository.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { WorkbookService } from '../catalog-xlsx/catalog-xlsx.controller.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { contactVersion } from '../contacts/contacts.document.ts';
import { createContactsRepository } from '../contacts/contacts.repository.ts';
import { CONTACTS_LIST } from '../contacts/contacts.schemas.ts';
import { createContactsService } from '../contacts/contacts.service.ts';
import { createRecordsXlsxService } from '../records-xlsx/records-xlsx.service.ts';
import type { RecordsDomain, RecordsXlsxDeps } from '../records-xlsx/records-xlsx.service.ts';
import { CONTACTS_SHEET } from './contacts-xlsx.columns.ts';
import { contactRow } from './contacts-xlsx.export.ts';
import { applyContacts } from './contacts-xlsx.import.ts';
import type { ContactsGraph } from './contacts-xlsx.import.ts';

/** Prefix of the key of the lock of a group in `common.settings`: one import of the contacts at a time for a group, whatever the instance of the server. */
export const CONTACTS_LOCK_PREFIX = 'CONTACTS_LOCK:';

/** Contacts read at a time while the workbook is written: large pages, because the display name the list sorts by is computed (`contactName`) and each page scans the collection. */
export const CONTACTS_EXPORT_BATCH = 1000;

/** The collaborators of the workbook of the contacts: what the service of the contacts is built from. */
export interface ContactsXlsxDeps extends RecordsXlsxDeps {
  readonly catalogs: Pick<CatalogsService, 'list'>;
  /** Reads a country of the platform by its code. */
  readonly findCountry: (code: string) => Promise<Country | null>;
  /** Counts the definitive deletions of contacts per user (the import never deletes: the service of the contacts needs it). */
  readonly rateLimiter: RateLimiter;
  readonly deleteRule: RateLimitRule;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
}

/**
 * Builds the workbook of the contacts of a group (`doc/Tasks.md` step K3): the sheet `Contatti` with the 35 columns of the legacy CSV. The export writes the contacts that are not in the trash by display name; the import
 * writes through the service of the contacts built over the transaction of the import, so every rule of the routes applies. The import is all or nothing and holds the lock `CONTACTS_LOCK:<groupId>`.
 *
 * @param deps The collaborators.
 */
export function createContactsXlsxService(deps: ContactsXlsxDeps): WorkbookService {
  const { databases, catalogs, versionKey } = deps;
  const reads = createContactsRepository(databases);
  const priceListsOf = async (access: Parameters<ContactsGraph['priceLists']>[0]) => ((await catalogs.list(priceLists, access)) as PriceList[]).map((list) => ({ id: list.id, name: list.name.trim() }));
  const domain: RecordsDomain<ContactsGraph> = {
    sheet: CONTACTS_SHEET,
    kind: 'contacts',
    fileBase: 'contacts',
    lockPrefix: CONTACTS_LOCK_PREFIX,
    audit: { exported: 'contacts.exported', imported: 'contacts.imported', resource: 'contacts', exportedKey: 'contacts' },
    count: (principal, access, cap) => reads.countUpTo(principal, access, { trash: { $ne: true } }, cap),
    rows: async function* (principal, access, mode) {
      const lists = await priceListsOf(access);
      let cursor: string | undefined;
      do {
        const params = listParamsOf({ limit: CONTACTS_EXPORT_BATCH, sort: 'displayName', ...(cursor === undefined ? {} : { cursor }) }, CONTACTS_LIST);
        const { items, page } = await reads.listFull(principal, access, { trash: { $ne: true } }, params);
        for (const document of items) {
          yield contactRow(document, lists, mode);
        }
        cursor = page.next ?? undefined;
      } while (cursor !== undefined);
    },
    graphOver: (over, log) => {
      const repository = createContactsRepository(over);
      return {
        contacts: createContactsService({ repository, catalogs, findCountry: deps.findCountry, activityLog: log, rateLimiter: deps.rateLimiter, deleteRule: deps.deleteRule, versionKey, now: deps.now }),
        advancedCodes: async (principal, access, codes) => new Set((await repository.advancedCards(principal, access, codes)).map((card) => card['code'] as string)),
        find: (principal, access, id) => repository.findById(principal, access, id),
        version: (document) => contactVersion(document, versionKey),
        priceLists: priceListsOf,
      };
    },
    apply: applyContacts,
  };
  return createRecordsXlsxService(domain, deps);
}
