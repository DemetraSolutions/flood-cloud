import { LogoModel, pickedLogo } from '../companies/company-model';
import { LogoDescriptor, MediaImage } from '../companies/company.types';
import {
  FIELDS,
  FieldDef,
  Scalars,
  setAt,
  toBodyValue,
  toFieldValue,
  valueAt,
} from './place-fields';
import {
  MEDIA_SLOTS,
  MediaSlot,
  PLACE_SECTIONS,
  PlaceDevice,
  PlaceProductionCenter,
  PlacePrintStation,
  PlaceRecord,
  PlaceRoom,
  PlaceSection,
  PlaceStatus,
  PlaceStorage,
  PlaceTable,
  SettingsBlockName,
} from './place.types';

export { pickedLogo };
export type { LogoModel };

// Rows of the lists and maps of the tabs. Numbers are held as the text of the field.

/** A price list the place sells with. */
export interface PriceListRow {
  id: string;
  allYouCanEat: boolean;
  ayceCode1: string;
  ayceCode2: string;
}

/** A shift name of the cash settings. */
export interface NameRow {
  name: string;
}

/** A payment type (`id` is empty for a type not saved yet). */
export interface PaymentTypeRow {
  id: string;
  name: string;
  cash: boolean;
  electronic: boolean;
  cheque: boolean;
  tickets: boolean;
  electronicInvoiceMode: string;
}

/** A tip suggestion: a value (`v`) or a percentage (`p`). */
export interface TipRow {
  type: string;
  value: string;
}

/** A time block of the reservations: the days of the week and the time range. */
export interface TimeBlockRow {
  weekDays: number[];
  start: string;
  end: string;
}

/** A delivery cost: the cost and the distance up to which it applies. */
export interface ShippingCostRow {
  taxed: string;
  toKm: string;
}

/** A category of a price list of the self ordering. */
export interface SelfOrderingCategoryRow {
  _id: string;
  roundMaxProducts: string;
  totalMaxProducts: string;
  position: string;
  purchasable: boolean;
}

/** The self ordering limits of a price list. */
export interface PriceListConfigRow {
  listId: string;
  roundTime: string;
  roundMaxProducts: string;
  totalMaxProducts: string;
  variants: boolean;
  freeVariants: boolean;
  tableAutoClose: boolean;
  productsCategories: SelfOrderingCategoryRow[];
}

/** A category of the kiosk. */
export interface KioskCategoryRow {
  _id: string;
  position: string;
}

/** A text by language (`it` → text). */
export type LanguageTexts = Record<string, string>;

/** The kiosk texts that exist for every language of the group. */
export const KIOSK_TEXTS = [
  'titleText',
  'subTitleText',
  'startButtonText',
  'eatHereText',
  'takeAwayText',
] as const;

/** Name of a kiosk text. */
export type KioskText = (typeof KIOSK_TEXTS)[number];

// Block models.

/** The part every settings block has: its scalar keys, by key. */
export interface ScalarBlock {
  f: Scalars;
}

/** Cash settings. */
export interface CashModel extends ScalarBlock {
  workshiftNames: NameRow[];
}

/** Payments. */
export interface PaymentsModel extends ScalarBlock {
  paymentTypes: PaymentTypeRow[];
}

/** Tables. */
/** Tables (the rooms settings): the tips and the reasons of a discount and of a deletion. */
export interface TablesModel extends ScalarBlock {
  tipValues: TipRow[];
  discountReasons: string[];
  deleteReasons: string[];
}

/** Reservations. */
export interface ReservationsModel extends ScalarBlock {
  timeBlocks: TimeBlockRow[];
}

/** Take-away and delivery. */
export interface DeliveryModel extends ScalarBlock {
  shippingCosts: ShippingCostRow[];
  /** Minimum order by currency. */
  minAmount: Record<string, string>;
}

/** Self ordering. */
export interface SelfOrderingModel extends ScalarBlock {
  priceListsConfig: PriceListConfigRow[];
}

/** Kiosk. */
export interface KioskModel extends ScalarBlock {
  productsCategories: KioskCategoryRow[];
  titleText: LanguageTexts;
  subTitleText: LanguageTexts;
  startButtonText: LanguageTexts;
  eatHereText: LanguageTexts;
  takeAwayText: LanguageTexts;
}

/** Media of the place: the file names and the images. */
export interface MediaModel extends ScalarBlock {
  logos: Record<MediaSlot, LogoModel | null>;
}

/** Data of the general tab; texts are never `null` (an empty text stands for "none"). */
export interface GeneralModel {
  name: string;
  companyId: string;
  address: { street: string; postcode: string; city: string; province: string; country: string };
  contactName: string;
  email: string;
  phone: string;
  priceListId: string;
  ecommercePriceListId: string;
  invoiceSeries: string;
  priceLists: PriceListRow[];
}

/** The license part of the general tab; `expirationDate` is `YYYY-MM-DD` or empty. */
export interface LicenseModel {
  plan: string;
  expirationDate: string;
  status: PlaceStatus;
}

/** A time slot. */
export interface SlotModel {
  start: string;
  end: string;
}

/** A day of the week. */
export interface DayModel {
  active: boolean;
  values: SlotModel[];
}

/** A special day: its date (`YYYY-MM-DD`) and its hours. */
export interface SpecialDayModel {
  date: string;
  closed: boolean;
  values: SlotModel[];
}

