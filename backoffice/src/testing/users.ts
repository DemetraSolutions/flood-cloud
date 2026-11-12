import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  POS_BOOLEAN_OPTIONS,
  POS_FLAGS,
  UserPos,
} from '../app/core/users/pos.catalog';
import { UserRecord } from '../app/features/users/user.types';

/** A complete POS record for tests: every grant off, default preferences. */
export function fakePos(overrides: Partial<UserPos> = {}): UserPos {
  return {
    enabled: true,
    grants: {
      ...(Object.fromEntries(POS_FLAGS.map((flag) => [flag, false])) as Record<string, boolean>),
      discountMaxPercentage: null,
      servicePercentage: null,
      automaticCash: Object.fromEntries(
        AUTOMATIC_CASH_DEVICES.map((device) => [
          device,
          Object.fromEntries(AUTOMATIC_CASH[device].map((key) => [key, false])),
        ]),
      ),
    } as unknown as UserPos['grants'],
    options: {
      ...(Object.fromEntries(POS_BOOLEAN_OPTIONS.map((name) => [name, false])) as Record<
        string,
        boolean
      >),
      favoritesId: null,
      side: 'dx',
      sideRooms: 'dx',
      virtualKeyboard: '',
      template: 'material-whitepurple-light',
      productsFontSize: 's',
      productsShortNameFontSize: 's',
      roomsTablesColumns: null,
      roomsTablesColumnsHandheld: null,
      roomsGridZoomHandheld: 2,
      quickDiscount: null,
      defaultPriceListId: null,
      priceLists: [],
    } as unknown as UserPos['options'],
    ...overrides,
  };
}

/** A complete user record for tests; override what the test cares about. */
export function fakeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: '665f1c2e9b1d4a0012ab34ce',
    username: 'luca.bianchi',
    firstName: 'Luca',
    lastName: 'Bianchi',
    email: 'luca@example.com',
    phone: '+39 02 1',
    role: 'CA',
    groupId: '665f1c2e9b1d4a0012ab34a1',
    dealerId: null,
    companyIds: ['665f1c2e9b1d4a0012ab34b2'],
    placeIds: [],
    status: 'active',
    trashed: false,
    language: 'it',
    description: null,
    avatar: null,
    hasAvatar: false,
    pinSet: false,
    hiddenInStats: false,
    serviceIds: [],
    pos: fakePos(),
    shiftTime: { enabled: false, weeks: [], specialDays: [] },
    permissions: {
      modules: { users: { r: true, w: false }, places: { r: true, w: true } },
      canManagePermissions: false,
    },
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}
