import { LIST_2, PLACE_URL, fakePlace, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  isChecked,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const f = (key: string) => `PLACES.F.DELIVERY.${key}`;
const col = (key: string, row: number) => `PLACES.DELIVERY.${key} ${row}`;
const NO_GROUP = [
  'places:read',
  'places:update',
  'companies:read',
  'products:read',
  'profile:read',
];

afterEach(cleanUp);

describe('PlaceDelivery', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'delivery' });
    expect(isChecked(view, f('TAKE_AWAY.STATUS'))).toBe(false);
    expect(view.control(f('TAKE_AWAY.SEND_ORDER_ON_SAVE')).value).toBe('ask');
    expect(view.control(f('TAKE_AWAY.DELIVERY_LIST_ID')).value).toBe('');
    expect(view.control(col('COST', 1)).value).toBe('2.5');
    expect(view.control(col('TO_KM', 1)).value).toBe('5');
    expect(view.control('EUR').value).toBe('10');
    expect(view.control('USD').value).toBe('');
    expect(view.text()).toContain('PLACES.DELIVERY.MIN_AMOUNT');
  });

  it('offers the enabled price lists of the group only', async () => {
    const view = await renderPlace({ path: 'delivery' });
    const options = [...view.control(f('TAKE_AWAY.TAKE_AWAY_LIST_ID')).querySelectorAll('option')];
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'PLACES.NONE',
      'Listino 1',
      'Listino 2',
    ]);
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'delivery' });
    await view.toggle(f('TAKE_AWAY.STATUS'), true);
    await view.type(f('TAKE_AWAY.SEND_ORDER_ON_SAVE'), 'always');
    await view.type(f('TAKE_AWAY.DELIVERY_LIST_ID'), LIST_2);
    await view.type(f('TAKE_AWAY.STEP'), '10');
    await view.type(f('RADIUS'), '3.5');
    await view.type(f('LAT'), '45.46');
    await view.type(col('COST', 1), '3');
    await view.type(col('TO_KM', 1), '7');
    await view.type('USD', '20');
    let block = withValue(storedBlock('delivery'), 'takeAway.status', true);
    block = withValue(block, 'takeAway.sendOrderOnSave', 'always');
    block = withValue(block, 'takeAway.deliveryListId', LIST_2);
    block = withValue(block, 'takeAway.step', 600000);
    block = withValue(block, 'radius', 3.5);
    block = withValue(block, 'lat', 45.46);
    block = withValue(block, 'takeAway.shippingCosts', [{ taxed: 3, toKm: 7 }]);
    block = withValue(block, 'minAmount', { EUR: 10, USD: 20 });
    await savePut(view, 'settings/delivery', block);
    expect(PLACE_URL).toContain('places');
  });

  it('adds and removes delivery costs', async () => {
    const view = await renderPlace({ path: 'delivery' });
    await view.click('PLACES.DELIVERY.ADD_COST');
    await view.type(col('COST', 2), '5');
    await view.type(col('TO_KM', 2), '10');
    await savePut(
      view,
      'settings/delivery',
      withValue(storedBlock('delivery'), 'takeAway.shippingCosts', [
        { taxed: 2.5, toKm: 5 },
        { taxed: 5, toKm: 10 },
      ]),
    );
    (
      view.root.querySelector('button[aria-label*="PLACES.REMOVE_ROW"]') as HTMLButtonElement
    ).click();
    await view.view();
    await savePut(
      view,
      'settings/delivery',
      withValue(storedBlock('delivery'), 'takeAway.shippingCosts', []),
      '"v2"',
    );
  });

  it('keeps a stored currency the group no longer has and drops the emptied ones', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      delivery: { ...stored.delivery, minAmount: { EUR: 10, GBP: 5 } },
    });
    const view = await renderPlace({ path: 'delivery', place });
    expect(view.control('GBP').value).toBe('5');
    await view.type('EUR', '');
    await savePut(
      view,
      'settings/delivery',
      withValue(storedBlock('delivery'), 'minAmount', { GBP: 5 }),
    );
  });

  it('shows only the stored currencies when the user cannot read the group', async () => {
    const view = await renderPlace({ path: 'delivery', permissions: NO_GROUP });
    expect(view.control('EUR').value).toBe('10');
    expect(view.root.querySelector('fc-keyed-values')?.querySelectorAll('input')).toHaveLength(1);
  });

  it('says so when there is no currency at all', async () => {
    const stored = fakePlace();
    const place = fakePlace({ delivery: { ...stored.delivery, minAmount: {} } });
    const view = await renderPlace({ path: 'delivery', permissions: NO_GROUP, place });
    expect(view.text()).toContain('PLACES.NO_KEYS');
  });

  it('puts the 422 on the control of the key', async () => {
    const view = await renderPlace({ path: 'delivery' });
    await view.type(f('RADIUS'), '3');
    await failPut(view, 'settings/delivery', [
      { field: 'delivery.radius', issue: 'incorrect' },
      { field: 'delivery.takeAway.deliveryListId', issue: 'incorrect' },
    ]);
    expect(view.error(f('RADIUS'))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('TAKE_AWAY.DELIVERY_LIST_ID'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'delivery' });
    await submitTab(view);
    await view.blurAll();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'delivery', permissions: READ_ONLY });
    expect(view.control(f('RADIUS')).disabled).toBe(true);
    expect(view.control('EUR').disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(view.button('PLACES.DELIVERY.ADD_COST')).toBeUndefined();
    expect(view.button('PLACES.REMOVE')).toBeUndefined();
  });
});
