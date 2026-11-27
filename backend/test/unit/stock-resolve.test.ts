import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { collectCatalogIds, MAX_STOCK_DEPTH, resolveStockLines, roundStock } from '../../src/modules/stock/stock.resolve.ts';
import type { StockLine, StockProduct } from '../../src/modules/stock/stock.resolve.ts';

type Spec = {
  readonly warehouse?: boolean;
  readonly ratio?: unknown;
  readonly type?: unknown;
  readonly bundle?: readonly { readonly of: StockProduct; readonly quantity: unknown; readonly waste?: unknown }[];
  readonly barcode?: readonly { value: unknown; qtLoad: unknown }[];
};

/** A product of the catalog; components are given as products already built, so a chain is built bottom up. */
function product(spec: Spec = {}): StockProduct {
  return {
    _id: new ObjectId(),
    type: spec.type ?? 'product',
    availability: { pos: true, warehouse: spec.warehouse ?? false },
    measureConversionRatio: 'ratio' in spec ? spec.ratio : 1,
    bundleProducts: (spec.bundle ?? []).map((item) => ({ _id: item.of._id, quantity: item.quantity, waste: item.waste ?? 0 })),
    barcode: spec.barcode ?? [],
    code: 'C',
    name: { it: 'N' },
    measureLoad: 'cs',
    weightedAveragePrice: null,
  };
}
const idOf = (item: StockProduct): string => item._id.toHexString();
const catalogOf = (...items: StockProduct[]): Map<string, StockProduct> => new Map(items.map((item) => [idOf(item), item]));
const sale = (item: StockProduct, quantity: number, extra: Partial<StockLine> = {}): StockLine => ({ productId: idOf(item), quantity, unit: 'sale', ...extra });
const load = (item: StockProduct, quantity: number, extra: Partial<StockLine> = {}): StockLine => ({ productId: idOf(item), quantity, unit: 'load', ...extra });
const deltasOf = (result: { deltas: Map<string, number> }): Record<string, number> => Object.fromEntries(result.deltas);

