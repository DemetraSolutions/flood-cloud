import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { canonicalJson } from '../../shared/http/etag.ts';
import { PLACE_LISTS, isEditable, itemKey } from '../../shared/legacy-write/place-lists.ts';
import type { ItemDef, ItemFieldKind, ListDef } from '../../shared/legacy-write/place-lists.ts';
import { isPlain, numberOf } from '../companies/company.mapper.ts';
import type { Codec, Leaf } from '../companies/company.mapper.ts';

/** An item of a list in the domain form: the id and the keys of its definition (a credential as its `<key>Set` flag). */
export type DomainItem = Record<string, unknown>;

const wholeNumber = (value: unknown): number | null => ((n) => (n !== null && Number.isInteger(n) ? n : null))(numberOf(value));
const textsOf = (value: unknown): string[] => (Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === 'string') : []);

/** The terminals of a stored device: the entries with a text `terminalId`, each cut to `{ terminalId, name }` (an empty or missing name is the `terminalId`, as the legacy form saves it). */
const terminalsOf = (value: unknown): Array<{ terminalId: string; name: string }> =>
  (Array.isArray(value) ? (value as unknown[]) : []).flatMap((entry) => {
    const terminalId = isPlain(entry) ? entry['terminalId'] : undefined;
    return typeof terminalId === 'string' && terminalId !== '' ? [{ terminalId, name: typeof (entry as Document)['name'] === 'string' && (entry as Document)['name'] !== '' ? ((entry as Document)['name'] as string) : terminalId }] : [];
  });

/**
 * The value a key of the domain has when the document has none (what a new item takes for a key the request leaves out).
 *
 * @param kind The kind of the key.
 */
export function defaultOf(kind: ItemFieldKind): unknown {
  switch (kind.t) {
    case 'text':
    case 'ref':
      return '';
    case 'flag':
    case 'secret':
      return false;
    case 'enum':
    case 'int':
      return kind.def;
    case 'num':
      return null;
    case 'refs':
    case 'terminals':
    case 'list':
      return [];
    case 'object':
      return Object.fromEntries(Object.entries(kind.fields).map(([key, field]) => [key, defaultOf(field)]));
  }
}

/**
 * The domain value of a stored one: tolerant, a value that is missing or has the wrong type is the default of its kind.
 *
 * @param clear `true` for the representation of the server of a store, which carries the credentials themselves (see {@link readFields}).
 */
function readValue(kind: ItemFieldKind, stored: unknown, clear: boolean): unknown {
  switch (kind.t) {
    case 'text':
    case 'ref':
      return typeof stored === 'string' ? stored : '';
    case 'flag':
      return stored === true;
    case 'enum':
      return typeof stored === 'string' ? stored : kind.def;
    case 'int':
      return wholeNumber(stored) ?? kind.def;
    case 'num':
      return numberOf(stored);
    case 'refs':
      return textsOf(stored);
    case 'terminals':
      return terminalsOf(stored);
    case 'object':
      return readFields(kind.fields, isPlain(stored) ? stored : {}, clear);
    case 'list':
      return readItems(kind.item, stored, clear);
    case 'secret':
      return clear ? (typeof stored === 'string' && stored !== '' ? stored : null) : typeof stored === 'string' && stored !== '';
  }
}

/**
 * The keys of a definition read from a stored object. A credential is the flag `<key>Set`, never its value, except in the representation of the server of a store (`clear`), where it
 * is the key itself with its stored value (`null` when there is none) and there is no flag: the credential keys are always the `secret` kinds of the definition, in both forms.
 */
function readFields(fields: Readonly<Record<string, ItemFieldKind>>, stored: Document, clear: boolean): DomainItem {
  return Object.fromEntries(Object.entries(fields).map(([key, kind]) => [kind.t === 'secret' && !clear ? `${key}Set` : key, readValue(kind, stored[key], clear)]));
}

/**
 * The items of a stored list in the domain form. An item without an id is returned too, read only, with `id: ''` and `withoutId: true` (the list is then not writable, see `isEditable`);
 * what is not an object is left out.
 */
function readItems(def: ItemDef, stored: unknown, clear: boolean): DomainItem[] {
  return (Array.isArray(stored) ? (stored as unknown[]) : []).filter(isPlain).map((item) => {
    const id = itemKey(item);
    return id === undefined ? { id: '', withoutId: true, ...readFields(def.fields, item, clear) } : { id, ...readFields(def.fields, item, clear) };
  });
}

/** The stored item with the id, in a stored list. */
const itemOf = (stored: unknown, id: string): Document | undefined => (Array.isArray(stored) ? (stored as unknown[]).find((item): item is Document => itemKey(item) === id) : undefined);

/**
 * The fragment of an item for the write: the id, and for every key of the definition that differs from what the document has (or every key, for an item the document does not have) its
 * stored value. Compared in the domain form, so an unchanged value keeps its exact stored type, and a request that sends an item back as it was writes nothing of it. A credential is in
 * the fragment only when the request has it. An `object` key carries the keys that changed (all of them when the document has no such object), a `list` key the fragments of its items.
 *
 * @param def The definition of the item.
 * @param idKind What the id is in the document.
 * @param item The item of the request, complete (the service has completed it).
 * @param before The stored item with the same id, if any.
 * @param init Keys a new item is given once.
 */
