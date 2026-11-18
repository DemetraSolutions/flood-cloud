import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAN_LENGTH, feeFactsOf, monthlyFee } from '../../src/modules/activations/activations.pricing.ts';
import type { FeeFacts, GroupSwitches } from '../../src/modules/activations/activations.pricing.ts';
import { ACTIVATION_PROVIDERS } from '../../src/shared/security/scope/mirror-activations.ts';
import { DEFAULT_PRICE_LIST, MAX_PRICE_CENTS, effectivePrices, overridesOf, planPrice, priceListOf } from '../../src/modules/settings/price-list.ts';

const OFF: GroupSwitches = { tobaccos: false, statManager: false };
const NOTHING: FeeFacts = { plan: 'basic', desks: 0, kiosk: false, kiosks: 0, handhelds: 0, apiProviders: [], arubaEInvoicing: false, floodPay: false, reservationWidget: false, reserveWithGoogle: false, tobaccos: false, bizerba: false, api: false };

/** A place with the integrations given as `{ provider: status }`. */
const withIntegrations = (statuses: Record<string, unknown>) => ({ integrations: Object.fromEntries(Object.entries(statuses).map(([name, status]) => [name, { status }])) });

describe('the facts of a fee', () => {
  it('reads the plan: a non-empty text, cut to the longest plan; anything else is no plan', () => {
    assert.equal(feeFactsOf({ plan: 'professional' }, {}, OFF).plan, 'professional');
    for (const plan of [undefined, null, '', 7, true, {}, ['basic']]) {
      assert.equal(feeFactsOf({ plan }, {}, OFF).plan, null, String(plan));
    }
    assert.equal(feeFactsOf({ plan: 'x'.repeat(500) }, {}, OFF).plan, 'x'.repeat(MAX_PLAN_LENGTH));
  });

  it('counts the desks and tells the kiosks, tolerating a list of anything', () => {
    const devices = [{ type: 'desk' }, { type: 'desk' }, { type: 'desk' }, { type: 'kiosk' }, { type: 'printer' }, { type: 7 }, null, 'desk', ['desk'], {}];
    const facts = feeFactsOf({ devices }, {}, OFF);
    assert.deepEqual([facts.desks, facts.kiosk], [3, true]);
    for (const junk of [undefined, null, 'desk', 7, { type: 'desk' }, []]) {
      const none = feeFactsOf({ devices: junk }, {}, OFF);
      assert.deepEqual([none.desks, none.kiosk], [0, false]);
    }
    assert.deepEqual([feeFactsOf({ devices: [{ type: 'Desk' }, { type: 'KIOSK' }] }, {}, OFF).desks, feeFactsOf({ devices: [{ type: 'Desk' }] }, {}, OFF).kiosk], [0, false], 'the types are exact');
  });

  it('reads an integration only when its status is exactly true', () => {
    assert.equal(feeFactsOf(withIntegrations({ floodPay: true }), {}, OFF).floodPay, true);
    assert.equal(feeFactsOf(withIntegrations({ reserveWithGoogle: true }), {}, OFF).reserveWithGoogle, true);
    assert.equal(feeFactsOf(withIntegrations({ bizerba: true }), {}, OFF).bizerba, true);
    for (const wrong of [false, 'true', 1, null, undefined, {}, []]) {
      const facts = feeFactsOf(withIntegrations({ floodPay: wrong, reserveWithGoogle: wrong, bizerba: wrong, qodeup: wrong }), {}, OFF);
      assert.deepEqual([facts.floodPay, facts.reserveWithGoogle, facts.bizerba, facts.api], [false, false, false, false], String(wrong));
    }
    for (const junk of [undefined, null, 'x', 7, { floodPay: true }, { floodPay: null }, { floodPay: 'x' }]) {
      assert.equal(feeFactsOf({ integrations: junk }, {}, OFF).floodPay, false);
    }
  });

  it('makes the API service from any one of the nine providers, from StatManager of the group, and from none of the three that are services of their own', () => {
    const apiProviders = ACTIVATION_PROVIDERS.filter((provider) => !['floodPay', 'reserveWithGoogle', 'bizerba'].includes(provider));
    assert.deepEqual(apiProviders, ['qodeup', 'googleMaps', 'yellgo', 'leggimenu', 'plateform', 'cooperto', 'tomatoai', 'keenon', 'phlex']);
    for (const provider of apiProviders) {
      assert.equal(feeFactsOf(withIntegrations({ [provider]: true }), {}, OFF).api, true, provider);
    }
    assert.equal(feeFactsOf({}, {}, { tobaccos: false, statManager: true }).api, true);
    for (const provider of ['floodPay', 'reserveWithGoogle', 'bizerba', 'dojo', 'satispay', 'statmanager']) {
      assert.equal(feeFactsOf(withIntegrations({ [provider]: true }), {}, OFF).api, false, provider);
    }
    assert.equal(feeFactsOf({}, {}, OFF).api, false);
  });

  it('needs both switches for the reservation widget and for the tobacconist', () => {
    const both = { roomsSettings: { reservation: { status: true, webWidget: { status: true } } } };
    assert.equal(feeFactsOf(both, {}, OFF).reservationWidget, true);
    for (const partial of [
      { roomsSettings: { reservation: { status: true, webWidget: { status: false } } } },
      { roomsSettings: { reservation: { status: false, webWidget: { status: true } } } },
      { roomsSettings: { reservation: { status: true } } },
      { roomsSettings: { reservation: null } },
      { roomsSettings: 'x' },
      { roomsSettings: null },
      {},
    ]) {
      assert.equal(feeFactsOf(partial, {}, OFF).reservationWidget, false, JSON.stringify(partial));
    }
    const tobacconist = { tgm: { status: true } };
    assert.equal(feeFactsOf(tobacconist, {}, { tobaccos: true, statManager: false }).tobaccos, true);
    assert.equal(feeFactsOf(tobacconist, {}, OFF).tobaccos, false, 'the group switch is needed');
    assert.equal(feeFactsOf({ tgm: { status: false } }, {}, { tobaccos: true, statManager: false }).tobaccos, false, 'and so is the place switch');
    assert.equal(feeFactsOf({ tgm: 'yes' }, {}, { tobaccos: true, statManager: false }).tobaccos, false);
    assert.equal(feeFactsOf({}, {}, { tobaccos: true, statManager: false }).tobaccos, false);
  });

  it('tells the electronic invoicing of Aruba from a hub that contains the word, in any case, and from nothing else', () => {
    for (const hub of ['aruba', 'Aruba', 'ARUBA PEC', 'hub-aruba-2']) {
      assert.equal(feeFactsOf({}, { fattura_elettronica: { hub } }, OFF).arubaEInvoicing, true, hub);
    }
    for (const company of [{ fattura_elettronica: { hub: 'other' } }, { fattura_elettronica: { hub: 7 } }, { fattura_elettronica: { hub: null } }, { fattura_elettronica: null }, { fattura_elettronica: 'aruba' }, {}, null, undefined]) {
      assert.equal(feeFactsOf({}, company, OFF).arubaEInvoicing, false, JSON.stringify(company));
    }
  });

  it('tolerates a place that is not a document at all', () => {
    for (const place of [null, undefined, 'place', 7, []]) {
      assert.deepEqual(feeFactsOf(place, null, OFF), { plan: null, desks: 0, kiosk: false, kiosks: 0, handhelds: 0, apiProviders: [], arubaEInvoicing: false, floodPay: false, reservationWidget: false, reserveWithGoogle: false, tobaccos: false, bizerba: false, api: false });
    }
  });
});

