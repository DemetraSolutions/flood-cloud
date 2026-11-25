import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { validate } from '../../shared/validation/schema.ts';
import type { SheetCounts } from '../catalog-xlsx/catalog-xlsx.import.ts';
import { decimalOf, recognizeByIdOrName, recognizeFlag, referencesOf } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import type { Named } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import { TRANSMISSION_FORMATS, E_INVOICE_CHANNELS, cardsOf, contactData } from '../contacts/contacts.document.ts';
import { patchContactBody, createContactBody } from '../contacts/contacts.schemas.ts';
import type { ContactsService } from '../contacts/contacts.service.ts';
import { RecordErrorCollector } from '../records-xlsx/records-xlsx.errors.ts';
import { RecordRowReader, identityOf, refuse, reportHeaderProblems, resolved } from '../records-xlsx/records-xlsx.sheet.ts';
import type { RecordsImportInput, RecordsReport } from '../records-xlsx/records-xlsx.service.ts';

/** The services of the contacts an import calls, built over the session of the transaction, and the reads it needs. */
export interface ContactsGraph {
  readonly contacts: Pick<ContactsService, 'create' | 'update' | 'trash'>;
  /** A contact (in the trash too), `null` for none. */
  find(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /** The version of a stored contact (the `If-Match` of its next write). */
  version(document: Document): string;
  /** Which of some codes are the code of an advanced card of the group. */
  advancedCodes(principal: AuthPrincipal, access: GroupAccess, codes: readonly string[]): Promise<ReadonlySet<string>>;
  /** The price lists of the group. */
  priceLists(access: GroupAccess): Promise<readonly Named[]>;
}

type Body = Record<string, unknown>;

/** The column a field the service refuses belongs to, by the path of the field. */
const FIELD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['code', 'code'],
  ['customer', 'customer'],
  ['supplier', 'supplier'],
  ['priceListId', 'priceList'],
  ['person.firstName', 'firstName'],
  ['person.lastName', 'lastName'],
  ['person.taxCode', 'taxCode'],
  ['person.birthDate', 'birthDate'],
  ['person.address.street', 'street'],
  ['person.address.postcode', 'postcode'],
  ['person.address.city', 'city'],
  ['person.address.areaCode', 'area'],
  ['person.address.countryCode', 'country'],
  ['person.phones', 'phone'],
  ['person.emails', 'email'],
  ['person.discountPercent', 'discount'],
  ['company.name', 'companyName'],
  ['company.vatNumber', 'vatNumber'],
  ['company.taxCode', 'companyTaxCode'],
  ['company.address.street', 'companyStreet'],
  ['company.address.postcode', 'companyPostcode'],
  ['company.address.city', 'companyCity'],
  ['company.address.areaCode', 'companyArea'],
  ['company.address.countryCode', 'companyCountry'],
  ['company.phones', 'companyPhone'],
  ['company.emails', 'companyEmail'],
  ['company.faxes', 'fax'],
  ['company.discountPercent', 'companyDiscount'],
  ['eInvoicing.transmissionFormat', 'transmission'],
  ['eInvoicing.channel', 'channel'],
  ['eInvoicing.recipientCode', 'recipientCode'],
  ['eInvoicing.pec', 'pec'],
  ['fidelityCards', 'fidelity'],
];

/** Sets a value at a dotted path of a body, creating the objects on the way. */
function put(body: Body, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = body;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    current[segment] = typeof next === 'object' && next !== null ? next : {};
    current = current[segment] as Body;
  }
  current[segments[segments.length - 1]!] = value;
}

/** Days of the Excel date serial from 1899-12-30 (the epoch of the 1900 system, with its leap-year error corrected) to the Unix epoch. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * The date of a cell of birth: `AAAA/MM/GG` or `AAAA-MM-GG` (both as `YYYY-MM-DD`), or the serial number a spreadsheet makes of such a text when the file is converted from the CSV of the legacy (five to seven digits, a
 * date from 1927 on). Whether the date exists is the service's to say.
 *
 * @param text The cell, trimmed.
 * @returns `YYYY-MM-DD`, or `null` when the cell is not a date.
 */
export function recognizeBirthDate(text: string): string | null {
  const written = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(text);
  if (written !== null) {
    return `${written[1]!}-${written[2]!}-${written[3]!}`;
  }
  const serial = /^\d{5,7}$/.test(text) ? Number(text) : 0;
  return serial >= 10_000 && serial <= 2_958_465 ? new Date(EXCEL_EPOCH + serial * 86_400_000).toISOString().slice(0, 10) : null;
}

