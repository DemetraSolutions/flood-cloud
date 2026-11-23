import { Double, Int32 } from 'mongodb';
import type { Document } from 'mongodb';
import { flagOf, integerOf, isRecord, numberOf, textOf } from '../groups/catalogs/kit.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';

/** The tax rate of a department as the department holds it (a copy of the rate of the group at the time it was chosen), read tolerantly. */
export interface DepartmentTax {
  /** The percentage (`value` of the stored copy); `null` when it is not a number. */
  readonly rate: number | null;
  /** The number of the fiscal department of the tax rate (the one the products' prices carry): the POS matches the department with it. */
  readonly department: number | null;
  /** The code of the VAT nature, `null` for none. */
  readonly vatNature: string | null;
  readonly description: string | null;
}

/** The fields only a department has, in the domain form. */
export interface DepartmentExtra {
  /** The number of the department on the cash register, 1 to 99 for what this backend writes; `null` when the stored code is not a whole number (the legacy left strings and `NaN`). */
  readonly code: number | null;
  /** The id of the tax rate of the group the department was given; `null` when the stored copy has none. */
  readonly taxId: string | null;
  /** The copy of the tax rate the department holds; `null` when the stored value is not an object. Read only: it follows the rate of the group (it is realigned when that changes). */
  readonly tax: DepartmentTax | null;
  readonly noDiscount: boolean;
  readonly secondaryFiscalPrinter: boolean;
}

/**
 * The code of a stored department as a number: a whole number (the `Int32` this backend writes or a double), or a text of digits (the legacy form wrote a string). `NaN`, a fraction, any other text and a missing code give `null`.
 *
 * @param raw The stored `code`, of any type.
 */
export function codeOf(raw: unknown): number | null {
  // A document just built by this backend holds the BSON wrapper of the number; one read from the database holds the number.
  const bare = raw instanceof Int32 || raw instanceof Double ? raw.valueOf() : raw;
  return integerOf(typeof bare === 'string' && /^\s*\d{1,9}\s*$/.test(bare) ? Number(bare) : bare);
}

/**
 * The fields only a department has, read from a stored document: the code, the tax copy and the two switches; a flag the document lacks is off and a key it holds that is not known is ignored.
 *
 * @param document The stored document.
 */
export function departmentExtra(document: Document): DepartmentExtra {
  const tax: unknown = document['tax'];
  return {
    code: codeOf(document['code']),
    taxId: isRecord(tax) ? textOf(tax['id']) : null,
    tax: isRecord(tax) ? { rate: numberOf(tax['value']), department: integerOf(tax['department']), vatNature: textOf(tax['natura']), description: textOf(tax['description']) } : null,
    noDiscount: flagOf(document['noDiscount']),
    secondaryFiscalPrinter: flagOf(document['secondaryFiscalPrinter']),
  };
}

/**
 * The copy of a tax rate of the group as a department stores it (and as the products' prices do): `{ id, value, department, description, natura }`, the legacy names.
 *
 * @param tax The tax rate of the group.
 */
export function taxCopyOf(tax: Pick<Tax, 'id' | 'rate' | 'department' | 'description' | 'vatNature'>): Document {
  return { id: tax.id, value: tax.rate, department: tax.department, description: tax.description, natura: tax.vatNature };
}
