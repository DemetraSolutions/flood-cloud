import { fakePos, fakeUser } from '../../../testing/users';
import { emptyWeek } from '../../core/users/shift-time';
import { blankPos, posModelOf, toUserFormModel, UserFormModel } from './user-model';
import { buildCreateBody, buildPatch, optionsPatch, sameData, WriteScope } from './user-payload';

const ALL: WriteScope = { matrix: true, pos: true, posPermissions: true, services: true };
const NONE: WriteScope = { matrix: false, pos: false, posPermissions: false, services: false };

function newModel(role = 'CA', overrides: Partial<UserFormModel> = {}): UserFormModel {
  return {
    ...toUserFormModel(null, role),
    username: 'anna',
    password: 'Secret-1234', // gitleaks:allow (fake test value)
    ...overrides,
  };
}

function editModel(overrides: Partial<UserFormModel> = {}) {
  const user = fakeUser();
  return { user, model: { ...toUserFormModel(user, user.role), ...overrides } };
}

describe('sameData', () => {
  it.each<[string, unknown, unknown, boolean]>([
    ['same primitives', 1, 1, true],
    ['different primitives', 1, 2, false],
    ['primitive vs object', 1, {}, false],
    ['object vs primitive', {}, 'a', false],
    ['null vs object', null, {}, false],
    ['object vs null', {}, null, false],
    ['equal objects', { a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }, true],
    ['different values', { a: 1 }, { a: 2 }, false],
    ['different key counts', { a: 1 }, { a: 1, b: 2 }, false],
    ['same count, different keys', { a: 1 }, { b: 1 }, false],
    ['array vs object', [], {}, false],
    ['equal arrays', [1, [2]], [1, [2]], true],
    ['arrays of different length', [1], [1, 2], false],
  ])('%s', (_name, a, b, expected) => {
    expect(sameData(a, b)).toBe(expected);
  });
});

describe('buildCreateBody', () => {
  it('sends the required fields and the perimeter of the role only', () => {
    expect(buildCreateBody(newModel('CA', { companyIds: ['c1'], placeIds: ['p1'] }), ALL)).toEqual({
      username: 'anna',
      password: 'Secret-1234', // gitleaks:allow (fake test value)
      role: 'CA',
      language: 'it',
      status: 'active',
      companyIds: ['c1'],
    });
    const place = buildCreateBody(newModel('PA', { companyIds: ['c1'], placeIds: ['p1'] }), ALL);
    expect(place.placeIds).toEqual(['p1']);
    expect(place.companyIds).toBeUndefined();
    expect(buildCreateBody(newModel('E', { placeIds: ['p2'] }), ALL).placeIds).toEqual(['p2']);
    const sa = buildCreateBody(newModel('SA', { companyIds: ['c1'], placeIds: ['p1'] }), ALL);
    expect(sa.companyIds).toBeUndefined();
    expect(sa.placeIds).toBeUndefined();
  });

  it('trims the username and the optional texts, skipping the empty ones', () => {
    const body = buildCreateBody(
      newModel('SA', {
        username: '  anna  ',
        firstName: ' Anna ',
        lastName: '   ',
        email: 'a@example.com',
        phone: '',
        description: ' Cashier ',
      }),
      ALL,
    );
    expect(body.username).toBe('anna');
    expect(body.firstName).toBe('Anna');
    expect(body.email).toBe('a@example.com');
    expect(body.description).toBe('Cashier');
    expect('lastName' in body).toBe(false);
    expect('phone' in body).toBe(false);
  });

  it('sends the description, avatar, hidden-in-stats flag and PIN only when filled in', () => {
    const empty = buildCreateBody(newModel('SA'), ALL);
    for (const key of ['description', 'avatar', 'hiddenInStats', 'pin']) {
      expect(key in empty).toBe(false);
    }
    expect(
      buildCreateBody(newModel('SA', { description: '   ' }), ALL).description,
    ).toBeUndefined();
    const body = buildCreateBody(
      newModel('SA', { avatar: 'data:image/png;base64,AAAA', hiddenInStats: true, pin: '1234' }),
      ALL,
    );
    expect(body.avatar).toBe('data:image/png;base64,AAAA');
    expect(body.hiddenInStats).toBe(true);
    expect(body.pin).toBe('1234');
  });

  it('sends the services only when they apply and some are chosen', () => {
    expect(buildCreateBody(newModel('SA', { serviceIds: ['s1'] }), ALL).serviceIds).toEqual(['s1']);
    expect(buildCreateBody(newModel('SA', { serviceIds: [] }), ALL).serviceIds).toBeUndefined();
    expect(
      buildCreateBody(newModel('SA', { serviceIds: ['s1'] }), { ...ALL, services: false })
        .serviceIds,
    ).toBeUndefined();
  });

  it('never sends the matrix or the POS data, which the server defaults by role', () => {
    const model = newModel('SA', { serviceIds: ['s1'] });
    model.permissions.modules.users = { r: true, w: true };
    model.permissions.canManagePermissions = true;
    model.pos.enabled = true;
    model.pos.grants.discount = true;
    model.pos.options.darkMode = true;
    for (const scope of [ALL, NONE]) {
      const body = buildCreateBody(model, scope);
      expect('permissions' in body).toBe(false);
      expect('pos' in body).toBe(false);
    }
  });

  it('sends the shifts only when they differ from none', () => {
    expect(buildCreateBody(newModel('SA'), ALL).shiftTime).toBeUndefined();
    const model = newModel('SA');
    model.shiftTime.enabled = true;
    const week = emptyWeek();
    week.from = '2026-03-01';
    week.days['1'] = { active: true, slots: [{ start: '09:00', end: '13:00' }] };
    model.shiftTime.weeks = [week, emptyWeek()];
    model.shiftTime.specialDays = [{ date: '2026-12-25', dayOff: true, slots: [] }];
    const shift = buildCreateBody(model, NONE).shiftTime;
    expect(shift?.enabled).toBe(true);
    expect(shift?.weeks?.[0].from).toBe('2026-03-01');
    expect(shift?.weeks?.[0].to).toBeNull();
    expect(shift?.weeks?.[1].from).toBeNull();
    expect(shift?.weeks?.[0].days['1'].slots).toEqual([{ start: '09:00', end: '13:00' }]);
    expect(shift?.specialDays).toEqual([{ date: '2026-12-25', dayOff: true, slots: [] }]);
  });

  it('sends only the shift lists that are set', () => {
    const model = newModel('SA');
    model.shiftTime.specialDays = [{ date: '2026-12-25', dayOff: true, slots: [] }];
    expect(buildCreateBody(model, ALL).shiftTime).toEqual({
      specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }],
    });
  });
});