/** A week and its special days. */
export interface ScheduleModel {
  week: Record<string, DayModel>;
  special: SpecialDayModel[];
}

/** Opening hours tab. */
export interface HoursModel extends ScheduleModel {
  timezone: string;
  deliveryTime: ScheduleModel;
}

// Credentials and the lists of items (devices, print stations, rooms, storages).

/**
 * A credential the API never returns: whether the server has one (`set`), what the user typed to
 * replace it (`value`, empty for no change) and whether the user asked to remove it (`clear`).
 */
export interface CredentialModel {
  set: boolean;
  value: string;
  clear: boolean;
}

/** The integrations: the switches and settings by key, and the credentials by key. */
export interface IntegrationsModel extends ScalarBlock {
  secrets: Record<string, CredentialModel>;
}

/** A device (numbers and ids held as text). A device not saved yet has an empty `id`. */
export interface DeviceRow {
  id: string;
  /** The stored list has the item without an id: read only. */
  withoutId: boolean;
  server: boolean;
  type: string;
  name: string;
  driver: string;
  host: string;
  serialNumber: string;
  epsonProtocol17: boolean;
  epsonEreceipt: boolean;
  DLN502017Rounding: boolean;
  secondaryDriver: string;
  secondaryHost: string;
  automaticCashDriver: string;
  automaticCashHost: string;
  automaticCashUsername: CredentialModel;
  automaticCashPassword: CredentialModel;
  posProtocol17ip: string;
  posProtocol17port: string;
  posProtocol17terminalId: string;
  posDojoTerminalId: string;
  externalDisplayId: string;
  secondaryCompanyPrinterId: string;
  favoritesId: string;
  scaleDialog0204Ip: string;
  scaleDialog0204Port: string;
  scaleDialog0204SendPrice: boolean;
  barcodePriceRule: string;
  orderingPrintSingleProduct: boolean;
  orderingPrintSingleProductTables: boolean;
  /** Ids of the print stations of the device. */
  printStations: string[];
  multisafepayAppStatus: boolean;
  multisafepayQrStatus: boolean;
  multisafepayTerminals: TerminalRow[];
}

/** A MultiSafepay terminal of a device. */
export interface TerminalRow {
  terminalId: string;
  name: string;
}

/** The devices and whether the stored list can be changed. */
export interface DevicesModel {
  items: DeviceRow[];
  editable: boolean;
}

/** A print station. */
export interface PrintStationRow {
  id: string;
  withoutId: boolean;
  name: string;
  driver: string;
  host: string;
  pulseNumber: string;
  pulseNumberSecondary: string;
  upsideDown: boolean;
  exitsCut: boolean;
  summaryCategoriesIds: string[];
  summaryPrintStationsIds: string[];
}

/** A production center. */
export interface ProductionCenterRow {
  id: string;
  withoutId: boolean;
  name: string;
  capacity: string;
}

/** The print stations and the production centers, each list with whether it can be changed. */
export interface PrintStationsModel {
  stations: PrintStationRow[];
  productionCenters: ProductionCenterRow[];
  stationsEditable: boolean;
  productionCentersEditable: boolean;
}

/** The place of a table in the grid of its room, in cells; `x` and `y` are `null` while not placed. */
export interface TableViewRow {
  w: number;
  h: number;
  x: number | null;
  y: number | null;
  shape: string;
}

/** A table of a room. */
export interface TableRow {
  id: string;
  withoutId: boolean;
  name: string;
  seats: string;
  userId: string;
  view: TableViewRow;
}

/** A room with its tables and its layout (cells, from 1 to {@link MAX_GRID}). */
export interface RoomRow {
  id: string;
  withoutId: boolean;
  name: string;
  listId: string;
  service: string;
  tax: string;
  deviceId: string;
  seatsRequest: boolean;
  seatsRequired: boolean;
  autoService: boolean;
  priceListsRequest: boolean;
  handheldVisibility: boolean;
  printStations: string[];
  tables: TableRow[];
  view: { type: string; status: boolean; h: number; w: number };
}

/** The rooms and whether the stored list can be changed. */
export interface RoomsModel {
  items: RoomRow[];
  editable: boolean;
}

/** A storage. */
export interface StorageRow {
  id: string;
  name: string;
  cash: boolean;
  ecommerce: boolean;
}

/** The storages and whether the stored list can be changed. */
export interface StoragesModel {
  items: StorageRow[];
  editable: boolean;
}

/** Limits of the API: rooms, tables of a room, tables of the place, and the cells of a room grid. */
export const MAX_ROOMS = 30;
export const MAX_TABLES_PER_ROOM = 200;
export const MAX_TABLES = 1000;
export const MAX_GRID = 50;

const noCredential = (): CredentialModel => ({ set: false, value: '', clear: false });
const credential = (set: boolean): CredentialModel => ({ set, value: '', clear: false });

/** A new device with the defaults of the old form (a desk). */
export function newDevice(): DeviceRow {
  return {
    id: '',
    withoutId: false,
    server: false,
    type: 'desk',
    name: '',
    driver: '',
    host: '',
    serialNumber: '',
    epsonProtocol17: false,
    epsonEreceipt: false,
    DLN502017Rounding: false,
    secondaryDriver: '',
    secondaryHost: '',
    automaticCashDriver: '',
    automaticCashHost: '',
    automaticCashUsername: noCredential(),
    automaticCashPassword: noCredential(),
    posProtocol17ip: '',
    posProtocol17port: '',
    posProtocol17terminalId: '',
    posDojoTerminalId: '',
    externalDisplayId: '',
    secondaryCompanyPrinterId: '',
    favoritesId: '',
    scaleDialog0204Ip: '',
    scaleDialog0204Port: '',
    scaleDialog0204SendPrice: false,
    barcodePriceRule: '',
    orderingPrintSingleProduct: false,
    orderingPrintSingleProductTables: false,
    printStations: [],
    multisafepayAppStatus: false,
    multisafepayQrStatus: false,
    multisafepayTerminals: [],
  };
}

