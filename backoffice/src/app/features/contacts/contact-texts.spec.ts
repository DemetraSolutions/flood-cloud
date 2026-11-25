import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import { CONTACT_GROUP_REFERENCE_KINDS, CONTACT_REFERENCE_KINDS } from './contact-errors';
import { CONTACT_SECTIONS } from './contact-page';
import {
  CONTACT_KINDS,
  E_INVOICE_CHANNELS,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  TAX_REGIMES,
} from './contact.types';

/** Keys the pages build at runtime, which the key scan cannot see. */
const dictionary = flattenDictionary(
  JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
);

function has(keys: readonly string[]): void {
  const missing = keys.filter((key) => !dictionary.get(key));
  expect(missing).toEqual([]);
}

describe('contact texts', () => {
  it('has the texts of every kind of contact and of the three types', () => {
    has(CONTACT_KINDS.map((kind) => `CONTACTS.KIND.${kind.toUpperCase()}`));
    has(['CUSTOMER', 'SUPPLIER', 'OTHER'].map((type) => `CONTACTS.TYPE.${type}`));
  });

  it('has the columns of the list', () => {
    has(
      [
        'SELECT',
        'COMPANY_NAME',
        'DISPLAY_NAME',
        'EMAIL',
        'FIRST_NAME',
        'LAST_NAME',
        'PHONE',
        'TYPE',
        'VAT_NUMBER',
      ].map((column) => `CONTACTS.COLUMN.${column}`),
    );
  });

  it('has the tabs of the page', () => {
    expect(CONTACT_SECTIONS.length).toBeGreaterThan(0);
    has(CONTACT_SECTIONS.map((section) => `CONTACTS.SECTION.${section.toUpperCase()}`));
  });

  it('has the name of every code of the e-invoice', () => {
    has(PAYMENT_TERMS.map((code) => `CONTACTS.E_INVOICING.PAYMENT_TERM_NAME.${code}`));
    has(PAYMENT_METHODS.map((code) => `CONTACTS.E_INVOICING.PAYMENT_METHOD_NAME.${code}`));
    has(TAX_REGIMES.map((code) => `CONTACTS.E_INVOICING.TAX_REGIME_NAME.${code}`));
    has(E_INVOICE_CHANNELS.map((code) => `CONTACTS.E_INVOICING.CHANNEL_${code}`));
  });

  it('has the outcomes of the move to the trash', () => {
    has(['NOTFOUND', 'ALREADYTRASHED', 'CONFLICT'].map((issue) => `CONTACTS.TRASH.ISSUE.${issue}`));
  });

  it('has the text of each kind of reference that stops a deletion', () => {
    has(CONTACT_REFERENCE_KINDS.map((kind) => `CONTACTS.REFERENCE.${kind}`));
    has(CONTACT_GROUP_REFERENCE_KINDS.map((kind) => `CONTACTS.REFERENCE.${kind}`));
  });

  it('has the labels of the lists of texts the person and the company pass as attributes', () => {
    has(['PHONE_N', 'ADD_PHONE', 'EMAIL_N', 'ADD_EMAIL'].map((key) => `CONTACTS.PERSON.${key}`));
    has(
      ['PHONE_N', 'ADD_PHONE', 'EMAIL_N', 'ADD_EMAIL', 'FAX_N', 'ADD_FAX'].map(
        (key) => `CONTACTS.COMPANY.${key}`,
      ),
    );
  });

  it('has the texts the trash needs for the contacts', () => {
    has([
      'TRASH.KIND.CONTACTS',
      'TRASH.ISSUE.REFERENCED_CONTACTS',
      'TRASH.ISSUE.TAKEN_CONTACTS',
      'TRASH.DELETE.LIMIT',
      'TRASH.COLUMN.DISPLAY_NAME',
      'TRASH.COLUMN.COMPANY_NAME',
      'TRASH.COLUMN.PHONE',
    ]);
  });

  it('has the texts of the e-invoice formats, the warnings, the references, the errors and the points', () => {
    has(['FPR12', 'FPA12'].map((code) => `CONTACTS.E_INVOICING.FORMAT_${code}`));
    has(['FPR12', 'FPA12'].map((code) => `CONTACTS.E_INVOICING.RECIPIENT_CODE_HINT_${code}`));
    has(['CONTACT_N', 'FIELD_HINT', 'DUPLICATE', 'OTHERS'].map((key) => `CONTACTS.WARNING.${key}`));
    has(['MANY', 'MORE_AFTER', 'ITEM'].map((key) => `CONTACTS.REFERENCE.${key}`));
    has(
      ['KEY_REUSED', 'LIST_IN_USE', 'TOO_SLOW', 'CONCURRENT'].map((key) => `CONTACTS.ERROR.${key}`),
    );
    has(
      ['LISTS_SUPPLIER', 'LIST_FAVORITE', 'LIST_FAVORITE_HINT'].map(
        (key) => `CONTACTS.COMPANY.${key}`,
      ),
    );
    has(['FORM.ISSUE.NAME_OR_COMPANY']);
  });

  it('has the texts of the advanced loyalty cards', () => {
    has(
      ['ADVANCED', 'TOTAL_POINTS', 'CARD_DETAIL', 'REMOVE_ADVANCED'].map(
        (key) => `CONTACTS.FIDELITY.${key}`,
      ),
    );
    has(['CONTACTS.POINTS.ADVANCED_CARD', 'CATALOG.REFERENCED.FIDELITYCARDS']);
  });

  it('has the entries of the menu', () => {
    has(['CONTACTS', 'CONTACTS_LIST', 'CONTACT_GROUPS'].map((entry) => `MENU.${entry}`));
  });
});
