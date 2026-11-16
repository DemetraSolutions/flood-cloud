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
  PlaceRecord,
  PlaceSection,
  PlaceStatus,
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
export interface TablesModel extends ScalarBlock {
  tipValues: TipRow[];
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

/** License tab; `expirationDate` is `YYYY-MM-DD` or empty. */
export interface LicenseModel {
  plan: string;
  expirationDate: string;
  status: PlaceStatus;
  sentry: boolean;
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

/** Everything the form edits, one property per section (tab). */
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

function scalarsOf(block: SettingsBlockName, record: PlaceRecord | null): Scalars {
  return Object.fromEntries(
    FIELDS[block].map((definition) => [
      definition.key,
      toFieldValue(definition, valueAt(record?.[block], definition.key)),
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
      sentry: record?.license.sentry === true,
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
  for (const { id } of PLACE_SECTIONS) {
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
  for (const definition of FIELDS[block] as readonly FieldDef[]) {
    setAt(body, definition.key, toBodyValue(definition, scalars[definition.key]));
  }
  return body;
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
    sentry: license.sentry,
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
  for (const { id } of PLACE_SECTIONS) {
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
