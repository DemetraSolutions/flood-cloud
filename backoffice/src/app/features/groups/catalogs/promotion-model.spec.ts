import { aPromotion } from '../../../../testing/fidelity';
import { fromLocalInput, toLocalInput } from './catalog-fields';
import {
  bodyValue,
  createBody,
  modelOf,
  patchBody,
  PROMOTION_FIELDS,
  PROMOTION_KEYS,
  PROMOTION_SECTIONS,
  promotionIssue,
} from './promotion-model';

const ISO = '2026-12-01T10:30:00.000Z';

describe('modelOf', () => {
  it('starts a new promotion with the defaults of the server', () => {
    expect(modelOf(null)).toMatchObject({
      name: '',
      enabled: true,
      currency: 'EUR',
      amountTax: 'tax_included',
      productsN: '1',
      productsQt: '1',
      categoriesN: '1',
      discountType: '',
      discountValueType: 'percentage',
      placeIds: [],
      freeShipping: false,
    });
  });

  it('shows the values of a promotion as the fields hold them', () => {
    const model = modelOf(
      aPromotion({
        description: 'Evening',
        code: 'HAPPY',
        conditions: {
          placeIds: ['p1'],
          startDate: ISO,
          maxUsesPerUser: 2,
          minAmount: 12.5,
          seatExcluded: true,
          products: { type: 'only_n', n: 3, qt: 2, productIds: ['a'] },
          categories: { type: 'only_n', n: 4, categoryIds: ['c'] },
        },
        actions: { discountValue: 15, discountValueType: 'amount', productIds: ['b'] },
      }),
    );
    expect(model).toMatchObject({
      description: 'Evening',
      code: 'HAPPY',
      placeIds: ['p1'],
      startDate: toLocalInput(ISO),
      endDate: '',
      maxUsesPerUser: '2',
      maxUsesTotal: '',
      minAmount: '12.5',
      seatExcluded: true,
      productsType: 'only_n',
      productsN: '3',
      productsQt: '2',
      productIds: ['a'],
      categoriesType: 'only_n',
      categoriesN: '4',
      categoryIds: ['c'],
      discountType: 'on_total',
      discountValue: '15',
      discountValueType: 'amount',
      actionProductIds: ['b'],
    });
  });

  it('shows stored nulls as empty fields', () => {
    const model = modelOf(
      aPromotion({
        conditions: {
          amountTax: null,
          products: { type: null, n: null, qt: null, productIds: [] },
          categories: { type: null, n: null, categoryIds: [] },
        },
        actions: { discountType: null, discountValue: null, discountValueType: null },
      }),
    );
    expect(model).toMatchObject({
      amountTax: '',
      productsN: '',
      productsQt: '',
      categoriesN: '',
      discountType: '',
      discountValue: '',
      discountValueType: '',
    });
  });

  it('copies the lists, so editing the model never changes the promotion', () => {
    const promotion = aPromotion({ conditions: { placeIds: ['p1'] } });
    modelOf(promotion).placeIds.push('p2');
    expect(promotion.conditions.placeIds).toEqual(['p1']);
  });
});

describe('field table', () => {
  it('puts every field in a known section, once', () => {
    expect(new Set(PROMOTION_KEYS.map((key) => PROMOTION_FIELDS[key].section))).toEqual(
      new Set(PROMOTION_SECTIONS),
    );
    expect(new Set(PROMOTION_KEYS.map((key) => PROMOTION_FIELDS[key].path)).size).toBe(
      PROMOTION_KEYS.length,
    );
  });
});

describe('bodyValue', () => {
  const model = { ...modelOf(null), name: ' Sale ' };

  it('trims a text and keeps a flag', () => {
    expect(bodyValue(model, 'name')).toBe('Sale');
    expect(bodyValue(model, 'enabled')).toBe(true);
  });

  it('turns an empty optional text, number, date or choice into null', () => {
    expect(bodyValue(model, 'description')).toBeNull();
    expect(bodyValue(model, 'maxUsesTotal')).toBeNull();
    expect(bodyValue(model, 'startDate')).toBeNull();
    expect(bodyValue(model, 'discountType')).toBeNull();
  });

  it('converts filled fields', () => {
    const filled = {
      ...model,
      description: ' text ',
      minAmount: '3.5',
      startDate: toLocalInput(ISO),
      discountType: 'on_total',
    };
    expect(bodyValue(filled, 'description')).toBe('text');
    expect(bodyValue(filled, 'minAmount')).toBe(3.5);
    expect(bodyValue(filled, 'startDate')).toBe(ISO);
    expect(bodyValue(filled, 'discountType')).toBe('on_total');
  });
});

