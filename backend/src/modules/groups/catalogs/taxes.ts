import { enumOf, integer, nullable, number, object, optional, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { integerOf, numberOf, textOf } from './kit.ts';

/** Most tax rates a group may have. */
export const MAX_TAXES = 30;

/** The codes of the VAT nature (`natura`) of the Italian electronic invoice: `N1`, `N2.1`, `N2.2`, `N3.1` to `N3.6`, `N4`, `N5`, `N6.1` to `N6.9`. */
export const VAT_NATURES = Object.freeze([
  'N1',
  'N2.1',
  'N2.2',
  'N3.1',
  'N3.2',
  'N3.3',
  'N3.4',
  'N3.5',
  'N3.6',
  'N4',
  'N5',
  'N6.1',
  'N6.2',
  'N6.3',
  'N6.4',
  'N6.5',
  'N6.6',
  'N6.7',
  'N6.8',
  'N6.9',
] as const);

/**
 * A tax rate of a group (legacy `taxes[]`, an array). Mapping: `value` is `rate` (a percentage), `department` is the fiscal department (1 to 99),
 * `natura` is `vatNature`. A stored nature outside {@link VAT_NATURES} is kept and shown as it is.
 */
export interface Tax {
  readonly id: string;
  readonly rate: number;
  readonly department: number | null;
  readonly description: string | null;
  readonly vatNature: string | null;
}

const fields = {
  rate: number({ min: 0, max: 100 }),
  department: nullable(integer({ min: 1, max: 99 })),
  description: nullable(string({ min: 1, max: 200, trim: true })),
  vatNature: nullable(enumOf(VAT_NATURES)),
};

/** Body of the creation of a tax rate: the rate is required, the other fields default to `null`. */
export const createTaxBody = object({ rate: fields.rate, department: optional(fields.department), description: optional(fields.description), vatNature: optional(fields.vatNature) });

/** Body of the modification of a tax rate (JSON Merge Patch). */
export const patchTaxBody = object({
  rate: optional(fields.rate),
  department: optional(fields.department),
  description: optional(fields.description),
  vatNature: optional(fields.vatNature),
});

type CreateBody = Infer<typeof createTaxBody>;
type PatchBody = Infer<typeof patchTaxBody>;

/** The tax rates (`/taxes`). */
export const taxes = defineCatalog<Tax, CreateBody, PatchBody>({
  name: 'tax',
  segment: 'taxes',
  path: 'taxes',
  kind: 'array',
  limit: MAX_TAXES,
  idKey: 'id',
  readPermission: 'groups:read',
  updatePermission: 'groups:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createTaxBody,
  patchSchema: patchTaxBody,
  toElement: (id, raw, anomalies) => {
    const vatNature = textOf(raw['natura']);
    if (vatNature !== null && !(VAT_NATURES as readonly string[]).includes(vatNature)) {
      anomalies.push({ kind: 'invalidValue', field: `taxes.${id}.natura` });
    }
    return { id, rate: numberOf(raw['value']) ?? 0, department: integerOf(raw['department']), description: textOf(raw['description']), vatNature };
  },
  defaults: (id) => ({ id, rate: 0, department: null, description: null, vatNature: null }),
  toRaw: (element, raw) => ({ ...raw, id: raw?.['id'] ?? element.id, value: element.rate, department: element.department, description: element.description, natura: element.vatNature }),
});
