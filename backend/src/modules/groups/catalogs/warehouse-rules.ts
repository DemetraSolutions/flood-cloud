import { boolean, enumOf, object, optional, personName } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { choiceOf, conflict, flagOf, invalid, textOf } from './kit.ts';

/** Most warehouse rules a group may have. */
export const MAX_WAREHOUSE_RULES = 50;

const TYPES = ['load', 'unload'] as const;
const SIGNS = ['=', '+', '-'] as const;
const COUNTERPARTS = ['suppliers', 'customers', 'indoor'] as const;
const LEGACY_TYPES = ['L', 'D'] as const;

/**
 * A warehouse rule (legacy `warehouseRules.<id>`, a map keyed by the id). Mapping: `type` is `load` for `L` and `unload` for `D`; `default` is
 * `isDefault`; `cashL` is `cashLoad` and `cashD` is `cashUnload`. `quantity` and `value` say how a movement changes the stock and its value (`=` keeps,
 * `+` adds, `-` subtracts). A value outside the allowed ones in a stored rule is shown as `null` and kept in the database.
 */
export interface WarehouseRule {
  readonly id: string;
  readonly type: (typeof TYPES)[number] | null;
  readonly name: string;
  readonly quantity: (typeof SIGNS)[number] | null;
  readonly value: (typeof SIGNS)[number] | null;
  /** Only an unload rule uses the unit of the load. */
  readonly useLoadUnit: boolean;
  readonly counterpart: (typeof COUNTERPARTS)[number] | null;
  /** The standard rules created with the group: they cannot be changed or deleted. */
  readonly isDefault: boolean;
  /** The load rule the cash register uses (the customer return); at most one. */
  readonly cashLoad: boolean;
  /** The unload rule the cash register uses (the sale); at most one. */
  readonly cashUnload: boolean;
}

const fields = {
  name: personName(100),
  quantity: enumOf(SIGNS),
  value: enumOf(SIGNS),
  counterpart: enumOf(COUNTERPARTS),
  useLoadUnit: boolean(),
  cashLoad: boolean(),
  cashUnload: boolean(),
};

/** Body of the creation of a warehouse rule. A rule created by the client is never a default one. */
export const createWarehouseRuleBody = object({
  type: enumOf(TYPES),
  name: fields.name,
  quantity: fields.quantity,
  value: fields.value,
  counterpart: fields.counterpart,
  useLoadUnit: optional(fields.useLoadUnit),
  cashLoad: optional(fields.cashLoad),
  cashUnload: optional(fields.cashUnload),
});

/** Body of the modification of a warehouse rule (JSON Merge Patch): the type cannot change. */
export const patchWarehouseRuleBody = object({
  name: optional(fields.name),
  quantity: optional(fields.quantity),
  value: optional(fields.value),
  counterpart: optional(fields.counterpart),
  useLoadUnit: optional(fields.useLoadUnit),
  cashLoad: optional(fields.cashLoad),
  cashUnload: optional(fields.cashUnload),
});

type CreateBody = Infer<typeof createWarehouseRuleBody>;
type PatchBody = Infer<typeof patchWarehouseRuleBody>;

/**
 * The warehouse rules (`/warehouse-rules`). The default rules cannot be modified or deleted (`409 default`). A rule can carry the `cashLoad`
 * flag only if it is a load rule and `cashUnload` only if it is an unload rule (`422 notAllowed`), and only one rule of the group has each (`409 taken`).
 * The keys this backend does not manage (`priceType`…) stay as they are.
 */
export const warehouseRules = defineCatalog<WarehouseRule, CreateBody, PatchBody>({
  name: 'warehouseRule',
  segment: 'warehouse-rules',
  path: 'warehouseRules',
  kind: 'map',
  limit: MAX_WAREHOUSE_RULES,
  idKey: 'id',
  readPermission: 'groups:read',
  updatePermission: 'groups:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createWarehouseRuleBody,
  patchSchema: patchWarehouseRuleBody,
  toElement: (id, raw, anomalies) => {
    const legacyType = choiceOf(raw['type'], LEGACY_TYPES, `warehouseRules.${id}.type`, anomalies);
    return {
      id,
      type: legacyType === null ? null : legacyType === 'L' ? 'load' : 'unload',
      name: textOf(raw['name']) ?? '',
      quantity: choiceOf(raw['quantity'], SIGNS, `warehouseRules.${id}.quantity`, anomalies),
      value: choiceOf(raw['value'], SIGNS, `warehouseRules.${id}.value`, anomalies),
      useLoadUnit: flagOf(raw['useLoadUnit']),
      counterpart: choiceOf(raw['counterpart'], COUNTERPARTS, `warehouseRules.${id}.counterpart`, anomalies),
      isDefault: flagOf(raw['default']),
      cashLoad: flagOf(raw['cashL']),
      cashUnload: flagOf(raw['cashD']),
    };
  },
  defaults: (id, body) => ({ id, type: body.type, name: '', quantity: '=', value: '=', useLoadUnit: false, counterpart: 'suppliers', isDefault: false, cashLoad: false, cashUnload: false }),
  toRaw: (element, raw) => ({
    ...raw,
    id: element.id,
    type: element.type === null ? raw?.['type'] : element.type === 'load' ? 'L' : 'D',
    name: element.name,
    quantity: element.quantity ?? raw?.['quantity'],
    value: element.value ?? raw?.['value'],
    useLoadUnit: element.useLoadUnit,
    counterpart: element.counterpart ?? raw?.['counterpart'],
    default: element.isDefault,
    ...(element.type === 'load' || raw?.['cashL'] !== undefined ? { cashL: element.cashLoad } : {}),
    ...(element.type === 'unload' || raw?.['cashD'] !== undefined ? { cashD: element.cashUnload } : {}),
  }),
  check: ({ element, current, body, others }) => {
    if (current?.isDefault === true) {
      throw conflict('id', 'default');
    }
    if (body.useLoadUnit === true && element.type !== 'unload') {
      throw invalid('useLoadUnit', 'notAllowed');
    }
    if (body.cashLoad === true && element.type !== 'load') {
      throw invalid('cashLoad', 'notAllowed');
    }
    if (body.cashUnload === true && element.type !== 'unload') {
      throw invalid('cashUnload', 'notAllowed');
    }
    if (body.cashLoad === true && others.some((other) => other.cashLoad)) {
      throw conflict('cashLoad', 'taken');
    }
    if (body.cashUnload === true && others.some((other) => other.cashUnload)) {
      throw conflict('cashUnload', 'taken');
    }
    return [];
  },
  guardRemove: (element) => {
    if (element.isDefault) {
      throw conflict('id', 'default');
    }
  },
});