/** A new print station (the first driver of the old form). */
export function newPrintStation(): PrintStationRow {
  return {
    id: '',
    withoutId: false,
    name: '',
    driver: 'EPSON-EPOS-PRINT',
    host: '',
    pulseNumber: '',
    pulseNumberSecondary: '',
    upsideDown: false,
    exitsCut: false,
    summaryCategoriesIds: [],
    summaryPrintStationsIds: [],
  };
}

/** A new production center. */
export function newProductionCenter(): ProductionCenterRow {
  return { id: '', withoutId: false, name: '', capacity: '' };
}

/** A new table, not placed in the grid yet (1 × 1 cells, rectangular). */
export function newTable(name = '', seats = ''): TableRow {
  return {
    id: '',
    withoutId: false,
    name,
    seats,
    userId: '',
    view: { w: 1, h: 1, x: null, y: null, shape: 'rect' },
  };
}

/** A new room with the defaults of the old form: a grid of 8 × 8 cells, switched off. */
export function newRoom(): RoomRow {
  return {
    id: '',
    withoutId: false,
    name: '',
    listId: '',
    service: '',
    tax: '',
    deviceId: '',
    seatsRequest: false,
    seatsRequired: false,
    autoService: false,
    priceListsRequest: false,
    handheldVisibility: false,
    printStations: [],
    tables: [],
    view: { type: 'grid', status: false, h: 8, w: 8 },
  };
}

/** A new storage. */
export function newStorage(): StorageRow {
  return { id: '', name: '', cash: false, ecommerce: false };
}

const ids = (value: unknown): string[] =>
  list(value).filter((item): item is string => typeof item === 'string');

function deviceRow(device: PlaceDevice): DeviceRow {
  return {
    id: device.id,
    withoutId: device.withoutId === true,
    server: device.server === true,
    type: text(device.type),
    name: text(device.name),
    driver: text(device.driver),
    host: text(device.host),
    serialNumber: text(device.serialNumber),
    epsonProtocol17: device.epsonProtocol17 === true,
    epsonEreceipt: device.epsonEreceipt === true,
    DLN502017Rounding: device.DLN502017Rounding === true,
    secondaryDriver: text(device.secondaryDriver),
    secondaryHost: text(device.secondaryHost),
    automaticCashDriver: text(device.automaticCashDriver),
    automaticCashHost: text(device.automaticCashHost),
    automaticCashUsername: credential(device.automaticCashUsernameSet === true),
    automaticCashPassword: credential(device.automaticCashPasswordSet === true),
    posProtocol17ip: text(device.posProtocol17ip),
    posProtocol17port: text(device.posProtocol17port),
    posProtocol17terminalId: text(device.posProtocol17terminalId),
    posDojoTerminalId: text(device.posDojoTerminalId),
    externalDisplayId: text(device.externalDisplayId),
    secondaryCompanyPrinterId: text(device.secondaryCompanyPrinterId),
    favoritesId: text(device.favoritesId),
    scaleDialog0204Ip: text(device.scaleDialog0204Ip),
    scaleDialog0204Port: text(device.scaleDialog0204Port),
    scaleDialog0204SendPrice: device.scaleDialog0204SendPrice === true,
    barcodePriceRule: text(device.barcodePriceRule),
    orderingPrintSingleProduct: device.orderingPrintSingleProduct === true,
    orderingPrintSingleProductTables: device.orderingPrintSingleProductTables === true,
    printStations: ids(device.printStations),
    multisafepayAppStatus: device.multisafepayAppStatus === true,
    multisafepayQrStatus: device.multisafepayQrStatus === true,
    multisafepayTerminals: list(device.multisafepayTerminals).map((raw) => ({
      terminalId: text(object(raw)['terminalId']),
      name: text(object(raw)['name']),
    })),
  };
}

function stationRow(station: PlacePrintStation): PrintStationRow {
  return {
    id: station.id,
    withoutId: station.withoutId === true,
    name: text(station.name),
    driver: text(station.driver),
    host: text(station.host),
    pulseNumber: numberText(station.pulseNumber),
    pulseNumberSecondary: numberText(station.pulseNumberSecondary),
    upsideDown: station.upsideDown === true,
    exitsCut: station.exitsCut === true,
    summaryCategoriesIds: ids(station.summaryCategoriesIds),
    summaryPrintStationsIds: ids(station.summaryPrintStationsIds),
  };
}

function centerRow(center: PlaceProductionCenter): ProductionCenterRow {
  return {
    id: center.id,
    withoutId: center.withoutId === true,
    name: text(center.name),
    capacity: numberText(center.capacity),
  };
}

const cell = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