describe('the resolution of the lines of the stock', () => {
  it('rounds to six decimals and never leaves a negative zero', () => {
    assert.equal(roundStock(0.1 + 0.2), 0.3);
    assert.equal(roundStock(1 / 3), 0.333333);
    assert.ok(Object.is(roundStock(-0.0000001), 0));
    assert.ok(Object.is(roundStock(-0), 0));
  });

  it('converts a product kept in stock: a sale unloads quantity / ratio, a return with the sale unit loads the same', () => {
    const cases = product({ warehouse: true, ratio: 24 });
    assert.deepEqual(deltasOf(resolveStockLines([sale(cases, 6)], 'unload', catalogOf(cases))), { [idOf(cases)]: -0.25 });
    // The legacy loaded +6 here.
    assert.deepEqual(deltasOf(resolveStockLines([sale(cases, 6)], 'load', catalogOf(cases))), { [idOf(cases)]: 0.25 });
  });

  it('keeps the load unit as it is, multiplies it by the qtLoad of the barcode that was read, and ignores the barcode on a sale line', () => {
    const cases = product({
      warehouse: true,
      ratio: 24,
      barcode: [
        { value: 'PACK', qtLoad: 6 },
        { value: 'ZERO', qtLoad: 0 },
        { value: 'TEXT', qtLoad: '6' },
        { value: 'NONE', qtLoad: null },
      ],
    });
    const catalog = catalogOf(cases);
    const run = (line: StockLine, direction: 'load' | 'unload' = 'load') => deltasOf(resolveStockLines([line], direction, catalog))[idOf(cases)];
    assert.equal(run(load(cases, 2)), 2);
    assert.equal(run(load(cases, 2, { barcode: 'PACK' })), 12);
    assert.equal(run(load(cases, 2, { barcode: 'PACK' }), 'unload'), -12);
    assert.equal(run(load(cases, 2, { barcode: 'ZERO' })), 2);
    assert.equal(run(load(cases, 2, { barcode: 'TEXT' })), 2);
    assert.equal(run(load(cases, 2, { barcode: 'NONE' })), 2);
    assert.equal(run(load(cases, 2, { barcode: 'OTHER' })), 2);
    assert.equal(run(sale(cases, 24, { barcode: 'PACK' })), 1);
  });

  it('uses 1 with an invalidRatio anomaly when the ratio is not a finite number greater than zero, and only where the ratio is used', () => {
    for (const ratio of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY, '24', null, undefined]) {
      const item = product({ warehouse: true, ratio });
      const result = resolveStockLines([sale(item, 6)], 'unload', catalogOf(item));
      assert.deepEqual(deltasOf(result), { [idOf(item)]: -6 });
      assert.deepEqual(result.anomalies, [{ code: 'invalidRatio', productId: idOf(item) }]);
    }
    // A load line of a product kept in stock never needs the ratio.
    const broken = product({ warehouse: true, ratio: 0 });
    assert.deepEqual(resolveStockLines([load(broken, 2)], 'load', catalogOf(broken)).anomalies, []);
    // The anomaly is reported once however many lines have it.
    const twice = resolveStockLines([sale(broken, 1), sale(broken, 2)], 'unload', catalogOf(broken));
    assert.equal(twice.anomalies.length, 1);
  });

  it('skips a service without a word and reports a product that is not in the catalog', () => {
    const service = product({ type: 'service', warehouse: true });
    const ghost = product();
    const result = resolveStockLines([sale(service, 1), sale(ghost, 1), sale(ghost, 2)], 'unload', catalogOf(service));
    assert.equal(result.deltas.size, 0);
    assert.deepEqual(result.anomalies, [{ code: 'productMissing', productId: idOf(ghost) }]);
    assert.deepEqual(collectCatalogIds(result.anomalies), [idOf(ghost)]);
    assert.deepEqual(collectCatalogIds([{ code: 'noCashStorage' }, { code: 'cycle', productId: 'x' }]), []);
  });

  it('expands the bill of a product that is not kept in stock in the load unit of the component, whatever the way', () => {
    const ham = product({ warehouse: true, ratio: 1000 });
    const roll = product({ bundle: [{ of: ham, quantity: 0.05 }] });
    const catalog = catalogOf(ham, roll);
    const sold = resolveStockLines([sale(roll, 2)], 'unload', catalog);
    assert.deepEqual(deltasOf(sold), { [idOf(ham)]: -0.1 });
    assert.deepEqual(sold.anomalies, []);
    // A return and a manual unload give the same quantity as the sale (the ratio of the component is never used; the parent has ratio 1).
    assert.deepEqual(deltasOf(resolveStockLines([sale(roll, 2)], 'load', catalog)), { [idOf(ham)]: 0.1 });
    assert.deepEqual(deltasOf(resolveStockLines([load(roll, 2)], 'unload', catalog)), { [idOf(ham)]: -0.1 });
  });

  it('turns a load line of the parent into units of its bill with the ratio of the parent, and reports a ratio that does not work', () => {
    const flour = product({ warehouse: true });
    const box = product({ ratio: 4, bundle: [{ of: flour, quantity: 1 }] });
    assert.deepEqual(deltasOf(resolveStockLines([load(box, 2)], 'unload', catalogOf(flour, box))), { [idOf(flour)]: -8 });
    const broken = product({ ratio: 'x', bundle: [{ of: flour, quantity: 1 }] });
    const result = resolveStockLines([load(broken, 2)], 'unload', catalogOf(flour, broken));
    assert.deepEqual(deltasOf(result), { [idOf(flour)]: -2 });
    assert.deepEqual(result.anomalies, [{ code: 'invalidRatio', productId: idOf(broken) }]);
  });

  it('adds the waste to a component, and takes an invalid waste as zero', () => {
    const flour = product({ warehouse: true });
    const item = (waste: unknown) => product({ bundle: [{ of: flour, quantity: 2, waste }] });
    for (const waste of [10, 0, Number.NaN, -5, '10', null, undefined]) {
      const parent = item(waste);
      const result = resolveStockLines([sale(parent, 1)], 'unload', catalogOf(flour, parent));
      assert.equal(result.deltas.get(idOf(flour)), waste === 10 ? -2.2 : -2, String(waste));
    }
  });

  it('follows a chain of intermediates whose bill is for one load unit of the intermediate', () => {
    const flour = product({ warehouse: true });
    const dough = product({ ratio: 10, bundle: [{ of: flour, quantity: 0.6 }] });
    const roll = product({ bundle: [{ of: dough, quantity: 0.2 }] });
    assert.deepEqual(deltasOf(resolveStockLines([sale(roll, 1)], 'unload', catalogOf(flour, dough, roll))), { [idOf(flour)]: -0.12 });
    // An intermediate without a bill, and a component with an invalid quantity, move nothing.
    const empty = product();
    const odd = product({ bundle: [{ of: empty, quantity: 1 }, { of: flour, quantity: 'many' }, { of: flour, quantity: Number.NaN }] });
    assert.equal(resolveStockLines([sale(odd, 1)], 'unload', catalogOf(flour, empty, odd)).deltas.size, 0);
  });

  it('skips the services among the components and reports the components that are not in the catalog', () => {
    const service = product({ type: 'service' });
    const ghost = product();
    const parent = product({ bundle: [{ of: service, quantity: 1 }, { of: ghost, quantity: 1 }] });
    const result = resolveStockLines([sale(parent, 1)], 'unload', catalogOf(service, parent));
    assert.equal(result.deltas.size, 0);
    assert.deepEqual(result.anomalies, [{ code: 'productMissing', productId: idOf(ghost) }]);
  });

  it('moves only a product kept in stock itself, whatever its bill or its modular selections', () => {
    const part = product({ warehouse: true });
    const choice = product({ warehouse: true });
    const kit = product({ warehouse: true, bundle: [{ of: part, quantity: 3 }] });
    const result = resolveStockLines([sale(kit, 2, { modularSelections: [{ productId: idOf(choice), quantity: 1 }] })], 'unload', catalogOf(part, choice, kit));
    assert.deepEqual(deltasOf(result), { [idOf(kit)]: -2 });
  });

  it('resolves the modular selections as sale lines of their own quantity, in the load unit of each', () => {
    const cases = product({ warehouse: true, ratio: 24 });
    const bottle = product({ warehouse: true, ratio: 6 });
    const menu = product();
    const lines = [sale(menu, 3, { modularSelections: [{ productId: idOf(cases), quantity: 12 }, { productId: idOf(bottle), quantity: 3 }] })];
    // The selections are already scaled by the till: 3 menus do not multiply them again.
    const result = resolveStockLines(lines, 'unload', catalogOf(cases, bottle, menu));
    assert.deepEqual(deltasOf(result), { [idOf(cases)]: -0.5, [idOf(bottle)]: -0.5 });
    assert.deepEqual(deltasOf(resolveStockLines(lines, 'load', catalogOf(cases, bottle, menu))), { [idOf(cases)]: 0.5, [idOf(bottle)]: 0.5 });
    // A menu with both a bill and selections moves both; one with neither moves nothing.
    const part = product({ warehouse: true });
    const both = product({ bundle: [{ of: part, quantity: 1 }] });
    assert.deepEqual(deltasOf(resolveStockLines([sale(both, 2, { modularSelections: [{ productId: idOf(bottle), quantity: 6 }] })], 'unload', catalogOf(part, both, bottle))), { [idOf(part)]: -2, [idOf(bottle)]: -1 });
    assert.equal(resolveStockLines([sale(menu, 1)], 'unload', catalogOf(menu)).deltas.size, 0);
  });

  it('skips a cycle with an anomaly, and the branch only', () => {
    const flour = product({ warehouse: true });
    const a = product({ bundle: [{ of: flour, quantity: 1 }] });
    const b = product({ bundle: [{ of: a, quantity: 1 }] });
    // a -> b -> a, and a -> itself.
    const looped = { ...a, bundleProducts: [...a.bundleProducts, { _id: b._id, quantity: 1, waste: 0 }, { _id: a._id, quantity: 1, waste: 0 }] };
    const result = resolveStockLines([sale(looped, 1)], 'unload', catalogOf(flour, looped, b));
    assert.deepEqual(deltasOf(result), { [idOf(flour)]: -1 });
    assert.deepEqual(result.anomalies, [
      { code: 'cycle', productId: idOf(looped) },
    ]);
  });

  it('follows ten levels of components and refuses the eleventh with an anomaly', () => {
    const flour = product({ warehouse: true });
    const chain = (levels: number): { all: StockProduct[]; top: StockProduct } => {
      let below: StockProduct = flour;
      const all = [flour];
      for (let level = 0; level < levels; level += 1) {
        below = product({ bundle: [{ of: below, quantity: 1 }] });
        all.push(below);
      }
      return { all, top: below };
    };
    // The top is level 0 and its components are level 1: with ten intermediates the flour is at level 10, the deepest one followed.
    const ok = chain(MAX_STOCK_DEPTH);
    assert.deepEqual(deltasOf(resolveStockLines([sale(ok.top, 1)], 'unload', catalogOf(...ok.all))), { [idOf(flour)]: -1 });
    const deep = chain(MAX_STOCK_DEPTH + 1);
    const result = resolveStockLines([sale(deep.top, 1)], 'unload', catalogOf(...deep.all));
    assert.equal(result.deltas.size, 0);
    assert.deepEqual(result.anomalies.map((anomaly) => anomaly.code), ['tooDeep']);
  });

  it('sums the raw amounts and rounds once, and drops what is zero', () => {
    const item = product({ warehouse: true });
    const other = product({ warehouse: true });
    const total = resolveStockLines([load(item, 0.1), load(item, 0.2), load(other, 1), sale(other, 1)], 'load', catalogOf(item, other));
    assert.deepEqual(deltasOf(total), { [idOf(item)]: 0.3, [idOf(other)]: 2 });
    const none = resolveStockLines([load(item, 1)], 'unload', catalogOf(item));
    assert.equal(none.deltas.get(idOf(item)), -1);
    const cancelled = resolveStockLines([load(item, 0.0000001)], 'load', catalogOf(item));
    assert.equal(cancelled.deltas.size, 0);
  });
});