function fragmentOf(def: ItemDef, idKind: 'text' | 'objectId', item: DomainItem, before: Document | undefined, init?: () => Document): Document {
  const id = item['id'] as string;
  const fragment: Document = { id: idKind === 'objectId' && ObjectId.isValid(id) && id.length === 24 ? ObjectId.createFromHexString(id) : id };
  const was = before === undefined ? undefined : readFields(def.fields, before, false);
  for (const [key, kind] of Object.entries(def.fields)) {
    const value = item[key];
    if (kind.t === 'secret') {
      if (value !== undefined) {
        fragment[key] = value;
      }
    } else if (kind.t === 'object') {
      // The keys that differ; all of them when the item has no such object yet and the request does not just send the defaults back.
      const same = was !== undefined && canonicalJson(value) === canonicalJson(was[key]);
      const changed = same ? [] : Object.entries(value as DomainItem).filter(([sub, subValue]) => !isPlain(before?.[key]) || canonicalJson(subValue) !== canonicalJson((was?.[key] as DomainItem)[sub]));
      if (changed.length > 0) {
        fragment[key] = Object.fromEntries(changed);
      }
    } else if (kind.t === 'list') {
      if (was === undefined || canonicalJson(value) !== canonicalJson(was[key])) {
        fragment[key] = (value as DomainItem[]).map((sub) => fragmentOf(kind.item, 'text', sub, itemOf(before?.[key], sub['id'] as string)));
      }
    } else if (was === undefined || canonicalJson(value) !== canonicalJson(was[key])) {
      fragment[key] = value;
    }
  }
  return before === undefined && init !== undefined ? { ...fragment, ...init() } : fragment;
}

/**
 * The codec of a list of items (`place-lists.ts`): the read gives the items in the domain form (a credential as its `<key>Set` flag), the write gives the fragments the writer lays over
 * the stored items inside the transaction.
 *
 * @param list The definition of the list.
 */
export function listCodec(list: ListDef): Codec {
  return codecOf(list, false);
}

/** The codec of a list, in the form of the backoffice (`clear` false) or of the server of a store (`clear` true: credentials in clear). The write is the same in both. */
function codecOf(list: ListDef, clear: boolean): Codec {
  return {
    read: (stored) => readItems(list, stored, clear),
    write: (value, stored) => (value as DomainItem[]).map((item) => fragmentOf(list, list.idKind, item, itemOf(stored, item['id'] as string), list.init)),
  };
}

/** The flag a block carries: whether its list can be written (no item without an id, tables included). It is never written. */
function editableCodec(list: ListDef): Codec {
  return { read: (stored) => isEditable(list, stored), write: (value) => value };
}

/**
 * A new item of the domain with the default of every key (a credential has none).
 *
 * @param def The definition of the item.
 */
export function newItem(def: ItemDef): DomainItem {
  return Object.fromEntries(Object.entries(def.fields).flatMap(([key, kind]) => (kind.t === 'secret' ? [] : [[key, defaultOf(kind)]])));
}

/** The leaves of the lists: the devices, the print stations and the production centers, the rooms and the storages, each a whole list of items. */
function leavesOf(clear: boolean): readonly Leaf[] {
  return Object.freeze([
    { domain: 'devices.items', legacy: 'devices', codec: codecOf(PLACE_LISTS.devices, clear) },
    { domain: 'devices.editable', legacy: 'devices', codec: editableCodec(PLACE_LISTS.devices), readOnly: true },
    { domain: 'printStations.stations', legacy: 'printStations', codec: codecOf(PLACE_LISTS.printStations, clear) },
    { domain: 'printStations.stationsEditable', legacy: 'printStations', codec: editableCodec(PLACE_LISTS.printStations), readOnly: true },
    { domain: 'printStations.productionCenters', legacy: 'productionCenter', codec: codecOf(PLACE_LISTS.productionCenter, clear) },
    { domain: 'printStations.productionCentersEditable', legacy: 'productionCenter', codec: editableCodec(PLACE_LISTS.productionCenter), readOnly: true },
    { domain: 'rooms.items', legacy: 'rooms', codec: codecOf(PLACE_LISTS.rooms, clear) },
    { domain: 'rooms.editable', legacy: 'rooms', codec: editableCodec(PLACE_LISTS.rooms), readOnly: true },
    { domain: 'storages.items', legacy: 'storages', codec: codecOf(PLACE_LISTS.storages, clear) },
    { domain: 'storages.editable', legacy: 'storages', codec: editableCodec(PLACE_LISTS.storages), readOnly: true },
  ]);
}

/** The leaves of the lists, for `PLACE_LEAVES`. */
export const LIST_LEAVES: readonly Leaf[] = leavesOf(false);

/** The same leaves for the server of the store itself: the credentials of the items are in clear. Only the store context reads through them. */
export const STORE_LIST_LEAVES: readonly Leaf[] = leavesOf(true);
