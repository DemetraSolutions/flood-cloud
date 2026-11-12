import { fakePos, fakeUser } from '../../../testing/users';
import {
  AUTOMATIC_CASH_DEVICES,
  POS_BOOLEAN_OPTIONS,
  POS_FLAGS,
  UserPos,
} from '../../core/users/pos.catalog';
import {
  blankPos,
  emptyAutomaticCash,
  hasGroupDuties,
  posModelOf,
  toUserFormModel,
} from './user-model';

describe('emptyAutomaticCash', () => {
  it('has every flag of every device off', () => {
    const cash = emptyAutomaticCash();
    expect(Object.keys(cash)).toEqual([...AUTOMATIC_CASH_DEVICES]);
    expect(cash.glory.collectVerify).toBe(false);
    expect(cash.cashSystem).toEqual({ withdrawal: false });
    expect(
      Object.values(cash).every((flags) => Object.values(flags).every((v) => v === false)),
    ).toBe(true);
  });

  it('returns new objects each time', () => {
    const cash = emptyAutomaticCash();
    cash.glory.deposit = true;
    expect(emptyAutomaticCash().glory.deposit).toBe(false);
  });
});

describe('blankPos', () => {
  it('has nothing set', () => {
    const pos = blankPos();
    expect(pos.enabled).toBe(false);
    expect(POS_FLAGS.every((flag) => pos.grants[flag] === false)).toBe(true);
    expect(POS_BOOLEAN_OPTIONS.every((name) => pos.options[name] === false)).toBe(true);
    expect(pos.grants.discountMaxPercentage).toBe('');
    expect(pos.grants.servicePercentage).toBe('');
    expect(pos.options.side).toBe('');
    expect(pos.options.roomsGridZoomHandheld).toBe('');
    expect(pos.options.priceLists).toEqual([]);
    expect(blankPos().options.priceLists).not.toBe(pos.options.priceLists);
  });
});

describe('posModelOf', () => {
  it('turns the stored values into text and keeps the flags', () => {
    const stored = fakePos();
    stored.grants.discount = true;
    stored.grants.discountMaxPercentage = 20;
    stored.grants.servicePercentage = 0;
    stored.grants.automaticCash.vne.tools = true;
    stored.options.darkMode = true;
    stored.options.favoritesId = 'fav';
    stored.options.roomsTablesColumns = 6;
    stored.options.roomsTablesColumnsHandheld = 3;
    stored.options.quickDiscount = 5;
    stored.options.defaultPriceListId = 'pl1';
    stored.options.priceLists = [{ priceListId: 'pl1', enabled: true, isDefault: true }];
    const model = posModelOf(stored);
    expect(model.enabled).toBe(true);
    expect(model.grants.discount).toBe(true);
    expect(model.grants.rider).toBe(false);
    expect(model.grants.discountMaxPercentage).toBe('20');
    expect(model.grants.servicePercentage).toBe('0');
    expect(model.grants.automaticCash.vne.tools).toBe(true);
    expect(model.grants.automaticCash.vne.refill).toBe(false);
    expect(model.options.darkMode).toBe(true);
    expect(model.options.favoritesId).toBe('fav');
    expect(model.options.side).toBe('dx');
    expect(model.options.template).toBe('material-whitepurple-light');
    expect(model.options.roomsTablesColumns).toBe('6');
    expect(model.options.roomsTablesColumnsHandheld).toBe('3');
    expect(model.options.roomsGridZoomHandheld).toBe('2');
    expect(model.options.quickDiscount).toBe('5');
    expect(model.options.defaultPriceListId).toBe('pl1');
    expect(model.options.priceLists).toEqual(stored.options.priceLists);
    expect(model.options.priceLists[0]).not.toBe(stored.options.priceLists[0]);
  });

  it('turns nulls into empty text', () => {
    const model = posModelOf(fakePos());
    expect(model.grants.discountMaxPercentage).toBe('');
    expect(model.grants.servicePercentage).toBe('');
    expect(model.options.favoritesId).toBe('');
    expect(model.options.roomsTablesColumns).toBe('');
    expect(model.options.quickDiscount).toBe('');
    expect(model.options.defaultPriceListId).toBe('');
  });

  it('counts flags and devices missing from the response as off', () => {
    const stored = fakePos();
    const grants = stored.grants as unknown as Record<string, unknown>;
    delete grants['discount'];
    delete (grants['automaticCash'] as Record<string, unknown>)['glory'];
    const options = stored.options as unknown as Record<string, unknown>;
    delete options['darkMode'];
    const model = posModelOf(stored as UserPos);
    expect(model.grants.discount).toBe(false);
    expect(model.grants.automaticCash.glory.withdrawal).toBe(false);
    expect(model.options.darkMode).toBe(false);
  });
});

describe('toUserFormModel', () => {
  it('starts blank for a new user, with the proposed role', () => {
    const model = toUserFormModel(null, 'PA');
    expect(model.role).toBe('PA');
    expect(model.username).toBe('');
    expect(model.password).toBe('');
    expect(model.language).toBe('it');
    expect(model.status).toBe('active');
    expect(model.avatar).toBe('');
    expect(model.hiddenInStats).toBe(false);
    expect(model.pin).toBe('');
    expect(model.companyIds).toEqual([]);
    expect(model.permissions.canManagePermissions).toBe(false);
    expect(model.pos).toEqual(blankPos());
    expect(model.shiftTime).toEqual({ enabled: false, weeks: [], specialDays: [] });
  });

  it('copies the values of a stored user, ignoring the proposed role', () => {
    const user = fakeUser({
      role: 'PA',
      placeIds: ['p1'],
      serviceIds: ['s1'],
      description: 'Notes',
      avatar: 'data:image/png;base64,AAAA',
      hiddenInStats: true,
      language: 'en',
      status: 'disabled',
      shiftTime: {
        enabled: true,
        weeks: [],
        specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }],
      },
    });
    const model = toUserFormModel(user, 'SA');
    expect(model.role).toBe('PA');
    expect(model.username).toBe('luca.bianchi');
    expect(model.firstName).toBe('Luca');
    expect(model.email).toBe('luca@example.com');
    expect(model.language).toBe('en');
    expect(model.status).toBe('disabled');
    expect(model.description).toBe('Notes');
    expect(model.avatar).toBe('data:image/png;base64,AAAA');
    expect(model.hiddenInStats).toBe(true);
    expect(model.pin).toBe('');
    expect(model.companyIds).toEqual(user.companyIds);
    expect(model.companyIds).not.toBe(user.companyIds);
    expect(model.placeIds).toEqual(['p1']);
    expect(model.serviceIds).toEqual(['s1']);
    expect(model.permissions.modules.users).toEqual({ r: true, w: false });
    expect(model.pos.enabled).toBe(true);
    expect(model.shiftTime.enabled).toBe(true);
    expect(model.shiftTime.specialDays).toHaveLength(1);
  });

  it('turns null fields of a stored user into empty text', () => {
    const model = toUserFormModel(
      fakeUser({ firstName: null, lastName: null, email: null, phone: null, avatar: undefined }),
      'CA',
    );
    expect([model.firstName, model.lastName, model.email, model.phone, model.avatar]).toEqual([
      '',
      '',
      '',
      '',
      '',
    ]);
  });
});

describe('hasGroupDuties', () => {
  it.each([
    ['SA', true],
    ['CA', true],
    ['PA', true],
    ['E', false],
    ['PSA', false],
    ['D', false],
    ['', false],
  ])('%s -> %s', (role, expected) => {
    expect(hasGroupDuties(role)).toBe(expected);
  });
});
