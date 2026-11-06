import { object, optional, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { conflict, sameName, textOf } from './kit.ts';

/** Most measure units a group may have. */
export const MAX_MEASURE_UNITS = 50;

/** A measure unit of a group (legacy `measureUnits.<id>`, a map keyed by the id: `{ id, value }`). The value is unique ignoring case. */
export interface MeasureUnit {
  readonly id: string;
  readonly value: string;
}

const valueSchema = string({ min: 1, max: 20, trim: true });

/** Body of the creation of a measure unit. */
export const createMeasureUnitBody = object({ value: valueSchema });

/** Body of the modification of a measure unit (JSON Merge Patch). */
export const patchMeasureUnitBody = object({ value: optional(valueSchema) });

type CreateBody = Infer<typeof createMeasureUnitBody>;
type PatchBody = Infer<typeof patchMeasureUnitBody>;

/** The measure units (`/measure-units`). A unit already in use by a product is not looked for: the products keep their own text. */
export const measureUnits = defineCatalog<MeasureUnit, CreateBody, PatchBody>({
  name: 'measureUnit',
  segment: 'measure-units',
  path: 'measureUnits',
  kind: 'map',
  limit: MAX_MEASURE_UNITS,
  idKey: 'id',
  readPermission: 'groups:read',
  updatePermission: 'groups:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createMeasureUnitBody,
  patchSchema: patchMeasureUnitBody,
  toElement: (id, raw) => ({ id, value: textOf(raw['value']) ?? '' }),
  defaults: (id) => ({ id, value: '' }),
  toRaw: (element, raw) => ({ ...raw, id: element.id, value: element.value }),
  check: ({ element, body, others }) => {
    if (body.value !== undefined && others.some((other) => sameName(other.value, element.value))) {
      throw conflict('value', 'taken');
    }
    return [];
  },
});
