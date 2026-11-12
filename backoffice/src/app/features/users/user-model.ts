import { Role } from '../../core/session/session.types';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  AutomaticCashGrants,
  POS_BOOLEAN_OPTIONS,
  POS_FLAGS,
  PosBooleanOption,
  PosFlag,
  PosPriceList,
  UserPos,
} from '../../core/users/pos.catalog';
import { emptyShiftTime, ShiftTimeModel, toShiftModel } from '../../core/users/shift-time';
import { emptyMatrix, matrixOf, PermissionMatrix, UserRecord } from './user.types';

/** POS permissions as the form edits them (percentages are text: `''` is "no cap"). */
export type PosGrantsModel = Record<PosFlag, boolean> & {
  discountMaxPercentage: string;
  servicePercentage: string;
  automaticCash: AutomaticCashGrants;
};

/** POS preferences as the form edits them (`''` stands for `null` or "not set"). */
export type PosOptionsModel = Record<PosBooleanOption, boolean> & {
  favoritesId: string;
  side: string;
  sideRooms: string;
  virtualKeyboard: string;
  template: string;
  productsFontSize: string;
  productsShortNameFontSize: string;
  roomsTablesColumns: string;
  roomsTablesColumnsHandheld: string;
  roomsGridZoomHandheld: string;
  quickDiscount: string;
  defaultPriceListId: string;
  priceLists: PosPriceList[];
};

/** POS data as the form edits them. */
export interface PosModel {
  enabled: boolean;
  grants: PosGrantsModel;
  options: PosOptionsModel;
}

/** Values of the user form (text fields are `''` when empty). */
export interface UserFormModel {
  username: string;
  password: string;
  role: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  language: string;
  status: string;
  description: string;
  /** Data URL of the avatar, `''` for none. */
  avatar: string;
  hiddenInStats: boolean;
  /** PIN to set when creating the user (changed later with its own action); never stored. */
  pin: string;
  companyIds: string[];
  placeIds: string[];
  serviceIds: string[];
  permissions: PermissionMatrix;
  pos: PosModel;
  shiftTime: ShiftTimeModel;
}

function falseFlags<K extends string>(names: readonly K[]): Record<K, boolean> {
  return Object.fromEntries(names.map((name) => [name, false])) as Record<K, boolean>;
}

/** Automatic cash grants with every flag off. */
export function emptyAutomaticCash(): AutomaticCashGrants {
  return Object.fromEntries(
    AUTOMATIC_CASH_DEVICES.map((device) => [device, falseFlags(AUTOMATIC_CASH[device])]),
  ) as unknown as AutomaticCashGrants;
}

/** POS data with nothing set: the baseline of a user being created. */
export function blankPos(): PosModel {
  return {
    enabled: false,
    grants: {
      ...falseFlags(POS_FLAGS),
      discountMaxPercentage: '',
      servicePercentage: '',
      automaticCash: emptyAutomaticCash(),
    },
    options: {
      ...falseFlags(POS_BOOLEAN_OPTIONS),
      favoritesId: '',
      side: '',
      sideRooms: '',
      virtualKeyboard: '',
      template: '',
      productsFontSize: '',
      productsShortNameFontSize: '',
      roomsTablesColumns: '',
      roomsTablesColumnsHandheld: '',
      roomsGridZoomHandheld: '',
      quickDiscount: '',
      defaultPriceListId: '',
      priceLists: [],
    },
  };
}

const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

/** Form model of the POS data a user has. */
export function posModelOf(pos: UserPos): PosModel {
  const blank = blankPos();
  const grants = { ...blank.grants, automaticCash: emptyAutomaticCash() } as PosGrantsModel;
  for (const flag of POS_FLAGS) {
    grants[flag] = pos.grants[flag] === true;
  }
  grants.discountMaxPercentage = text(pos.grants.discountMaxPercentage);
  grants.servicePercentage = text(pos.grants.servicePercentage);
  for (const device of AUTOMATIC_CASH_DEVICES) {
    for (const key of AUTOMATIC_CASH[device]) {
      (grants.automaticCash[device] as Record<string, boolean>)[key] =
        (pos.grants.automaticCash[device] as Record<string, boolean> | undefined)?.[key] === true;
    }
  }
  const options = { ...blank.options } as PosOptionsModel;
  for (const name of POS_BOOLEAN_OPTIONS) {
    options[name] = pos.options[name] === true;
  }
  options.favoritesId = text(pos.options.favoritesId);
  options.side = text(pos.options.side);
  options.sideRooms = text(pos.options.sideRooms);
  options.virtualKeyboard = text(pos.options.virtualKeyboard);
  options.template = text(pos.options.template);
  options.productsFontSize = text(pos.options.productsFontSize);
  options.productsShortNameFontSize = text(pos.options.productsShortNameFontSize);
  options.roomsTablesColumns = text(pos.options.roomsTablesColumns);
  options.roomsTablesColumnsHandheld = text(pos.options.roomsTablesColumnsHandheld);
  options.roomsGridZoomHandheld = text(pos.options.roomsGridZoomHandheld);
  options.quickDiscount = text(pos.options.quickDiscount);
  options.defaultPriceListId = text(pos.options.defaultPriceListId);
  options.priceLists = pos.options.priceLists.map((list) => ({ ...list }));
  return { enabled: pos.enabled, grants, options };
}

/**
 * Initial form values: those of the stored user, or blanks for a new one.
 *
 * @param user The user being edited, or `null` for a new one.
 * @param role Role proposed for a new user.
 */
export function toUserFormModel(user: UserRecord | null, role: string): UserFormModel {
  return {
    username: user?.username ?? '',
    password: '',
    role: user?.role ?? role,
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    language: user?.language ?? 'it',
    status: user?.status ?? 'active',
    description: user?.description ?? '',
    avatar: user?.avatar ?? '',
    hiddenInStats: user?.hiddenInStats ?? false,
    pin: '',
    companyIds: [...(user?.companyIds ?? [])],
    placeIds: [...(user?.placeIds ?? [])],
    serviceIds: [...(user?.serviceIds ?? [])],
    permissions: user === null ? emptyMatrix() : matrixOf(user),
    pos: user === null ? blankPos() : posModelOf(user.pos),
    shiftTime: user === null ? emptyShiftTime() : toShiftModel(user.shiftTime),
  };
}

/** Roles that can have services and the point of sale (the others never see those sections). */
export function hasGroupDuties(role: Role | string): boolean {
  return role === 'SA' || role === 'CA' || role === 'PA';
}