describe('the devices and the providers of the facts', () => {
  it('counts the desks, the kiosks and the handhelds (the three free types), and lists the providers that make the API in order, StatManager last', () => {
    const place = { devices: [{ type: 'desk' }, { type: 'kiosk' }, { type: 'kiosk' }, { type: 'handheld' }, { type: 'palmare' }, { type: 'room-handheld' }, { type: 'printer' }], ...withIntegrations({ yellgo: true, qodeup: true, floodPay: true, bizerba: true }) };
    const facts = feeFactsOf(place, {}, { tobaccos: false, statManager: true });
    assert.deepEqual([facts.desks, facts.kiosks, facts.handhelds, facts.apiProviders], [1, 2, 3, ['qodeup', 'yellgo', 'statmanager']]);
    assert.deepEqual(feeFactsOf(place, {}, OFF).apiProviders, ['qodeup', 'yellgo']);
    assert.deepEqual(feeFactsOf({}, {}, OFF).apiProviders, []);
  });
});

describe('the monthly fee of a place', () => {
  const prices = DEFAULT_PRICE_LIST;

  it('is the price of the plan alone for a place with nothing else, and the plan item is always there', () => {
    assert.deepEqual(monthlyFee(NOTHING, prices), { items: [{ key: 'plan:basic', quantity: 1, unitCents: 2000, amountCents: 2000 }], monthlyCents: 2000, unpricedPlan: false });
    for (const [plan, cents] of [['advanced', 3000], ['enterprice', 4000], ['tgm-secondary', 0], ['desk-secondary', 500]] as const) {
      const fee = monthlyFee({ ...NOTHING, plan }, prices);
      assert.deepEqual([fee.monthlyCents, fee.items[0]!.amountCents, fee.unpricedPlan], [cents, cents, false], plan);
    }
  });

  it('adds every service, and only the ones that are active, at their price and quantity', () => {
    const everything: FeeFacts = { plan: 'advanced', desks: 3, kiosk: true, kiosks: 1, handhelds: 0, apiProviders: ['qodeup', 'statmanager'], arubaEInvoicing: true, floodPay: true, reservationWidget: true, reserveWithGoogle: true, tobaccos: true, bizerba: true, api: true };
    const fee = monthlyFee(everything, prices);
    assert.deepEqual(
      fee.items.map((item) => [item.key, item.quantity, item.unitCents, item.amountCents]),
      [['plan:advanced', 1, 3000, 3000], ['extraDesk', 2, 500, 1000], ['kiosk', 1, 1500, 1500], ['arubaEInvoicing', 1, 0, 0], ['floodPay', 1, 1500, 1500], ['reservationWidget', 1, 1000, 1000], ['reserveWithGoogle', 1, 0, 0], ['tobaccos', 1, 1300, 1300], ['bizerba', 1, 0, 0], ['api', 1, 500, 500]],
    );
    assert.deepEqual(fee.items.find((item) => item.key === 'api')!.providers, ['qodeup', 'statmanager']);
    assert.ok(fee.items.filter((item) => item.key !== 'api').every((item) => item.providers === undefined));
    assert.equal(fee.monthlyCents, 3000 + 1000 + 1500 + 1500 + 1000 + 1300 + 500);
    for (const [name, facts, key] of [
      ['kiosk', { kiosk: true }, 'kiosk'],
      ['floodPay', { floodPay: true }, 'floodPay'],
      ['api', { api: true }, 'api'],
      ['tobaccos', { tobaccos: true }, 'tobaccos'],
      ['bizerba', { bizerba: true }, 'bizerba'],
      ['reservationWidget', { reservationWidget: true }, 'reservationWidget'],
      ['reserveWithGoogle', { reserveWithGoogle: true }, 'reserveWithGoogle'],
      ['arubaEInvoicing', { arubaEInvoicing: true }, 'arubaEInvoicing'],
    ] as const) {
      assert.deepEqual(monthlyFee({ ...NOTHING, ...facts }, prices).items.map((item) => item.key), ['plan:basic', key], name);
    }
  });

  it('charges the desks beyond the first and nothing for the first, and a kiosk once whatever their number', () => {
    for (const [desks, extra] of [[0, 0], [1, 0], [2, 1], [5, 4]] as const) {
      const fee = monthlyFee({ ...NOTHING, desks }, prices);
      assert.equal(fee.monthlyCents, 2000 + 500 * extra, String(desks));
      assert.equal(fee.items.some((item) => item.key === 'extraDesk'), extra > 0);
    }
  });

  it('gives a plan with no price an item with no unit price, amount 0 and the flag, never NaN or an exception', () => {
    for (const plan of ['professional', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'BASIC']) {
      const fee = monthlyFee({ ...NOTHING, plan, desks: 2, api: true }, prices);
      assert.deepEqual(fee.items[0], { key: `plan:${plan}`, quantity: 1, unitCents: null, amountCents: 0 }, plan);
      assert.equal(fee.unpricedPlan, true);
      assert.equal(fee.monthlyCents, 1000, 'the services are still charged');
    }
    const none = monthlyFee({ ...NOTHING, plan: null }, prices);
    assert.deepEqual([none.items[0], none.unpricedPlan, none.monthlyCents], [{ key: 'plan:', quantity: 1, unitCents: null, amountCents: 0 }, true, 0]);
    assert.ok(Number.isInteger(none.monthlyCents));
  });

  it('uses the prices it is given, the plan and each service one by one', () => {
    const custom = effectivePrices(prices, { plans: { basic: 1234, professional: 2700 }, services: { extraDesk: 111, api: 0 } });
    assert.equal(monthlyFee({ ...NOTHING, desks: 3, api: true }, custom).monthlyCents, 1234 + 222 + 0);
    assert.equal(monthlyFee({ ...NOTHING, plan: 'professional' }, custom).monthlyCents, 2700);
    assert.equal(monthlyFee({ ...NOTHING, plan: 'advanced', kiosk: true }, custom).monthlyCents, 3000 + 1500, 'what is not overridden stays the list price');
  });
});