/**
 * The codes of a cell of loyalty cards: separated by `|`, each either the code or the `code:points` of the legacy CSV (the points are ignored: they are never written), without repetitions. A token that is **as it is**
 * a code the contact or a card of the group already has is that code (`AB:12` may be a code); only any other token loses a `:digits` ending.
 *
 * @param cell The cell, trimmed.
 * @param known The codes that are taken as they are.
 */
export function cardCodesOf(cell: string, known: ReadonlySet<string> = new Set()): string[] {
  const codes = referencesOf(cell).map((token) => (!known.has(token) && /^.+:\d+(?:[.,]\d+)?$/.test(token) ? token.slice(0, token.lastIndexOf(':')).trim() : token));
  return [...new Set(codes)];
}

/**
 * The list a single-valued column makes: the value replaces the **first** element of the list the contact has and the others stay (an empty cell takes the first away); `undefined` when that is the list it has already.
 *
 * @param value The cell, trimmed.
 * @param current The list the contact has (empty for a new contact).
 */
function replacingFirst(value: string, current: readonly string[]): string[] | undefined {
  const next = [...(value === '' ? [] : [value]), ...current.slice(1).filter((item) => item !== value)];
  return next.length === current.length && next.every((item, index) => item === current[index]) ? undefined : next;
}

/** What the columns of a row say, as the body of a creation or of a modification: only the columns the sheet has. */
function contactBody(rv: RecordRowReader, priceLists: readonly Named[], stored: Document | null, advanced: ReadonlySet<string>): Body {
  const body: Body = {};
  const current = stored === null ? null : contactData(stored);
  const text = (key: string, path: string, upper = false): void => {
    const value = rv.text(key);
    if (value !== undefined) {
      put(body, path, upper ? value.toUpperCase() : value);
    }
  };
  const flag = (key: string, path: string): void => {
    const cell = rv.text(key);
    const value = cell === undefined ? undefined : recognizeFlag(cell);
    if (value === null) {
      rv.fail(key, 'invalidValue');
    } else if (value !== undefined) {
      put(body, path, value);
    }
  };
  const percent = (key: string, path: string): void => {
    const cell = rv.text(key);
    if (cell === undefined) {
      return;
    }
    const value = cell === '' ? null : decimalOf(cell);
    if (value === null && cell !== '') {
      rv.fail(key, 'invalidValue');
    } else {
      put(body, path, value);
    }
  };
  const list = (key: string, path: string, currentList: readonly string[] | undefined): void => {
    const value = rv.text(key);
    const next = value === undefined ? undefined : replacingFirst(value, currentList ?? []);
    if (next !== undefined) {
      put(body, path, next);
    }
  };

  text('code', 'code');
  flag('customer', 'customer');
  flag('supplier', 'supplier');
  const listCell = rv.text('priceList');
  if (listCell !== undefined) {
    const list = listCell === '' ? null : resolved(rv, 'priceList', recognizeByIdOrName(listCell, priceLists));
    if (listCell === '' || list !== null) {
      put(body, 'priceListId', list?.id ?? null);
    }
  }
  text('firstName', 'person.firstName');
  text('lastName', 'person.lastName');
  text('taxCode', 'person.taxCode');
  const birth = rv.text('birthDate');
  if (birth !== undefined) {
    const date = birth === '' ? null : recognizeBirthDate(birth);
    if (birth !== '' && date === null) {
      rv.fail('birthDate', 'invalidValue');
    } else {
      put(body, 'person.birthDate', date);
    }
  }
  text('street', 'person.address.street');
  text('postcode', 'person.address.postcode');
  text('city', 'person.address.city');
  text('area', 'person.address.areaCode', true);
  text('country', 'person.address.countryCode', true);
  list('phone', 'person.phones', current?.person.phones);
  list('email', 'person.emails', current?.person.emails);
  percent('discount', 'person.discountPercent');
  text('companyName', 'company.name');
  text('vatNumber', 'company.vatNumber');
  text('companyTaxCode', 'company.taxCode');
  text('companyStreet', 'company.address.street');
  text('companyPostcode', 'company.address.postcode');
  text('companyCity', 'company.address.city');
  text('companyArea', 'company.address.areaCode', true);
  text('companyCountry', 'company.address.countryCode', true);
  list('companyPhone', 'company.phones', current?.company.phones);
  list('companyEmail', 'company.emails', current?.company.emails);
  list('fax', 'company.faxes', current?.company.faxes);
  percent('companyDiscount', 'company.discountPercent');
  for (const [key, path, allowed] of [
    ['transmission', 'eInvoicing.transmissionFormat', TRANSMISSION_FORMATS],
    ['channel', 'eInvoicing.channel', E_INVOICE_CHANNELS],
  ] as const) {
    // The format and the channel are never empty: an empty cell leaves what the contact has (the default for a new one).
    const cell = rv.text(key)?.toUpperCase();
    if (cell === undefined || cell === '') {
      continue;
    }
    if ((allowed as readonly string[]).includes(cell)) {
      put(body, path, cell);
    } else {
      rv.fail(key, 'invalidValue');
    }
  }
  text('recipientCode', 'eInvoicing.recipientCode');
  text('pec', 'eInvoicing.pec');
  const cards = rv.text('fidelity');
  if (cards !== undefined) {
    put(body, 'fidelityCards', cardCodesOf(cards, new Set([...advanced, ...cardsOf(stored?.['fidelities']).map((card) => card.code)])).map((code) => ({ code })));
  }
  return body;
}

