import { nullable, number, object } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import type { Outcome } from './catalog.ts';
import { SAFE_ID, equal, isRecord, notFound, numberOf } from './kit.ts';

/** Most loyalty rules: one per currency. */
export const MAX_FIDELITY_CARD_RULES = 10;

/**
 * The loyalty rule of a currency (legacy `fidelityCardRules.<currency>`, a map keyed by the currency code: `{ code, value, discountPercentage }`).
 * Mapping: `value` is `pointValue`, the amount of money one point is worth. There is one rule for each currency of the group.
 */
export interface FidelityCardRule {
  readonly currency: string;
  readonly pointValue: number | null;
  readonly discountPercentage: number | null;
}

const pointValue = nullable(number({ min: 0 }));
const discountPercentage = nullable(number({ min: 0, max: 100 }));

/** Body of the replacement of a loyalty rule (`PUT`): both values, `null` to clear. */
export const putFidelityCardRuleBody = object({ pointValue, discountPercentage });

type PutBody = Infer<typeof putFidelityCardRuleBody>;

/** The stored rule of a currency, or an empty one. */
function storedRule(state: { raw(path: string): unknown }, code: string): Record<string, unknown> | undefined {
  const rules = state.raw('fidelityCardRules');
  const rule = isRecord(rules) ? rules[code] : undefined;
  return isRecord(rule) ? rule : undefined;
}

const elementOf = (code: string, rule: Record<string, unknown> | undefined): FidelityCardRule => ({
  currency: code,
  pointValue: numberOf(rule?.['value']),
  discountPercentage: numberOf(rule?.['discountPercentage']),
});

const toRaw = (element: FidelityCardRule, raw: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> => ({
  ...raw,
  code: element.currency,
  value: element.pointValue,
  discountPercentage: element.discountPercentage,
});

/**
 * The loyalty rules (`/fidelity-card-rules`): one per currency of the group, so there is no creation and no deletion (a currency brings its rule and takes it away);
 * a rule is replaced with `PUT /fidelity-card-rules/{currency}`. A currency without a stored rule is listed with both values `null`.
 */
export const fidelityCardRules = defineCatalog<FidelityCardRule, object, PutBody>({
  name: 'fidelityCardRule',
  segment: 'fidelity-card-rules',
  path: 'fidelityCardRules',
  kind: 'map',
  limit: MAX_FIDELITY_CARD_RULES,
  extraPaths: ['currencies'],
  idKey: 'currency',
  readPermission: 'groups:read',
  updatePermission: 'groups:update',
  operations: { patch: 'PUT' },
  patchSchema: putFidelityCardRuleBody,
  toElement: elementOf,
  toRaw,
  list: (state) => {
    const currencies = state.raw('currencies');
    return (isRecord(currencies) ? Object.keys(currencies) : []).map((code) => elementOf(code, storedRule(state, code)));
  },
  patchOverride: (id, body, state): Outcome<FidelityCardRule> => {
    const currencies = state.raw('currencies');
    if (!SAFE_ID.test(id) || !isRecord(currencies) || !Object.hasOwn(currencies, id)) {
      throw notFound();
    }
    const existing = storedRule(state, id);
    const before = elementOf(id, existing);
    const after: FidelityCardRule = { currency: id, ...body };
    const stored = state.raw('fidelityCardRules');
    const next = { ...(isRecord(stored) ? stored : {}), [id]: toRaw(after, existing) };
    const change = { path: 'fidelityCardRules', kind: 'map' as const, old: stored, next };
    return { before, after, changes: equal(change.old, change.next) ? [] : [change], references: [] };
  },
});