describe('the price list', () => {
  it('has the prices of the legacy page as its default', () => {
    assert.deepEqual(DEFAULT_PRICE_LIST.plans, { basic: 2000, advanced: 3000, enterprice: 4000, 'tgm-secondary': 0, 'desk-secondary': 500 });
    assert.deepEqual(DEFAULT_PRICE_LIST.services, { extraDesk: 500, kiosk: 1500, api: 500, tobaccos: 1300, reservationWidget: 1000, floodPay: 1500, arubaEInvoicing: 0, reserveWithGoogle: 0, bizerba: 0 });
    assert.ok(Object.isFrozen(DEFAULT_PRICE_LIST) && Object.isFrozen(DEFAULT_PRICE_LIST.plans) && Object.isFrozen(DEFAULT_PRICE_LIST.services));
  });

  it('reads a stored list tolerantly: the plans that are well formed by key, the services one by one with the default for a missing one, and the default for no list', () => {
    assert.equal(priceListOf(null), DEFAULT_PRICE_LIST);
    const stored = priceListOf({ plans: { zeta: 5, alfa: 7, 'bad key': 1, neg: -1, frac: 1.5, huge: MAX_PRICE_CENTS + 1, text: '5', ok_2: MAX_PRICE_CENTS }, services: { kiosk: 99, api: 'x', extraDesk: -1 } });
    assert.deepEqual(Object.keys(stored.plans), ['alfa', 'ok_2', 'zeta'], 'sorted, and only the valid ones');
    assert.deepEqual(stored.plans, { alfa: 7, ok_2: MAX_PRICE_CENTS, zeta: 5 });
    assert.deepEqual(stored.services, { ...DEFAULT_PRICE_LIST.services, kiosk: 99 });
    for (const junk of [undefined, 'x', 7, [], { plans: 'x', services: 'y' }, { plans: [], services: [] }]) {
      assert.deepEqual(priceListOf(junk), { plans: {}, services: DEFAULT_PRICE_LIST.services }, JSON.stringify(junk));
    }
    const many = Object.fromEntries(Array.from({ length: 40 }, (_value, index) => [`p${String(index).padStart(2, '0')}`, index]));
    assert.equal(Object.keys(priceListOf({ plans: many, services: {} }).plans).length, 30);
  });

  it('reads the overrides of a dealer tolerantly, keeping only what is well formed, in the order of the list', () => {
    assert.deepEqual(overridesOf(undefined), {});
    assert.deepEqual(overridesOf({}), {});
    assert.deepEqual(overridesOf({ plans: {}, services: {} }), {});
    assert.deepEqual(overridesOf({ plans: { b: 2, a: 1, 'x y': 3 }, services: { kiosk: 5, nothing: 5, api: 'x' } }), { plans: { a: 1, b: 2 }, services: { kiosk: 5 } });
    assert.deepEqual(overridesOf({ services: { bizerba: 0, extraDesk: 9 } }), { services: { extraDesk: 9, bizerba: 0 } });
    for (const junk of [null, 'x', 7, [], { plans: 'x', services: 7 }]) {
      assert.deepEqual(overridesOf(junk), {});
    }
  });

  it('puts the overrides on top of the list key by key, and adds the plans the list does not have', () => {
    const effective = effectivePrices(DEFAULT_PRICE_LIST, { plans: { basic: 1, professional: 2 }, services: { kiosk: 3 } });
    assert.deepEqual(effective.plans, { ...DEFAULT_PRICE_LIST.plans, basic: 1, professional: 2 });
    assert.deepEqual(effective.services, { ...DEFAULT_PRICE_LIST.services, kiosk: 3 });
    assert.deepEqual(effectivePrices(DEFAULT_PRICE_LIST, {}), { plans: DEFAULT_PRICE_LIST.plans, services: DEFAULT_PRICE_LIST.services });
  });

  it('prices a plan only if the list has it itself', () => {
    assert.equal(planPrice({ basic: 5 }, 'basic'), 5);
    assert.equal(planPrice({ zero: 0 }, 'zero'), 0);
    for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(planPrice({}, inherited), null, inherited);
    }
    assert.equal(planPrice({ basic: 5 }, 'advanced'), null);
  });
});