describe('buildPatch', () => {
  it('is empty without a stored user', () => {
    expect(buildPatch(newModel(), null, ALL)).toEqual({});
  });

  it('is empty when nothing changed', () => {
    const { user, model } = editModel();
    expect(buildPatch(model, user, ALL)).toEqual({});
    expect(buildPatch(model, user, NONE)).toEqual({});
  });

  it('sends the changed profile fields, trimmed, with emptied texts as null', () => {
    const { user, model } = editModel({
      username: ' luca.rossi ',
      firstName: 'Luigi',
      lastName: '  ',
      email: '',
      phone: ' 333 ',
      language: 'en',
      status: 'disabled',
      description: ' Notes ',
      hiddenInStats: true,
    });
    expect(buildPatch(model, user, ALL)).toEqual({
      username: 'luca.rossi',
      firstName: 'Luigi',
      lastName: null,
      email: null,
      phone: '333',
      language: 'en',
      status: 'disabled',
      description: 'Notes',
      hiddenInStats: true,
    });
  });

  it('clears a description that is emptied', () => {
    const user = fakeUser({ description: 'Old' });
    const model = { ...toUserFormModel(user, user.role), description: '' };
    expect(buildPatch(model, user, ALL)).toEqual({ description: null });
  });

  it('sends the avatar when it changes and null when it is removed', () => {
    const { user, model } = editModel({ avatar: 'data:image/png;base64,AAAA' });
    expect(buildPatch(model, user, ALL)).toEqual({ avatar: 'data:image/png;base64,AAAA' });
    const withAvatar = fakeUser({ avatar: 'data:image/png;base64,AAAA' });
    const removed = { ...toUserFormModel(withAvatar, 'CA'), avatar: '' };
    expect(buildPatch(removed, withAvatar, ALL)).toEqual({ avatar: null });
  });

  it('never sends the PIN', () => {
    const { user, model } = editModel({ pin: '1234' });
    expect(buildPatch(model, user, ALL)).toEqual({});
  });

  it('sends the perimeter only when it changes, whatever the order', () => {
    const user = fakeUser({ companyIds: ['c1', 'c2'] });
    const same = { ...toUserFormModel(user, 'CA'), companyIds: ['c2', 'c1'] };
    expect(buildPatch(same, user, ALL)).toEqual({});
    expect(buildPatch({ ...same, companyIds: ['c1'] }, user, ALL).companyIds).toEqual(['c1']);
    expect(buildPatch({ ...same, companyIds: ['c1', 'c3'] }, user, ALL).companyIds).toEqual([
      'c1',
      'c3',
    ]);
    const place = fakeUser({ role: 'PA', companyIds: [], placeIds: ['p1'] });
    const changed = { ...toUserFormModel(place, 'PA'), placeIds: ['p2'] };
    expect(buildPatch(changed, place, ALL)).toEqual({ placeIds: ['p2'] });
    expect(buildPatch(toUserFormModel(place, 'PA'), place, ALL)).toEqual({});
  });

  it('always sends the perimeter of the new role when the role changes', () => {
    const user = fakeUser({ role: 'CA', companyIds: ['c1'], placeIds: [] });
    const toPlace = { ...toUserFormModel(user, 'CA'), role: 'PA', placeIds: [] };
    expect(buildPatch(toPlace, user, ALL)).toEqual({ role: 'PA', placeIds: [] });
    const toCompany = fakeUser({ role: 'PA', companyIds: ['c1'], placeIds: ['p1'] });
    const model = { ...toUserFormModel(toCompany, 'PA'), role: 'CA' };
    expect(buildPatch(model, toCompany, ALL)).toEqual({ role: 'CA', companyIds: ['c1'] });
    const toSa = { ...toUserFormModel(user, 'CA'), role: 'SA' };
    expect(buildPatch(toSa, user, ALL)).toEqual({ role: 'SA' });
  });

  it('sends the services only when they apply and change', () => {
    const user = fakeUser({ serviceIds: ['s1'] });
    const model = { ...toUserFormModel(user, 'CA'), serviceIds: ['s2'] };
    expect(buildPatch(model, user, ALL).serviceIds).toEqual(['s2']);
    expect(buildPatch(model, user, { ...ALL, services: false }).serviceIds).toBeUndefined();
    expect(buildPatch({ ...model, serviceIds: ['s1'] }, user, ALL).serviceIds).toBeUndefined();
    expect(buildPatch({ ...model, serviceIds: [] }, user, ALL).serviceIds).toEqual([]);
  });

  it('sends the changed matrix flags only, and never write on logs', () => {
    const { user, model } = editModel();
    model.permissions.modules.users.w = true;
    model.permissions.modules.places.r = false;
    model.permissions.modules.stats = { r: true, w: true };
    model.permissions.modules.logs = { r: true, w: true };
    model.permissions.canManagePermissions = true;
    expect(buildPatch(model, user, ALL).permissions).toEqual({
      modules: {
        users: { w: true },
        places: { r: false },
        stats: { r: true, w: true },
        logs: { r: true },
      },
      canManagePermissions: true,
    });
    expect(buildPatch(model, user, { ...ALL, matrix: false }).permissions).toBeUndefined();
  });

  it('ignores a write flag on logs that differs only there', () => {
    const { user, model } = editModel();
    model.permissions.modules.logs = { r: false, w: true };
    expect(buildPatch(model, user, ALL)).toEqual({});
  });

  it('sends only the canManagePermissions flag when only it changes', () => {
    const { user, model } = editModel();
    model.permissions.canManagePermissions = true;
    expect(buildPatch(model, user, ALL).permissions).toEqual({ canManagePermissions: true });
  });

  it('sends the changed POS permissions and preferences', () => {
    const { user, model } = editModel();
    model.pos.enabled = false;
    model.pos.grants.discount = true;
    model.pos.grants.discountMaxPercentage = '30';
    model.pos.grants.automaticCash.azkoyen.status = true;
    model.pos.options.darkMode = true;
    expect(buildPatch(model, user, ALL).pos).toEqual({
      enabled: false,
      grants: {
        discount: true,
        discountMaxPercentage: 30,
        automaticCash: { azkoyen: { status: true } },
      },
      options: { darkMode: true },
    });
  });

  it('collects the changed flags of several devices and clears a percentage with null', () => {
    const stored = fakePos();
    stored.grants.servicePercentage = 10;
    stored.grants.automaticCash.glory.deposit = true;
    const user = fakeUser({ pos: stored });
    const model = toUserFormModel(user, 'CA');
    model.pos.grants.servicePercentage = '';
    model.pos.grants.automaticCash.glory.deposit = false;
    model.pos.grants.automaticCash.glory.archive = true;
    model.pos.grants.automaticCash.vne.tools = true;
    expect(buildPatch(model, user, ALL).pos).toEqual({
      grants: {
        servicePercentage: null,
        automaticCash: {
          glory: { deposit: false, archive: true },
          vne: { tools: true },
        },
      },
    });
  });

  it('leaves enabled and grants out when the actor cannot give POS permissions', () => {
    const { user, model } = editModel();
    model.pos.enabled = false;
    model.pos.grants.discount = true;
    model.pos.options.darkMode = true;
    expect(buildPatch(model, user, { ...ALL, posPermissions: false }).pos).toEqual({
      options: { darkMode: true },
    });
    model.pos.options.darkMode = false;
    expect(buildPatch(model, user, { ...ALL, posPermissions: false }).pos).toBeUndefined();
    expect(buildPatch(model, user, { ...ALL, pos: false }).pos).toBeUndefined();
  });

  it('sends the price lists whole when they change', () => {
    const { user, model } = editModel();
    model.pos.options.defaultPriceListId = 'pl1';
    model.pos.options.priceLists = [{ priceListId: 'pl1', enabled: true, isDefault: true }];
    expect(buildPatch(model, user, ALL).pos).toEqual({
      options: {
        defaultPriceListId: 'pl1',
        priceLists: [{ priceListId: 'pl1', enabled: true, isDefault: true }],
      },
    });
  });

  it('sends the changed shifts', () => {
    const { user, model } = editModel();
    expect(buildPatch(model, user, ALL).shiftTime).toBeUndefined();
    model.shiftTime.enabled = true;
    const week = emptyWeek();
    week.to = '2026-03-31';
    model.shiftTime.weeks = [week];
    model.shiftTime.specialDays = [
      { date: '2026-12-25', dayOff: false, slots: [{ start: '10:00', end: '12:00' }] },
    ];
    const shift = buildPatch(model, user, NONE).shiftTime;
    expect(shift?.enabled).toBe(true);
    expect(shift?.weeks).toHaveLength(1);
    expect(shift?.weeks?.[0].from).toBeNull();
    expect(shift?.weeks?.[0].to).toBe('2026-03-31');
    expect(shift?.specialDays).toEqual(model.shiftTime.specialDays);
  });

  it('does not resend lists that did not change', () => {
    const week = emptyWeek();
    const user = fakeUser({
      shiftTime: {
        enabled: true,
        weeks: [{ from: null, to: null, days: week.days }],
        specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }],
      },
    });
    const model = toUserFormModel(user, 'CA');
    expect(buildPatch(model, user, ALL)).toEqual({});
    model.shiftTime.enabled = false;
    expect(buildPatch(model, user, ALL).shiftTime).toEqual({ enabled: false });
  });
});