describe('createBody', () => {
  it('sends the defaults and leaves the empty fields out', () => {
    expect(createBody({ ...modelOf(null), name: 'Sale' })).toEqual({
      name: 'Sale',
      enabled: true,
      conditions: {
        placeIds: [],
        customerIds: [],
        contactGroupIds: [],
        currency: 'EUR',
        amountTax: 'tax_included',
        seatExcluded: false,
        serviceExcluded: false,
        tipExcluded: false,
        deliveryExcluded: false,
        products: { n: 1, qt: 1, productIds: [] },
        categories: { n: 1, categoryIds: [] },
      },
      actions: {
        discountValueType: 'percentage',
        productIds: [],
        categoryIds: [],
        freeShipping: false,
      },
    });
  });
});

describe('patchBody', () => {
  const saved = modelOf(aPromotion({ conditions: { startDate: ISO } }));

  it('is empty without changes, also when a text only differs by blanks', () => {
    expect(patchBody({ ...saved }, saved)).toEqual({});
    expect(patchBody({ ...saved, name: ` ${saved.name} ` }, saved)).toEqual({});
  });

  it('nests the changed fields the way the server merges them', () => {
    const model = {
      ...saved,
      name: 'New',
      productsN: '5',
      discountValue: '20',
      endDate: '2027-01-01T08:00',
    };
    expect(patchBody(model, saved)).toEqual({
      name: 'New',
      conditions: {
        endDate: fromLocalInput('2027-01-01T08:00'),
        products: { n: 5 },
      },
      actions: { discountValue: 20 },
    });
  });

  it('sends a changed list whole, and empties a field with null', () => {
    const model = { ...saved, placeIds: ['p1', 'p2'], startDate: '', code: '' };
    const withCode = { ...saved, code: 'OLD' };
    expect(patchBody(model, withCode)).toEqual({
      code: null,
      conditions: { placeIds: ['p1', 'p2'], startDate: null },
    });
  });
});

describe('promotionIssue', () => {
  const model = modelOf(null);
  const issue = (changes: object, key: Parameters<typeof promotionIssue>[1]) =>
    promotionIssue({ ...model, ...changes }, key);

  it('accepts the defaults', () => {
    for (const key of PROMOTION_KEYS) {
      expect(promotionIssue(model, key)).toBeUndefined();
    }
  });

  it('expects whole numbers from 1 for the uses', () => {
    expect(issue({ maxUsesPerUser: '0' }, 'maxUsesPerUser')).toBe('minimum');
    expect(issue({ maxUsesTotal: '1.5' }, 'maxUsesTotal')).toBe('type');
    expect(issue({ maxUsesTotal: '3' }, 'maxUsesTotal')).toBeUndefined();
  });

  it('expects a non negative minimum amount', () => {
    expect(issue({ minAmount: '-1' }, 'minAmount')).toBe('minimum');
  });

  it('expects n and quantity between 1 and a million', () => {
    expect(issue({ productsN: '0' }, 'productsN')).toBe('minimum');
    expect(issue({ productsQt: '1000001' }, 'productsQt')).toBe('maximum');
    expect(issue({ categoriesN: '2.5' }, 'categoriesN')).toBe('type');
  });

  it('keeps a percentage discount up to 100 and an amount free', () => {
    expect(issue({ discountValue: '-1' }, 'discountValue')).toBe('minimum');
    expect(issue({ discountValue: '101' }, 'discountValue')).toBe('incorrect');
    expect(issue({ discountValue: '100' }, 'discountValue')).toBeUndefined();
    expect(
      issue({ discountValue: '500', discountValueType: 'amount' }, 'discountValue'),
    ).toBeUndefined();
  });

  it('expects a currency of three capital letters', () => {
    expect(issue({ currency: 'eur' }, 'currency')).toBe('pattern');
    expect(issue({ currency: '' }, 'currency')).toBe('pattern');
    expect(issue({ currency: 'USD' }, 'currency')).toBeUndefined();
  });

  it('expects the end after the start, only when both are dates', () => {
    expect(issue({ startDate: '2026-12-02T10:00', endDate: '2026-12-01T10:00' }, 'endDate')).toBe(
      'incorrect',
    );
    expect(issue({ startDate: '2026-12-01T10:00', endDate: '2026-12-02T10:00' }, 'endDate')).toBe(
      undefined,
    );
    expect(issue({ startDate: '', endDate: '2026-12-02T10:00' }, 'endDate')).toBeUndefined();
    expect(issue({ startDate: '2026-12-02T10:00', endDate: '' }, 'endDate')).toBeUndefined();
  });

  it('refuses a filled date that is not a date instead of sending it as no date', () => {
    expect(issue({ startDate: '2026-02-30T10:00' }, 'startDate')).toBe('incorrect');
    expect(issue({ startDate: '2026-12-01T10:00' }, 'startDate')).toBeUndefined();
    expect(issue({ endDate: '2026-04-31T10:00' }, 'endDate')).toBe('incorrect');
  });
});
