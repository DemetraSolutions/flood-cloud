import { ObjectId } from 'mongodb';
import { SETTING_FIELDS } from '../../shared/legacy-write/place-settings.ts';
import type { SettingKind, WholeName } from '../../shared/legacy-write/place-settings.ts';
import { flag, isPlain, logo, minimumOrder, nonEmptyOrNull, numberOf } from '../companies/company.mapper.ts';
import type { Codec, Leaf } from '../companies/company.mapper.ts';

const FONT = /^[1-3]-[1-3]$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? (value as unknown[]).filter(isPlain) : []);
const wholeNumber = (value: unknown): number | null => ((n) => (n !== null && Number.isInteger(n) ? n : null))(numberOf(value));
const textOr = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** The codecs of the keys that are a whole list or map, written in one piece. */
const WHOLE: Readonly<Record<WholeName, Codec>> = {
  workshiftNames: {
    read: (value) => (Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === 'string') : []),
    write: (value) => value,
  },
  tipValues: {
    read: (value) => list(value).flatMap((tip) => (numberOf(tip['value']) === null ? [] : [{ type: tip['type'] === 'p' ? 'p' : 'v', value: numberOf(tip['value']) }])),
    write: (value) => (value as Array<{ type: string; value: number }>).map((tip) => ({ type: tip.type, value: tip.value })),
  },
  // The table groups: an object of three switches, or the boolean of the oldest documents. A write is the whole object the form saves, with the deprecated copy of `mergeProductsPrint` it keeps.
  tableGroups: {
    read: (value) => (isPlain(value) ? { status: value['status'] === true, name: value['name'] === true, autoCreateFirst: value['autoCreateFirst'] === true } : { status: value === true, name: false, autoCreateFirst: false }),
    write: (value, stored) => {
      const groups = value as { status: boolean; name: boolean; autoCreateFirst: boolean };
      return { status: groups.status, name: groups.name, autoCreateFirst: groups.autoCreateFirst, mergeProductsPrint: isPlain(stored) && stored['mergeProductsPrint'] === true };
    },
  },
  timeBlocks: {
    read: (value) =>
      list(value).map((block) => ({
        weekDays: (Array.isArray(block['weekDays']) ? (block['weekDays'] as unknown[]) : []).flatMap((day) => (wholeNumber(day) === null ? [] : [wholeNumber(day)])),
        start: textOr(block['start']),
        end: textOr(block['end']),
      })),
    write: (value) => (value as Array<{ weekDays: number[]; start: string; end: string }>).map((block) => ({ weekDays: block.weekDays, start: block.start, end: block.end })),
  },
  paymentTypes: {
    read: (value) =>
      list(value).map((type) => ({
        id: textOr(type['id']),
        name: textOr(type['name']),
        cash: type['cash'] === true,
        electronic: type['electronic'] === true,
        cheque: type['cheque'] === true,
        tickets: type['tickets'] === true,
        electronicInvoiceMode: isPlain(type['fattura_elettronica']) ? nonEmptyOrNull(type['fattura_elettronica']['ModalitaPagamento']) : null,
      })),
    write: (value) =>
      (value as Array<{ id: string; name: string; cash: boolean; electronic: boolean; cheque: boolean; tickets: boolean; electronicInvoiceMode: string | null }>).map((type) => ({
        id: type.id,
        name: type.name,
        cash: type.cash,
        electronic: type.electronic,
        cheque: type.cheque,
        tickets: type.tickets,
        fattura_elettronica: { ModalitaPagamento: type.electronicInvoiceMode ?? '' },
      })),
  },
  shippingCosts: {
    read: (value) => list(value).flatMap((cost) => (numberOf(cost['taxed']) === null || numberOf(cost['toKm']) === null ? [] : [{ taxed: numberOf(cost['taxed']), toKm: numberOf(cost['toKm']) }])),
    write: (value) => (value as Array<{ taxed: number; toKm: number }>).map((cost) => ({ taxed: cost.taxed, toKm: cost.toKm })),
  },
  minAmount: minimumOrder,
  priceListsConfig: {
    read: (value) =>
      Object.fromEntries(
        Object.entries(isPlain(value) ? value : {}).flatMap(([id, config]) =>
          isPlain(config)
            ? [
                [
                  id,
                  {
                    roundTime: wholeNumber(config['roundTime']),
                    roundMaxProducts: wholeNumber(config['roundMaxProducts']),
                    totalMaxProducts: wholeNumber(config['totalMaxProducts']),
                    variants: config['variants'] === true,
                    freeVariants: config['freeVariants'] === true,
                    tableAutoClose: config['tableAutoClose'] === true,
                    productsCategories: list(config['productsCategories']).flatMap((category) =>
                      typeof category['_id'] === 'string'
                        ? [{ _id: category['_id'], roundMaxProducts: wholeNumber(category['roundMaxProducts']), totalMaxProducts: wholeNumber(category['totalMaxProducts']), position: wholeNumber(category['position']), purchasable: category['purchasable'] === true }]
                        : [],
                    ),
                  },
                ],
              ]
            : [],
        ),
      ),
    write: (value) =>
      Object.fromEntries(
        Object.entries(value as Record<string, { roundTime: number | null; roundMaxProducts: number | null; totalMaxProducts: number | null; variants: boolean; freeVariants: boolean; tableAutoClose: boolean; productsCategories: Array<Record<string, unknown>> }>).map(
          ([id, config]) => [
            id,
            {
              roundTime: config.roundTime,
              roundMaxProducts: config.roundMaxProducts,
              totalMaxProducts: config.totalMaxProducts,
              variants: config.variants,
              freeVariants: config.freeVariants,
              tableAutoClose: config.tableAutoClose,
              productsCategories: config.productsCategories.map((category) => ({
                _id: category['_id'],
                roundMaxProducts: category['roundMaxProducts'],
                totalMaxProducts: category['totalMaxProducts'],
                position: category['position'],
                purchasable: category['purchasable'],
              })),
            },
          ],
        ),
      ),
  },
  kioskCategories: {
    read: (value) => list(value).flatMap((category) => (typeof category['_id'] === 'string' ? [{ _id: category['_id'], position: wholeNumber(category['position']) }] : [])),
    write: (value) => (value as Array<{ _id: string; position: number | null }>).map((category) => ({ _id: category._id, position: category.position })),
  },
  // The categories of TS Hospitality the places map to: the ids of the place's categories to ids of the provider, both text.
  tshCategoriesMap: {
    read: (value) => Object.fromEntries(Object.entries(isPlain(value) ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    write: (value) => value,
  },
  // The categories the provider listed, kept in the document: read only.
  tshCategories: {
    read: (value) => list(value).flatMap((category) => (typeof category['id'] === 'string' && typeof category['name'] === 'string' ? [{ id: category['id'], name: category['name'] }] : [])),
    write: (value) => value,
  },
  // The texts by language: a write sets the languages of the request and keeps the others the document has.
  languageTexts: {
    read: (value) => Object.fromEntries(Object.entries(isPlain(value) ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    write: (value, stored) => ({ ...(isPlain(stored) ? stored : {}), ...(value as Record<string, string>) }),
  },
};

/** The codec of a settings key: how its stored value becomes a value of the domain (tolerant: a missing or mistyped value is the default of the form) and back. */
export function codecOf(kind: SettingKind): Codec {
  switch (kind.t) {
    case 'flag':
      return flag;
    case 'text':
      return { read: nonEmptyOrNull, write: (value) => value };
    case 'plain':
      return { read: (value) => textOr(value), write: (value) => value };
    case 'secret':
      // Never read back: the leaf is write-only, the flag of the credential is the other key.
      return { read: () => undefined, write: (value) => value };
    case 'secretFlag':
      return { read: (value) => typeof value === 'string' && value !== '', write: (value) => value };
    case 'enum':
      return { read: (value) => (typeof value === 'string' && kind.values.includes(value) ? value : kind.def), write: (value) => value ?? kind.def };
    case 'font':
      return { read: (value) => (typeof value === 'string' && FONT.test(value) ? value : kind.def), write: (value) => value };
    case 'color':
      return { read: (value) => (typeof value === 'string' && COLOR.test(value) ? value : kind.def), write: (value) => value };
    case 'time':
      return { read: nonEmptyOrNull, write: (value) => value };
    case 'int':
      return { read: (value) => wholeNumber(value) ?? kind.def, write: (value) => value ?? kind.def };
    case 'num':
      return { read: (value) => numberOf(value), write: (value) => value };
    case 'id':
      return { read: (value) => (value instanceof ObjectId ? value.toHexString() : null), write: (value) => (value === null ? null : ObjectId.createFromHexString(value as string)) };
    case 'ref':
      return { read: nonEmptyOrNull, write: (value) => value ?? kind.empty };
    case 'logo':
      return logo;
    case 'whole':
      return WHOLE[kind.name];
  }
}

/** The leaves of the settings blocks, for `PLACE_LEAVES`: the domain path, the stored path and the codec of every key, and the deprecated copies (not part of the domain) left out. */
export const SETTING_LEAVES: readonly Leaf[] = Object.freeze(
  SETTING_FIELDS.map(
    (field): Leaf => ({
      domain: field.domain,
      legacy: field.legacy,
      codec: codecOf(field.kind),
      ...(field.readOnly === true || field.kind.t === 'secretFlag' ? { readOnly: true as const } : {}),
      ...(field.kind.t === 'secret' ? { writeOnly: true as const } : {}),
    }),
  ),
);