function tableRow(table: PlaceTable): TableRow {
  const view = object(table.view);
  return {
    id: table.id,
    withoutId: table.withoutId === true,
    name: text(table.name),
    seats: numberText(table.seats),
    userId: text(table.userId),
    view: {
      w: cell(view['w'], 1),
      h: cell(view['h'], 1),
      x: typeof view['x'] === 'number' ? view['x'] : null,
      y: typeof view['y'] === 'number' ? view['y'] : null,
      shape: text(view['shape']) === 'round' ? 'round' : 'rect',
    },
  };
}

function roomRow(room: PlaceRoom): RoomRow {
  const view = object(room.view);
  return {
    id: room.id,
    withoutId: room.withoutId === true,
    name: text(room.name),
    listId: text(room.listId),
    service: numberText(room.service),
    tax: text(room.tax),
    deviceId: text(room.deviceId),
    seatsRequest: room.seatsRequest === true,
    seatsRequired: room.seatsRequired === true,
    autoService: room.autoService === true,
    priceListsRequest: room.priceListsRequest === true,
    handheldVisibility: room.handheldVisibility === true,
    printStations: ids(room.printStations),
    tables: list(room.tables).map((table) => tableRow(table as PlaceTable)),
    view: {
      type: text(view['type']) === '' ? '' : 'grid',
      status: view['status'] === true,
      h: cell(view['h'], 8),
      w: cell(view['w'], 8),
    },
  };
}

function storageRow(storage: PlaceStorage): StorageRow {
  return {
    id: storage.id,
    name: text(storage.name),
    cash: storage.cash === true,
    ecommerce: storage.ecommerce === true,
  };
}

/** Everything the form edits, one property per section. */
export interface PlaceModel {
  general: GeneralModel;
  license: LicenseModel;
  openingHours: HoursModel;
  cashSettings: CashModel;
  printing: ScalarBlock;
  payments: PaymentsModel;
  tables: TablesModel;
  reservations: ReservationsModel;
  delivery: DeliveryModel;
  selfOrdering: SelfOrderingModel;
  kiosk: KioskModel;
  appointments: ScalarBlock;
  externalDisplay: ScalarBlock;
  fidelity: ScalarBlock;
  tobacco: ScalarBlock;
  media: MediaModel;
  integrations: IntegrationsModel;
  dealerSettings: ScalarBlock;
  devices: DevicesModel;
  printStations: PrintStationsModel;
  rooms: RoomsModel;
  storages: StoragesModel;
}

/** The days of the week the API numbers, `0` being Sunday, in the order of the tabs (Monday first). */
export const WEEK_DAYS = ['1', '2', '3', '4', '5', '6', '0'] as const;

/** Most time slots of a day, special days of a calendar and rows of the lists (the API limits). */
export const MAX_SLOTS = 8;
export const MAX_SPECIAL_DAYS = 400;