/**
 * Applies the rows of the sheet of the contacts through the services of the contacts (the ones of the routes: every rule and every `422` of them is a problem of the row), one row after the other inside the transaction
 * of the import. An empty `ID` is a new contact, a filled one a modification of that contact (the match is **only** by id); `CANCELLAZIONE (X)` with an id moves the contact to the trash, never deletes it. A column the sheet
 * does not have leaves the data alone; one it has writes the cell, an empty one included. A row with a problem writes nothing, and the problems of all the rows are collected.
 *
 * @param input The services, the caller, the group and the sheet.
 * @throws {AppError} `PAYLOAD_TOO_LARGE` when the import runs past its deadline.
 */
export async function applyContacts(input: RecordsImportInput<ContactsGraph>): Promise<RecordsReport> {
  const { graph, principal, access, client, sheet } = input;
  const errors = new RecordErrorCollector(sheet.sheet.name);
  const counts: SheetCounts = { inserted: 0, updated: 0, removed: 0, unchanged: 0 };
  if (reportHeaderProblems(sheet, errors)) {
    return { counts, errors: errors.errors, errorCount: errors.count };
  }
  const priceLists = await graph.priceLists(access);
  const seen = new Set<string>();
  for (const row of sheet.rows) {
    if (input.now() > input.deadline) {
      throw new AppError('PAYLOAD_TOO_LARGE', { message: 'The import takes too long: split the file' });
    }
    if (errors.full) {
      break;
    }
    const rv = new RecordRowReader(sheet, row, errors);
    const { id, remove } = identityOf(rv, seen, { id: 'id', remove: 'delete' });
    if (rv.failed) {
      continue;
    }
    let stored: Document | null = null;
    if (id !== null) {
      stored = await graph.find(principal, access, ObjectId.createFromHexString(id));
      if (stored === null) {
        rv.fail('id', 'notFound');
      } else if (stored['trash'] === true) {
        rv.fail('id', 'trashed');
      }
      if (rv.failed) {
        continue;
      }
    }
    try {
      if (remove) {
        await graph.contacts.trash(principal, access, ObjectId.createFromHexString(id!), graph.version(stored!), client);
        counts.removed += 1;
        continue;
      }
      const cell = rv.text('fidelity');
      const advanced = cell === undefined || cell === '' ? new Set<string>() : await graph.advancedCodes(principal, access, referencesOf(cell));
      const body = contactBody(rv, priceLists, stored, advanced);
      if (rv.failed) {
        continue;
      }
      if (stored === null) {
        await graph.contacts.create(principal, access, validate(createContactBody, body, '(row)'), client);
        counts.inserted += 1;
      } else if (Object.keys(body).length === 0) {
        counts.unchanged += 1;
      } else {
        const version = graph.version(stored);
        const result = await graph.contacts.update(principal, access, stored['_id'] as ObjectId, version, validate(patchContactBody, body, '(row)'), client);
        counts[result.version === version ? 'unchanged' : 'updated'] += 1;
      }
    } catch (error) {
      refuse(error, rv, FIELD_COLUMNS);
    }
  }
  return { counts, errors: errors.errors, errorCount: errors.count };
}
