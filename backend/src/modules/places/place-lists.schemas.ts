import { PLACE_LISTS } from '../../shared/legacy-write/place-lists.ts';
import type { ItemDef, ItemFieldKind, ListDef } from '../../shared/legacy-write/place-lists.ts';
import { array, boolean, integer, nullable, number, object, optional, string } from '../../shared/validation/schema.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { emptyAsNull } from '../companies/companies.schemas.ts';
import type { Part } from '../companies/companies.schemas.ts';

/** The id of an item the form of the old backoffice makes (`dBJs.createId`) or of a reference: what a path segment can carry. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The form of a credential of a device: printable ASCII, spaces only inside. */
const CREDENTIAL = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

/** The schema of the value of a key of an item. Every key is optional in a request (a new item takes the default, an existing one keeps its value); the rules the form leaves to the service are checked there. */
function kindSchema(kind: ItemFieldKind): Schema<unknown> {
  switch (kind.t) {
    case 'text':
      return string({ max: kind.max, trim: true });
    case 'flag':
      return boolean();
    case 'enum':
      // That it is one of the values is checked by the service where it changes, so a historical value sent back unchanged is accepted.
      return string({ max: 64 });
    case 'int':
      return kind.def === null ? nullable(integer({ min: kind.min, max: kind.max })) : integer({ min: kind.min, max: kind.max });
    case 'num':
      return nullable(number({ min: kind.min, max: kind.max }));
    case 'ref':
      return string({ max: 64, pattern: /^[A-Za-z0-9_-]*$/ });
    case 'refs':
      return array(string({ min: 1, max: 64, pattern: ID }), { max: kind.max, unique: true });
    case 'secret':
      // A credential: a text sets it, `null` or `''` clears it, leaving it out keeps it.
      // Not trimmed, printable characters only, no space at the ends: a credential is never changed silently nor holds a control character.
      return emptyAsNull(nullable(string({ max: kind.max, pattern: CREDENTIAL })));
    case 'object':
      return object(Object.fromEntries(Object.entries(kind.fields).map(([key, field]) => [key, optional(kindSchema(field))])));
    case 'list':
      return array(itemSchema(kind.item, 'text'), { max: kind.max });
  }
}

/** The schema of an item: its id (left out for a new item), every key of its definition, and the flag of each credential (a response carries it; it is ignored). */
function itemSchema(def: ItemDef, idKind: 'text' | 'objectId'): Schema<unknown> {
  // An item without an id reads with `id: ''` and `withoutId: true`: sent back unchanged it is accepted (the service refuses a change of such a list).
  const shape: Record<string, Schema<unknown>> = {
    id: optional(string(idKind === 'objectId' ? { max: 24, pattern: /^(?:[0-9a-f]{24})?$/ } : { max: 64, pattern: /^(?:[A-Za-z0-9_-]{1,64})?$/ })),
    withoutId: optional(boolean()),
  };
  for (const [key, kind] of Object.entries(def.fields)) {
    shape[key] = optional(kindSchema(kind));
    if (kind.t === 'secret') {
      shape[`${key}Set`] = optional(boolean());
    }
  }
  return object(shape);
}

/** The schema of the items of a list. */
const itemsOf = (list: ListDef): Schema<unknown> => array(itemSchema(list, list.idKind), { max: list.max });

/** The names of the blocks of the lists (the domain blocks), with the `PUT` segment of each. */
export const LIST_SEGMENTS: Readonly<Record<string, string>> = Object.freeze({
  devices: 'devices',
  printStations: 'print-stations',
  rooms: 'rooms',
  storages: 'storages',
});

/**
 * The schema of the block of a list: `devices` and `rooms` and `storages` have `items`, the print stations have `stations` and `productionCenters`; every key is required for a whole block
 * (`PUT`) and optional for a modification (`part`).
 *
 * @param name The name of the block.
 * @param part {@link required} or {@link partial}.
 */
export function listBlockSchema<T = Record<string, unknown>>(name: string, part: Part): Schema<T> {
  // The flags a response carries (whether a list can be written) are accepted and ignored, so what a `GET` returns can be sent back.
  const shape =
    name === 'printStations'
      ? { stations: part(itemsOf(PLACE_LISTS.printStations)), productionCenters: part(itemsOf(PLACE_LISTS.productionCenter)), stationsEditable: optional(boolean()), productionCentersEditable: optional(boolean()) }
      : { items: part(itemsOf(PLACE_LISTS[name as 'devices' | 'rooms' | 'storages'])), editable: optional(boolean()) };
  return object(shape) as unknown as Schema<T>;
}
