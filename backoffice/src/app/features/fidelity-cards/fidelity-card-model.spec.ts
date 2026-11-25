import { aCardType } from '../../../testing/fidelity';
import {
  balanceIssue,
  CardModel,
  codeIssue,
  createBody,
  initialRows,
  modelChanged,
  patchBody,
  pointsIssue,
  toModel,
} from './fidelity-card-model';
import { FidelityCard } from './fidelity-card.types';

const CARD = { code: 'FC-1', cardTypeId: 't1', enabled: false } as FidelityCard;
const PREPAID = aCardType({ prepaid: { enabled: true, type: 'multi', taxPercentage: null } });
const POINTS = aCardType({ pointsCollect: { enabled: true, collectionIds: ['pc1', 'pc2'] } });

function model(over: Partial<CardModel> = {}): CardModel {
  return { ...toModel(null), code: ' FC-9 ', cardTypeId: 't1', ...over };
}

describe('toModel', () => {
  it('starts a new card active and empty', () => {
    expect(toModel(null)).toEqual({
      code: '',
      cardTypeId: '',
      enabled: true,
      initialBalance: '',
      initialPoints: [],
      customers: [],
    });
  });

  it('copies the fields of a card', () => {
    expect(toModel(CARD)).toMatchObject({ code: 'FC-1', cardTypeId: 't1', enabled: false });
    expect(toModel({ ...CARD, cardTypeId: null }).cardTypeId).toBe('');
  });
});

describe('codeIssue', () => {
  it('accepts a code and names the issues', () => {
    expect(codeIssue(' FC-1 ')).toBeUndefined();
    expect(codeIssue('   ')).toBe('required');
    expect(codeIssue('x'.repeat(65))).toBe('maxLength');
    expect(codeIssue('x'.repeat(64))).toBeUndefined();
    expect(codeIssue('a\nb')).toBe('pattern');
    expect(codeIssue('...')).toBe('format');
    expect(codeIssue('.a.')).toBeUndefined();
    expect(codeIssue('A|B')).toBe('pipe');
  });
});

describe('balanceIssue', () => {
  it('accepts an empty credit or an amount with two decimals', () => {
    for (const text of ['', '  ', '12.5', '0.01', '7', '1000000', ' 3 ']) {
      expect(balanceIssue(text)).toBeUndefined();
    }
  });

  it('names the issues', () => {
    for (const text of ['abc', '1e3', '1,5', ' 2 x', '.5', '-1', '1.234', '+1']) {
      expect(balanceIssue(text)).toBe('type');
    }
    expect(balanceIssue('0')).toBe('incorrect');
    expect(balanceIssue('0.00')).toBe('incorrect');
    expect(balanceIssue('1000000.01')).toBe('maximum');
  });
});

describe('pointsIssue', () => {
  it('accepts empty or a whole number from 1 to a million', () => {
    for (const text of ['', ' ', '5', '1000000']) {
      expect(pointsIssue(text)).toBeUndefined();
    }
  });

  it('names the issues', () => {
    for (const text of ['x', '1.5', '1e3', '-1', '1,5']) {
      expect(pointsIssue(text)).toBe('type');
    }
    expect(pointsIssue('0')).toBe('incorrect');
    expect(pointsIssue('1000001')).toBe('maximum');
  });
});

describe('initialRows', () => {
  const names = new Map([['pc1', 'Spring']]);

  it('has no rows without a type or for a type that does not collect points', () => {
    expect(initialRows(undefined, names)).toEqual([]);
    expect(initialRows(aCardType(), names)).toEqual([]);
  });

  it('has a row for each collection of the type that exists', () => {
    expect(initialRows(POINTS, names)).toEqual([
      { collectionId: 'pc1', name: 'Spring', points: '' },
    ]);
  });
});

describe('createBody', () => {
  it('has the code, the type and the state only', () => {
    expect(createBody(model(), aCardType())).toEqual({
      code: 'FC-9',
      cardTypeId: 't1',
      enabled: true,
    });
  });

  it('adds the credit for a prepaid type with an amount', () => {
    expect(createBody(model({ initialBalance: '10.5' }), PREPAID)['initialBalance']).toBe(10.5);
    expect(createBody(model({ initialBalance: '' }), PREPAID)).not.toHaveProperty('initialBalance');
    expect(createBody(model({ initialBalance: '10' }), aCardType())).not.toHaveProperty(
      'initialBalance',
    );
    expect(createBody(model({ initialBalance: '10' }), undefined)).not.toHaveProperty(
      'initialBalance',
    );
  });

  it('adds the non empty points for a type that collects them', () => {
    const rows = [
      { collectionId: 'pc1', name: 'A', points: ' 7 ' },
      { collectionId: 'pc2', name: 'B', points: '  ' },
    ];
    expect(createBody(model({ initialPoints: rows }), POINTS)['initialPoints']).toEqual([
      { collectionId: 'pc1', points: 7 },
    ]);
    expect(createBody(model({ initialPoints: [rows[1]!] }), POINTS)).not.toHaveProperty(
      'initialPoints',
    );
    expect(createBody(model({ initialPoints: rows }), aCardType())).not.toHaveProperty(
      'initialPoints',
    );
  });

  it('adds the ids of the customers chosen', () => {
    const body = createBody(
      model({
        customers: [
          { id: 'k1', name: 'Anna' },
          { id: 'k2', name: 'Luca' },
        ],
      }),
      undefined,
    );
    expect(body['contactIds']).toEqual(['k1', 'k2']);
  });
});

describe('patchBody', () => {
  it('has only what changed', () => {
    const before = toModel(CARD);
    expect(patchBody(before, before)).toEqual({});
    expect(patchBody({ ...before, cardTypeId: 't2' }, before)).toEqual({ cardTypeId: 't2' });
    expect(patchBody({ ...before, enabled: true }, before)).toEqual({ enabled: true });
    expect(patchBody({ ...before, cardTypeId: 't2', enabled: true }, before)).toEqual({
      cardTypeId: 't2',
      enabled: true,
    });
  });
});

describe('modelChanged', () => {
  it('compares a form with the original', () => {
    expect(modelChanged(toModel(null), toModel(null))).toBe(false);
    expect(modelChanged({ ...toModel(null), code: 'x' }, toModel(null))).toBe(true);
  });
});