/** The fields of the general tab, as the API names them at the top of the place. */
const GENERAL_FIELDS = [
  'name',
  'companyId',
  'address',
  'contactName',
  'email',
  'phone',
  'priceListId',
  'ecommercePriceListId',
  'invoiceSeries',
  'priceLists',
] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const flag = (value: unknown): boolean => value === true;
const numberText = (value: unknown): string => (typeof value === 'number' ? String(value) : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const orNull = (value: string): string | null => (value === '' ? null : value);
const numberOrNull = (value: string): number | null => (value === '' ? null : Number(value));

const plainFields = (block: SettingsBlockName): readonly FieldDef[] =>
  FIELDS[block].filter((definition) => definition.type !== 'secret');

function blockOf(record: PlaceRecord | null, block: SettingsBlockName): unknown {
  return record?.[block];
}

function scalarsOf(block: SettingsBlockName, record: PlaceRecord | null): Scalars {
  return Object.fromEntries(
    plainFields(block).map((definition) => [
      definition.key,
      toFieldValue(definition, valueAt(blockOf(record, block), definition.key)),
    ]),
  );
}

/** The credentials of the integrations: whether each is set, nothing typed yet. */
function secretsOf(record: PlaceRecord | null): Record<string, CredentialModel> {
  return Object.fromEntries(
    FIELDS.integrations
      .filter((definition) => definition.type === 'secret')
      .map((definition) => [
        definition.key,
        credential(valueAt(blockOf(record, 'integrations'), `${definition.key}Set`) === true),
      ]),
  );
}

function slots(value: unknown): SlotModel[] {
  return list(value).map((slot) => ({
    start: text(object(slot)['start']),
    end: text(object(slot)['end']),
  }));
}

function scheduleOf(schedule: { week?: unknown; special?: unknown } | undefined): ScheduleModel {
  const week = object(schedule?.week);
  const special = object(schedule?.special);
  return {
    week: Object.fromEntries(
      WEEK_DAYS.map((day) => [
        day,
        { active: flag(object(week[day])['active']), values: slots(object(week[day])['values']) },
      ]),
    ),
    special: Object.entries(special).map(([date, hours]) => ({
      date,
      closed: flag(object(hours)['closed']),
      values: slots(object(hours)['values']),
    })),
  };
}

function languageTexts(value: unknown): LanguageTexts {
  return Object.fromEntries(
    Object.entries(object(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function logoOf(descriptor: unknown): LogoModel | null {
  const stored = descriptor as LogoDescriptor | null;
  return stored === null || typeof stored !== 'object'
    ? null
    : {
        descriptor: stored,
        imageId: null,
        label: stored.title ?? stored.filename,
        previewUrl: null,
      };
}

/**
 * The form model of a place; with `null` the defaults of a place about to be created.
 *
 * @param record The place as the API returned it.
 */
export function toModel(record: PlaceRecord | null): PlaceModel {
  const configs = object(record?.selfOrdering['priceListsConfig']);
  return {
    general: {
      name: text(record?.name),
      companyId: text(record?.companyId),
      address: {
        street: text(record?.address.street),
        postcode: text(record?.address.postcode),
        city: text(record?.address.city),
        province: text(record?.address.province),
        country: record === null ? 'IT' : text(record.address.country),
      },
      contactName: text(record?.contactName),
      email: text(record?.email),
      phone: text(record?.phone),
      priceListId: text(record?.priceListId),
      ecommercePriceListId: text(record?.ecommercePriceListId),
      invoiceSeries: text(record?.invoiceSeries),
      priceLists: (record?.priceLists ?? []).map((priceList) => ({
        id: priceList.id,
        allYouCanEat: priceList.allYouCanEat === true,
        ayceCode1: text(priceList.ayceCode1),
        ayceCode2: text(priceList.ayceCode2),
      })),
    },
    license: {
      plan: record === null ? 'basic' : text(record.license.plan),
      expirationDate: text(record?.license.expirationDate?.slice(0, 10)),
      status: record?.license.status ?? 'active',
    },
    openingHours: {
      timezone: record === null ? 'Europe/Rome' : text(record.openingHours.timezone),
      ...scheduleOf(record?.openingHours),
      deliveryTime: scheduleOf(record?.openingHours.deliveryTime),
    },
    cashSettings: {
      f: scalarsOf('cashSettings', record),
      workshiftNames: list(record?.cashSettings['workshiftNames']).map((name) => ({
        name: text(name),
      })),
    },
    printing: { f: scalarsOf('printing', record) },
    payments: {
      f: scalarsOf('payments', record),
      paymentTypes: list(record?.payments['paymentTypes']).map((raw) => {
        const type = object(raw);
        return {
          id: text(type['id']),
          name: text(type['name']),
          cash: flag(type['cash']),
          electronic: flag(type['electronic']),
          cheque: flag(type['cheque']),
          tickets: flag(type['tickets']),
          electronicInvoiceMode: text(type['electronicInvoiceMode']),
        };
      }),
    },
    tables: {
      f: scalarsOf('tables', record),
      tipValues: list(record?.tables['tipValues']).map((raw) => ({
        type: text(object(raw)['type']),
        value: numberText(object(raw)['value']),
      })),
      discountReasons: ids(record?.tables['discountReasons']),
      deleteReasons: ids(record?.tables['deleteReasons']),
    },
    reservations: {
      f: scalarsOf('reservations', record),
      timeBlocks: list(record?.reservations['timeBlocks']).map((raw) => ({
        weekDays: list(object(raw)['weekDays']).filter(
          (day): day is number => typeof day === 'number',
        ),
        start: text(object(raw)['start']),
        end: text(object(raw)['end']),
      })),
    },
    delivery: {
      f: scalarsOf('delivery', record),
      shippingCosts: list(valueAt(record?.delivery, 'takeAway.shippingCosts')).map((raw) => ({
        taxed: numberText(object(raw)['taxed']),
        toKm: numberText(object(raw)['toKm']),
      })),
      minAmount: Object.fromEntries(
        Object.entries(object(record?.delivery['minAmount'])).map(([code, value]) => [
          code,
          numberText(value),
        ]),
      ),
    },
    selfOrdering: {
      f: scalarsOf('selfOrdering', record),
      priceListsConfig: Object.entries(configs).map(([listId, raw]) => {
        const config = object(raw);
        return {
          listId,
          roundTime: numberText(config['roundTime']),
          roundMaxProducts: numberText(config['roundMaxProducts']),
          totalMaxProducts: numberText(config['totalMaxProducts']),
          variants: flag(config['variants']),
          freeVariants: flag(config['freeVariants']),
          tableAutoClose: flag(config['tableAutoClose']),
          productsCategories: list(config['productsCategories']).map((category) => ({
            _id: text(object(category)['_id']),
            roundMaxProducts: numberText(object(category)['roundMaxProducts']),
            totalMaxProducts: numberText(object(category)['totalMaxProducts']),
            position: numberText(object(category)['position']),
            purchasable: flag(object(category)['purchasable']),
          })),
        };
      }),
    },
    kiosk: {
      f: scalarsOf('kiosk', record),
      productsCategories: list(record?.kiosk['productsCategories']).map((raw) => ({
        _id: text(object(raw)['_id']),
        position: numberText(object(raw)['position']),
      })),
      titleText: languageTexts(record?.kiosk['titleText']),
      subTitleText: languageTexts(record?.kiosk['subTitleText']),
      startButtonText: languageTexts(record?.kiosk['startButtonText']),
      eatHereText: languageTexts(record?.kiosk['eatHereText']),
      takeAwayText: languageTexts(record?.kiosk['takeAwayText']),
    },
    appointments: { f: scalarsOf('appointments', record) },
    externalDisplay: { f: scalarsOf('externalDisplay', record) },
    fidelity: { f: scalarsOf('fidelity', record) },
    tobacco: { f: scalarsOf('tobacco', record) },
    media: {
      f: scalarsOf('media', record),
      logos: Object.fromEntries(
        MEDIA_SLOTS.map((slot) => [slot, logoOf(record?.media[slot])]),
      ) as Record<MediaSlot, LogoModel | null>,
    },
    integrations: { f: scalarsOf('integrations', record), secrets: secretsOf(record) },
    dealerSettings: { f: scalarsOf('dealerSettings', record) },
    devices: {
      items: (record?.devices.items ?? []).map(deviceRow),
      editable: record?.devices.editable !== false,
    },
    printStations: {
      stations: (record?.printStations.stations ?? []).map(stationRow),
      productionCenters: (record?.printStations.productionCenters ?? []).map(centerRow),
      stationsEditable: record?.printStations.stationsEditable !== false,
      productionCentersEditable: record?.printStations.productionCentersEditable !== false,
    },
    rooms: {
      items: (record?.rooms.items ?? []).map(roomRow),
      editable: record?.rooms.editable !== false,
    },
    storages: {
      items: (record?.storages.items ?? []).map(storageRow),
      editable: record?.storages.editable !== false,
    },
  };
}

/**
 * The sections whose content differs from the baseline (the saved place).
 *
 * @param model What the form holds.
 * @param baseline The model of the saved place.
 */
export function dirtySections(model: PlaceModel, baseline: PlaceModel): Set<PlaceSection> {
  const dirty = new Set<PlaceSection>();
  for (const id of PLACE_SECTIONS) {
    if (JSON.stringify(model[id]) !== JSON.stringify(baseline[id])) {
      dirty.add(id);
    }
  }
  return dirty;
}

/**
 * The model with some sections replaced by those of a saved place: what was saved is aligned with
 * the server while the drafts of the other sections stay.
 *
 * @param model Current model.
 * @param record The place the server returned.
 * @param sections Sections to replace.
 */
export function withSections(
  model: PlaceModel,
  record: PlaceRecord,
  sections: Iterable<PlaceSection>,
): PlaceModel {
  const saved = toModel(record);
  const next: PlaceModel = { ...model };
  for (const id of sections) {
    (next as unknown as Record<string, unknown>)[id] = saved[id];
  }
  return next;
}

// Bodies.

function scalarsBody(block: SettingsBlockName, scalars: Scalars): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const definition of plainFields(block)) {
    setAt(body, definition.key, toBodyValue(definition, scalars[definition.key]));
  }
  return body;
}

/** The credentials the user changed, nested by key: the typed text sets one, `null` removes it. */
function secretsBody(secrets: Record<string, CredentialModel>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, secret] of Object.entries(secrets)) {
    if (secret.clear) {
      setAt(body, key, null);
    } else if (secret.value !== '') {
      setAt(body, key, secret.value);
    }
  }
  return body;
}

/** Merges a nested object into another (the credentials into the settings of the integrations). */
function merged(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    target[key] =
      typeof value === 'object' && value !== null && typeof current === 'object' && current !== null
        ? merged(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return target;
}

/** A credential of a device for the body: typed text sets it, `null` removes it, nothing keeps it. */
function deviceSecret(name: string, secret: CredentialModel): Record<string, unknown> {
  if (secret.clear) {
    return { [name]: null };
  }
  return secret.value === '' ? {} : { [name]: secret.value };
}

function deviceBody(row: DeviceRow): Record<string, unknown> {
  return {
    ...(row.id === '' ? {} : { id: row.id }),
    server: row.server,
    type: row.type,
    name: row.name,
    driver: row.driver,
    host: row.host,
    serialNumber: row.serialNumber,
    epsonProtocol17: row.epsonProtocol17,
    epsonEreceipt: row.epsonEreceipt,
    DLN502017Rounding: row.DLN502017Rounding,
    secondaryDriver: row.secondaryDriver,
    secondaryHost: row.secondaryHost,
    automaticCashDriver: row.automaticCashDriver,
    automaticCashHost: row.automaticCashHost,
    ...deviceSecret('automaticCashUsername', row.automaticCashUsername),
    ...deviceSecret('automaticCashPassword', row.automaticCashPassword),
    posProtocol17ip: row.posProtocol17ip,
    posProtocol17port: row.posProtocol17port,
    posProtocol17terminalId: row.posProtocol17terminalId,
    posDojoTerminalId: row.posDojoTerminalId,
    externalDisplayId: row.externalDisplayId,
    secondaryCompanyPrinterId: row.secondaryCompanyPrinterId,
    favoritesId: row.favoritesId,
    scaleDialog0204Ip: row.scaleDialog0204Ip,
    scaleDialog0204Port: row.scaleDialog0204Port,
    scaleDialog0204SendPrice: row.scaleDialog0204SendPrice,
    barcodePriceRule: row.barcodePriceRule,
    orderingPrintSingleProduct: row.orderingPrintSingleProduct,
    orderingPrintSingleProductTables: row.orderingPrintSingleProductTables,
    printStations: row.printStations,
    multisafepayAppStatus: row.multisafepayAppStatus,
    multisafepayQrStatus: row.multisafepayQrStatus,
    multisafepayTerminals: row.multisafepayTerminals.map((terminal) => ({
      terminalId: terminal.terminalId.trim(),
      name: terminal.name.trim(),
    })),
  };
}

const idOf = (row: { id: string }): Record<string, unknown> =>
  row.id === '' ? {} : { id: row.id };

function stationBody(row: PrintStationRow): Record<string, unknown> {
  return {
    ...idOf(row),
    name: row.name,
    driver: row.driver,
    host: row.host,
    pulseNumber: numberOrNull(row.pulseNumber),
    pulseNumberSecondary: numberOrNull(row.pulseNumberSecondary),
    upsideDown: row.upsideDown,
    exitsCut: row.exitsCut,
    summaryCategoriesIds: row.summaryCategoriesIds,
    summaryPrintStationsIds: row.summaryPrintStationsIds,
  };
}

function roomBody(row: RoomRow): Record<string, unknown> {
  return {
    ...idOf(row),
    name: row.name,
    listId: row.listId,
    service: numberOrNull(row.service),
    tax: row.tax,
    deviceId: row.deviceId,
    seatsRequest: row.seatsRequest,
    seatsRequired: row.seatsRequired,
    autoService: row.autoService,
    priceListsRequest: row.priceListsRequest,
    handheldVisibility: row.handheldVisibility,
    printStations: row.printStations,
    tables: row.tables.map((table) => ({
      ...idOf(table),
      name: table.name,
      seats: numberOrNull(table.seats),
      userId: table.userId,
      view: { ...table.view },
    })),
    view: { ...row.view },
  };
}

function logoBody(logo: LogoModel | null): unknown {
  if (logo === null) {
    return null;
  }
  return logo.imageId === null ? logo.descriptor : { imageId: logo.imageId };
}

const slotBody = (slot: SlotModel): SlotModel => ({ start: slot.start, end: slot.end });

function scheduleBody(schedule: ScheduleModel): { week: unknown; special: unknown } {
  return {
    week: Object.fromEntries(
      WEEK_DAYS.map((day) => [
        day,
        { active: schedule.week[day].active, values: schedule.week[day].values.map(slotBody) },
      ]),
    ),
    special: Object.fromEntries(
      schedule.special.map((day) => [
        day.date,
        { closed: day.closed, values: day.values.map(slotBody) },
      ]),
    ),
  };
}

/** The body of the `PUT` of the opening hours. */
function hoursBody(hours: HoursModel): unknown {
  return {
    timezone: hours.timezone,
    ...scheduleBody(hours),
    deliveryTime: scheduleBody(hours.deliveryTime),
  };
}

/**
 * The body of the `PUT` of the license. The expiration date goes back as it was stored when the
 * date shown did not change, so the time of day of a stored instant is never lost.
 *
 * @param license The license tab.
 * @param record The saved place.
 */
function licenseBody(license: LicenseModel, record: PlaceRecord | null): unknown {
  const stored = record?.license.expirationDate ?? null;
  return {
    plan: license.plan,
    expirationDate:
      stored !== null && stored.slice(0, 10) === license.expirationDate
        ? stored
        : orNull(license.expirationDate),
    status: license.status,
  };
}

const priceListBody = (row: PriceListRow): object => ({
  id: row.id,
  allYouCanEat: row.allYouCanEat,
  ayceCode1: orNull(row.ayceCode1),
  ayceCode2: orNull(row.ayceCode2),
});

/** Only the fields of the general tab that differ from the baseline, as the API names them. */
function generalChanges(model: GeneralModel, baseline: GeneralModel): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const nullable = [
    'contactName',
    'email',
    'phone',
    'priceListId',
    'ecommercePriceListId',
    'invoiceSeries',
  ] as const;
  if (model.name !== baseline.name) {
    changes['name'] = model.name;
  }
  if (model.companyId !== baseline.companyId) {
    changes['companyId'] = model.companyId;
  }
  const address = Object.fromEntries(
    Object.entries(model.address).filter(
      ([key, value]) => value !== baseline.address[key as keyof GeneralModel['address']],
    ),
  );
  if (Object.keys(address).length > 0) {
    changes['address'] = address;
  }
  for (const key of nullable) {
    if (model[key] !== baseline[key]) {
      changes[key] = orNull(model[key]);
    }
  }
  if (JSON.stringify(model.priceLists) !== JSON.stringify(baseline.priceLists)) {
    changes['priceLists'] = model.priceLists.map(priceListBody);
  }
  return changes;
}

/**
 * The body of the `PUT` of a section other than the general one (every key, as the API
 * requires), from the model of its tab.
 *
 * @param model The form model.
 * @param section The section.
 * @param record The saved place (the license keeps the stored expiration instant).
 */
export function blockBody(
  model: PlaceModel,
  section: Exclude<PlaceSection, 'general'>,
  record: PlaceRecord | null,
): unknown {
  switch (section) {
    case 'license':
      return licenseBody(model.license, record);
    case 'openingHours':
      return hoursBody(model.openingHours);
    case 'cashSettings':
      return {
        ...scalarsBody(section, model.cashSettings.f),
        workshiftNames: model.cashSettings.workshiftNames
          .map((row) => row.name.trim())
          .filter((name) => name !== ''),
      };
    case 'payments':
      return {
        ...scalarsBody(section, model.payments.f),
        paymentTypes: model.payments.paymentTypes.map((row) => ({
          ...(row.id === '' ? {} : { id: row.id }),
          name: row.name,
          cash: row.cash,
          electronic: row.electronic,
          cheque: row.cheque,
          tickets: row.tickets,
          electronicInvoiceMode: orNull(row.electronicInvoiceMode),
        })),
      };
    case 'tables':
      return {
        ...scalarsBody(section, model.tables.f),
        tipValues: model.tables.tipValues.map((row) => ({
          type: row.type,
          value: Number(row.value),
        })),
        discountReasons: model.tables.discountReasons.map((reason) => reason.trim()),
        deleteReasons: model.tables.deleteReasons.map((reason) => reason.trim()),
      };
    case 'reservations':
      return {
        ...scalarsBody(section, model.reservations.f),
        timeBlocks: model.reservations.timeBlocks.map((row) => ({
          weekDays: row.weekDays,
          start: row.start,
          end: row.end,
        })),
      };
    case 'delivery': {
      const body = scalarsBody(section, model.delivery.f);
      setAt(
        body,
        'takeAway.shippingCosts',
        model.delivery.shippingCosts.map((row) => ({
          taxed: Number(row.taxed),
          toKm: Number(row.toKm),
        })),
      );
      body['minAmount'] = Object.fromEntries(
        Object.entries(model.delivery.minAmount)
          .filter(([, value]) => value !== '')
          .map(([code, value]) => [code, Number(value)]),
      );
      return body;
    }
    case 'selfOrdering':
      return {
        ...scalarsBody(section, model.selfOrdering.f),
        priceListsConfig: Object.fromEntries(
          model.selfOrdering.priceListsConfig.map((config) => [
            config.listId,
            {
              roundTime: numberOrNull(config.roundTime),
              roundMaxProducts: numberOrNull(config.roundMaxProducts),
              totalMaxProducts: numberOrNull(config.totalMaxProducts),
              variants: config.variants,
              freeVariants: config.freeVariants,
              tableAutoClose: config.tableAutoClose,
              productsCategories: config.productsCategories.map((category) => ({
                _id: category._id,
                roundMaxProducts: numberOrNull(category.roundMaxProducts),
                totalMaxProducts: numberOrNull(category.totalMaxProducts),
                position: numberOrNull(category.position),
                purchasable: category.purchasable,
              })),
            },
          ]),
        ),
      };
    case 'kiosk': {
      const kiosk = model.kiosk;
      return {
        ...scalarsBody(section, kiosk.f),
        productsCategories: kiosk.productsCategories.map((row) => ({
          _id: row._id,
          position: numberOrNull(row.position),
        })),
        ...Object.fromEntries(KIOSK_TEXTS.map((name) => [name, kiosk[name]])),
      };
    }
    case 'media':
      return {
        ...scalarsBody(section, model.media.f),
        ...Object.fromEntries(MEDIA_SLOTS.map((slot) => [slot, logoBody(model.media.logos[slot])])),
      };
    case 'integrations':
      return merged(
        scalarsBody(section, model.integrations.f),
        secretsBody(model.integrations.secrets),
      );
    case 'devices':
      return { items: model.devices.items.map(deviceBody) };
    case 'printStations': {
      const lists = model.printStations;
      return {
        ...(lists.stationsEditable ? { stations: lists.stations.map(stationBody) } : {}),
        ...(lists.productionCentersEditable
          ? {
              productionCenters: lists.productionCenters.map((center) => ({
                ...idOf(center),
                name: center.name,
                capacity: Number(center.capacity),
              })),
            }
          : {}),
      };
    }
    case 'rooms':
      return { items: model.rooms.items.map(roomBody) };
    case 'storages':
      return {
        items: model.storages.items.map((row) => ({
          ...idOf(row),
          name: row.name,
          cash: row.cash,
          ecommerce: row.ecommerce,
        })),
      };
    default:
      return scalarsBody(section, model[section].f);
  }
}

/**
 * The body of the unique `PATCH`: what changed in the general tab and the whole blocks of the
 * other sections given.
 *
 * @param model The form model.
 * @param baseline The model of the saved place.
 * @param sections Sections to send.
 * @param record The saved place.
 */
export function patchBody(
  model: PlaceModel,
  baseline: PlaceModel,
  sections: ReadonlySet<PlaceSection>,
  record: PlaceRecord | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = sections.has('general')
    ? generalChanges(model.general, baseline.general)
    : {};
  for (const id of PLACE_SECTIONS) {
    if (id !== 'general' && sections.has(id)) {
      body[id] = blockBody(model, id, record);
    }
  }
  return body;
}

/**
 * The body of the creation: the required data and what the user filled in; the optional fields
 * left empty are not sent (the server applies its defaults). Only platform administrators and
 * dealers choose the plan.
 *
 * @param model The form model (the general and license tabs).
 * @param withPlan Whether the user chooses the plan.
 */
export function createBody(model: PlaceModel, withPlan: boolean): Record<string, unknown> {
  const { general, license } = model;
  const { address } = general;
  return {
    name: general.name,
    companyId: general.companyId,
    address: {
      street: address.street,
      postcode: address.postcode,
      city: address.city,
      country: address.country,
      ...(address.province === '' ? {} : { province: address.province }),
    },
    ...(general.contactName === '' ? {} : { contactName: general.contactName }),
    ...(general.email === '' ? {} : { email: general.email }),
    ...(general.phone === '' ? {} : { phone: general.phone }),
    ...(general.priceListId === '' ? {} : { priceListId: general.priceListId }),
    ...(general.ecommercePriceListId === ''
      ? {}
      : { ecommercePriceListId: general.ecommercePriceListId }),
    ...(general.invoiceSeries === '' ? {} : { invoiceSeries: general.invoiceSeries }),
    ...(general.priceLists.length === 0
      ? {}
      : { priceLists: general.priceLists.map(priceListBody) }),
    ...(withPlan ? { license: { plan: license.plan } } : {}),
  };
}

/** Whether a field name is one of the general tab. */
export function isGeneralField(field: string): boolean {
  return (GENERAL_FIELDS as readonly string[]).includes(field.split('.')[0]);
}
