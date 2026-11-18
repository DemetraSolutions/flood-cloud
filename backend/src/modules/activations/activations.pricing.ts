import { ACTIVATION_PROVIDERS } from '../../shared/security/scope/mirror-activations.ts';
import { cleanText } from './activations.names.ts';
import { planPrice } from '../settings/price-list.ts';
import type { PriceList } from '../settings/price-list.ts';
import type { FeeItem } from './activations.types.ts';

/** The longest plan a line keeps: a plan longer than a plan key can be is never priced, and is cut so that a hostile value cannot grow a line. */
export const MAX_PLAN_LENGTH = 64;

/** The providers whose `status` makes the API service, besides the group's StatManager: every provider of the activations that is not a service of its own. */
const API_PROVIDERS: readonly string[] = ACTIVATION_PROVIDERS.filter((provider) => !['floodPay', 'reserveWithGoogle', 'bizerba'].includes(provider));

/** The types of handheld device: free, but shown. */
const HANDHELD_TYPES: readonly string[] = Object.freeze(['handheld', 'palmare', 'room-handheld']);

/** What decides the monthly fee of a place, read tolerantly from its copy, the copy of its company and its group: a wrong type counts as not active. */
export interface FeeFacts {
  /** The plan as stored (a non-empty text), or `null` when the place has none (absent, empty or not a text). */
  readonly plan: string | null;
  /** How many devices of type `desk`. */
  readonly desks: number;
  /** Whether at least one device is of type `kiosk`. */
  readonly kiosk: boolean;
  /** How many devices of type `kiosk`. */
  readonly kiosks: number;
  /** How many handhelds (`handheld`, `palmare`, `room-handheld`): free. */
  readonly handhelds: number;
  /** The integrations that make the API service: the provider keys that are on, then `statmanager` when the group has it on. */
  readonly apiProviders: readonly string[];
  readonly arubaEInvoicing: boolean;
  readonly floodPay: boolean;
  readonly reservationWidget: boolean;
  readonly reserveWithGoogle: boolean;
  readonly tobaccos: boolean;
  readonly bizerba: boolean;
  readonly api: boolean;
}

/** The part of a group the fee depends on. */
export interface GroupSwitches {
  /** `settings.tobaccosGamesMonopoly === true`. */
  readonly tobaccos: boolean;
  /** `settings.integrations.statmanager.status === true`: the API service of every place of the group. */
  readonly statManager: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at a path of nested documents, `undefined` as soon as a step is not a document. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** Whether the `status` of an integration, or of a switch, is strictly `true`. */
const isOn = (value: unknown, ...path: readonly string[]): boolean => at(value, ...path) === true;

/** The number of devices of a type in the list of devices of a place (anything that is not a list holds none). */
function devicesOf(place: unknown, type: string): number {
  const devices = at(place, 'devices');
  return Array.isArray(devices) ? devices.filter((device: unknown) => at(device, 'type') === type).length : 0;
}

/**
 * Reads what decides the fee of a place.
 *
 * @param place The copy of the place, as projected for the activations.
 * @param company The copy of its company, as projected for the activations.
 * @param group What the fee needs of its group.
 * @returns The facts.
 */
export function feeFactsOf(place: unknown, company: unknown, group: GroupSwitches): FeeFacts {
  const plan = cleanText(at(place, 'plan'), MAX_PLAN_LENGTH);
  const hub = at(company, 'fattura_elettronica', 'hub');
  const apiProviders = [...API_PROVIDERS.filter((provider) => isOn(place, 'integrations', provider, 'status')), ...(group.statManager ? ['statmanager'] : [])];
  return {
    plan: plan === '' ? null : plan,
    desks: devicesOf(place, 'desk'),
    kiosk: devicesOf(place, 'kiosk') > 0,
    kiosks: devicesOf(place, 'kiosk'),
    handhelds: HANDHELD_TYPES.reduce((sum, type) => sum + devicesOf(place, type), 0),
    apiProviders,
    arubaEInvoicing: typeof hub === 'string' && hub.toLowerCase().includes('aruba'),
    floodPay: isOn(place, 'integrations', 'floodPay', 'status'),
    reservationWidget: isOn(place, 'roomsSettings', 'reservation', 'status') && isOn(place, 'roomsSettings', 'reservation', 'webWidget', 'status'),
    reserveWithGoogle: isOn(place, 'integrations', 'reserveWithGoogle', 'status'),
    tobaccos: group.tobaccos && isOn(place, 'tgm', 'status'),
    bizerba: isOn(place, 'integrations', 'bizerba', 'status'),
    api: apiProviders.length > 0,
  };
}

/** The result of the fee of a place. */
export interface Fee {
  readonly items: readonly FeeItem[];
  readonly monthlyCents: number;
  /** The plan of the place has no price in the list that applies. */
  readonly unpricedPlan: boolean;
}

/**
 * The monthly fee of a place, as a list of items:
 *  - the plan (`plan:<plan>`, always: with no price in the list it is an item with `unitCents: null` and amount 0, and the fee is flagged);
 *  - the desks beyond the first (`extraDesk`);
 *  - the services the place has active, each once (`kiosk`, `arubaEInvoicing`, `floodPay`, `reservationWidget`, `reserveWithGoogle`, `tobaccos`, `bizerba`, `api`).
 * Every active service is an item, even one that costs nothing; the `api` item lists the integrations that make it. A service that is not active has no item, whatever its price. Nothing is ever `NaN`: every amount is an integer number of cents.
 *
 * @param facts What decides the fee.
 * @param prices The prices that apply: the list with the overrides of the dealer on top.
 */
export function monthlyFee(facts: FeeFacts, prices: PriceList): Fee {
  const planUnit = facts.plan === null ? null : planPrice(prices.plans, facts.plan);
  const items: FeeItem[] = [{ key: `plan:${facts.plan ?? ''}`, quantity: 1, unitCents: planUnit, amountCents: planUnit ?? 0 }];
  const service = (key: keyof PriceList['services'], quantity: number, providers?: readonly string[]): void => {
    const unit = prices.services[key];
    items.push({ key, quantity, unitCents: unit, amountCents: unit * quantity, ...(providers === undefined ? {} : { providers }) });
  };
  if (facts.desks > 1) {
    service('extraDesk', facts.desks - 1);
  }
  const switches: ReadonlyArray<readonly [keyof PriceList['services'], boolean]> = [
    ['kiosk', facts.kiosk],
    ['arubaEInvoicing', facts.arubaEInvoicing],
    ['floodPay', facts.floodPay],
    ['reservationWidget', facts.reservationWidget],
    ['reserveWithGoogle', facts.reserveWithGoogle],
    ['tobaccos', facts.tobaccos],
    ['bizerba', facts.bizerba],
    ['api', facts.api],
  ];
  for (const [key, active] of switches) {
    if (active) {
      service(key, 1, key === 'api' ? facts.apiProviders : undefined);
    }
  }
  return { items, monthlyCents: items.reduce((sum, item) => sum + item.amountCents, 0), unpricedPlan: planUnit === null };
}