describe('optionsPatch', () => {
  const base = () => posModelOf(fakePos()).options;

  it('is null when nothing differs', () => {
    expect(optionsPatch(base(), base())).toBeNull();
    expect(optionsPatch(base(), base(), true)).toBeNull();
  });

  it('converts the values the way the API wants them', () => {
    const model = base();
    model.favoritesId = '';
    model.template = '';
    model.defaultPriceListId = '';
    model.roomsTablesColumns = '6';
    model.roomsTablesColumnsHandheld = '3';
    model.quickDiscount = '5';
    model.roomsGridZoomHandheld = '1.5';
    model.side = 'sx';
    model.virtualKeyboard = 'pb';
    model.productsFontSize = 'l';
    const before = base();
    before.favoritesId = 'fav';
    before.template = 'x';
    before.defaultPriceListId = 'pl';
    before.roomsTablesColumns = '';
    before.roomsTablesColumnsHandheld = '';
    before.quickDiscount = '';
    expect(optionsPatch(model, before)).toEqual({
      favoritesId: null,
      template: null,
      defaultPriceListId: null,
      roomsTablesColumns: 6,
      roomsTablesColumnsHandheld: 3,
      quickDiscount: 5,
      roomsGridZoomHandheld: 1.5,
      side: 'sx',
      virtualKeyboard: 'pb',
      productsFontSize: 'l',
    });
  });

  it('turns an emptied number into null and keeps text values', () => {
    const model = base();
    const before = base();
    before.roomsTablesColumns = '4';
    before.quickDiscount = '10';
    before.favoritesId = 'old';
    model.favoritesId = 'new';
    expect(optionsPatch(model, before)).toEqual({
      roomsTablesColumns: null,
      quickDiscount: null,
      favoritesId: 'new',
    });
  });

  it('leaves the price lists out of the personal preferences', () => {
    const model = base();
    model.defaultPriceListId = 'pl1';
    model.priceLists = [{ priceListId: 'pl1', enabled: true, isDefault: true }];
    model.darkMode = true;
    expect(optionsPatch(model, base(), true)).toEqual({ darkMode: true });
    expect(optionsPatch(model, base())).toEqual({
      darkMode: true,
      defaultPriceListId: 'pl1',
      priceLists: [{ priceListId: 'pl1', enabled: true, isDefault: true }],
    });
  });

  it('sends the price lists as copies', () => {
    const model = base();
    model.priceLists = [{ priceListId: 'pl1', enabled: true, isDefault: false }];
    const patch = optionsPatch(model, base());
    expect((patch?.['priceLists'] as unknown[])[0]).not.toBe(model.priceLists[0]);
  });

  it('works against a blank baseline', () => {
    expect(optionsPatch(blankPos().options, blankPos().options)).toBeNull();
  });
});
