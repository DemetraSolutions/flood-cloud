import { ObjectId } from 'mongodb';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { companyInScope } from '../../shared/security/scope/scope-filters.ts';
import type { CompaniesPlacesWriter } from '../../shared/legacy-write/companies-places.writer.ts';
import { MEDIA_LOGO_SLOTS, SETTING_FIELDS } from '../../shared/legacy-write/place-settings.ts';
import type { ReferencesRepository } from '../groups/catalogs/references.repository.ts';
import type { MediaService } from '../media/media.service.ts';
import type { GroupLists } from '../companies/companies.repository.ts';
import { setValueAt, valueAt } from '../companies/company.mapper.ts';
import type { ImageReference, MediaLogo } from '../companies/company.types.ts';
import type { PlacesRepository } from './places.repository.ts';
import type { Place } from './place.types.ts';

/** The e-mail templates a place refers to: the five of the reservations and the one of the appointments. */
const TEMPLATE_PATHS = [
  'reservations.emailNotification.templateId',
  'reservations.email.templateId',
  'reservations.emailConfirmedStatus.templateId',
  'reservations.emailRefusedStatus.templateId',
  'reservations.emailChangeStatus.templateId',
  'appointments.email.templateId',
] as const;

/** The texts of the kiosk by language. */
const KIOSK_TEXTS = ['titleText', 'subTitleText', 'startButtonText', 'eatHereText', 'takeAwayText'] as const;

/** The forms of the keys that are a time, a font size or a color: checked where the value changes. */
const FORMS = { time: /^(?:[01]\d|2[0-3]):[0-5]\d$/, font: /^[1-3]-[1-3]$/, color: /^#[0-9a-fA-F]{6}$/ } as const;

/** What the rules of the settings need: the request, the place as it is, and the means to judge the data it refers to. */
export interface SettingsRules {
  readonly principal: AuthPrincipal;
  readonly access: GroupAccess;
  readonly writer: CompaniesPlacesWriter;
  readonly repository: PlacesRepository;
  readonly references: Pick<ReferencesRepository, 'missing'>;
  readonly images: Pick<MediaService, 'logoSource'>;
  /** A new id for a payment type, in the form of the legacy. */
  readonly newId: () => string;
  /** The request, and the copy of it the checks complete (new ids, the maps merged with what the place has, the descriptors of the images). */
  readonly request: Readonly<Record<string, unknown>>;
  readonly next: Record<string, unknown>;
  /** The place as it is, `null` for a creation. */
  readonly current: Place | null;
  /** The id of the company the place will have, `null` when it has none. */
  readonly companyId: string | null;
  /** Whether the request changes the value at a domain path (or sets it, on a creation). */
  readonly changes: (path: string) => boolean;
  readonly issue: (field: string, kind: string) => void;
  /** The currencies and price lists of the group, read once. */
  readonly lists: () => Promise<GroupLists>;
}

const asList = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []);
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/**
 * The rules of the settings that depend on data outside the request (`doc/Tasks.md` 7B): every reference is checked where it changes, so a place whose data does not satisfy a rule
 * anymore (a price list that was disabled) stays modifiable in what the rule does not touch. Problems are reported with {@link SettingsRules.issue}; `next` is completed (ids of the new
 * payment types, minimum orders merged with the currencies the place has, the descriptors of the images built from the stored files).
 */
export async function applySettingsRules(c: SettingsRules): Promise<void> {
  const { request, current, changes, issue } = c;

  // The times, the font sizes and the colors have a form, but only a value that changes is judged: a historical one sent back as it is stays (as the opening hours of step 7A).
  for (const field of SETTING_FIELDS) {
    const form = field.kind.t === 'time' || field.kind.t === 'font' || field.kind.t === 'color' ? FORMS[field.kind.t] : null;
    const value = valueAt(request, field.domain);
    if (form !== null && typeof value === 'string' && changes(field.domain) && !form.test(value)) {
      issue(field.domain, 'pattern');
    }
  }
  // The texts with a form (the Stripe public key, the country of Reserve with Google, the address of the server) are judged where they change, as the times above.
  for (const field of SETTING_FIELDS) {
    const value = valueAt(request, field.domain);
    if ((field.kind.t === 'text' || field.kind.t === 'plain') && field.kind.pattern !== undefined && typeof value === 'string' && changes(field.domain) && !field.kind.pattern.test(value)) {
      issue(field.domain, 'pattern');
    }
  }
  // The map of the categories of TS Hospitality: a value that changes is the id of a category the provider listed, which is the copy the place keeps (the maps of the categories of the place are free).
  const listed = new Set(asList(valueAt(current, 'integrations.tsh.categories')).map((category) => category['id']));
  const mapped = asRecord(valueAt(current, 'integrations.tsh.categoriesMap'));
  for (const [category, target] of Object.entries(asRecord(valueAt(request, 'integrations.tsh.categoriesMap')))) {
    if (mapped[category] !== target && !listed.has(target)) {
      issue(`integrations.tsh.categoriesMap.${category}`, 'incorrect');
    }
  }
  const knownBlocks = new Set(asList(valueAt(current, 'reservations.timeBlocks')).map((block) => JSON.stringify(block)));
  asList(valueAt(request, 'reservations.timeBlocks')).forEach((block, index) => {
    if (!knownBlocks.has(JSON.stringify(block))) {
      (['start', 'end'] as const).filter((edge) => !FORMS.time.test(block[edge] as string)).forEach((edge) => issue(`reservations.timeBlocks.${String(index)}.${edge}`, 'pattern'));
    }
  });

  // Reserve with Google: while the integration is on, its data is complete (the feed of the provider takes a place only then; a latitude or a longitude of `0` counts as missing, as in the legacy).
  const rwg = (key: string): string => `integrations.reserveWithGoogle.${key}`;
  const rwgData = ['category', 'name', 'geo.latitude', 'geo.longitude', 'geo.address.streetAddress', 'geo.address.locality', 'geo.address.postalCode', 'geo.address.country'].map(rwg);
  if ([rwg('status'), ...rwgData].some(changes)) {
    const effective = (path: string): unknown => (valueAt(request, path) !== undefined ? valueAt(request, path) : valueAt(current, path));
    if (effective(rwg('status')) === true) {
      rwgData.filter((path) => !effective(path)).forEach((path) => issue(path, 'required'));
    }
  }

  // The e-mail templates exist in the group.
  const templates = TEMPLATE_PATHS.filter((path) => changes(path) && valueAt(request, path) !== null);
  if (templates.length > 0) {
    const missing = await c.repository.missingTemplates(c.principal, c.access, templates.map((path) => ObjectId.createFromHexString(valueAt(request, path) as string)));
    templates.filter((_path, index) => missing.has(index)).forEach((path) => issue(path, 'incorrect'));
  }

  // The price lists the delivery, the kiosk and the self ordering use are price lists of the group.
  const listPaths = ['delivery.takeAway.deliveryListId', 'delivery.takeAway.takeAwayListId', 'kiosk.listId'].filter((path) => changes(path) && valueAt(request, path) !== null);
  const configs = Object.keys(asRecord(valueAt(request, 'selfOrdering.priceListsConfig'))).filter((key) => !Object.hasOwn(asRecord(valueAt(current, 'selfOrdering.priceListsConfig')), key));
  const minimum = asRecord(valueAt(request, 'delivery.minAmount'));
  if (listPaths.length > 0 || configs.length > 0 || Object.keys(minimum).length > 0) {
    const lists = await c.lists();
    listPaths.filter((path) => !lists.priceLists.has(valueAt(request, path) as string)).forEach((path) => issue(path, 'incorrect'));
    configs.filter((key) => !lists.priceLists.has(key)).forEach((key) => issue(`selfOrdering.priceListsConfig.${key}`, 'incorrect'));
    // The minimum orders: the currencies of the group; the ones the place has besides stay as they are.
    const stored = asRecord(valueAt(current, 'delivery.minAmount'));
    for (const [code, amount] of Object.entries(minimum)) {
      if (stored[code] !== amount && !lists.currencies.has(code)) {
        issue(`delivery.minAmount.${code}`, 'incorrect');
      }
    }
    if (Object.keys(minimum).length > 0) {
      setValueAt(c.next, 'delivery.minAmount', { ...stored, ...minimum });
    }
  }

  // The categories of the kiosk and of the self ordering exist in the group.
  const categories: Array<{ field: string; id: string }> = [];
  const upselling = valueAt(request, 'kiosk.upsellingCategoryId');
  if (changes('kiosk.upsellingCategoryId') && typeof upselling === 'string') {
    categories.push({ field: 'kiosk.upsellingCategoryId', id: upselling });
  }
  const knownKiosk = new Set(asList(valueAt(current, 'kiosk.productsCategories')).map((category) => category['_id']));
  asList(valueAt(request, 'kiosk.productsCategories')).forEach((category, index) => !knownKiosk.has(category['_id']) && categories.push({ field: `kiosk.productsCategories.${String(index)}._id`, id: category['_id'] as string }));
  const storedConfigs = asRecord(valueAt(current, 'selfOrdering.priceListsConfig'));
  for (const [listId, config] of Object.entries(asRecord(valueAt(request, 'selfOrdering.priceListsConfig')))) {
    const known = new Set(asList(asRecord(storedConfigs[listId])['productsCategories']).map((category) => category['_id']));
    asList(asRecord(config)['productsCategories']).forEach((category, index) => !known.has(category['_id']) && categories.push({ field: `selfOrdering.priceListsConfig.${listId}.productsCategories.${String(index)}._id`, id: category['_id'] as string }));
  }
  if (categories.length > 0) {
    const missing = await c.references.missing(c.principal, c.access, { field: 'categories', collection: 'categories', ids: categories.map((category) => category.id) });
    missing.forEach((index) => issue(categories[index]!.field, 'incorrect'));
  }

  // The texts of the kiosk are in languages of the group (the languages the place has besides stay), merged with what the place has.
  const wanted = KIOSK_TEXTS.filter((name) => changes(`kiosk.${name}`));
  if (wanted.length > 0) {
    const languages = await c.repository.groupLanguages(c.access.groupId);
    for (const name of wanted) {
      const stored = asRecord(valueAt(current, `kiosk.${name}`));
      const texts = asRecord(valueAt(request, `kiosk.${name}`));
      Object.keys(texts).filter((language) => stored[language] !== texts[language] && !languages.has(language)).forEach((language) => issue(`kiosk.${name}.${language}`, 'incorrect'));
      setValueAt(c.next, `kiosk.${name}`, { ...stored, ...texts });
    }
  }

  // The company and the place of the tobacco shop: of the group, and the company inside the perimeter.
  const tobaccoCompany = valueAt(request, 'tobacco.companyId');
  if (changes('tobacco.companyId') && typeof tobaccoCompany === 'string') {
    const id = ObjectId.createFromHexString(tobaccoCompany);
    // A place administrator has no companies in his scope: the company of his own place counts.
    const inScope = companyInScope(c.principal.scope, id) || (c.principal.scope.kind === 'places' && c.companyId === tobaccoCompany);
    const company = inScope ? await c.writer.companyOfPlace(id) : null;
    if (company === null || company.trashed) {
      issue('tobacco.companyId', 'incorrect');
    }
  }
  const tobaccoPlace = valueAt(request, 'tobacco.placeId');
  if (changes('tobacco.placeId') && typeof tobaccoPlace === 'string') {
    // A place in the trash is not a place to point to (an unchanged value is never judged again).
    const found = await c.writer.read('places', ObjectId.createFromHexString(tobaccoPlace));
    if (found === null || found.document['trash'] === true) {
      issue('tobacco.placeId', 'incorrect');
    }
  }

  // The payment types: an id is one the place has, a new type gets one of the form of the legacy.
  const types = valueAt(request, 'payments.paymentTypes');
  if (Array.isArray(types)) {
    const known = new Set(asList(valueAt(current, 'payments.paymentTypes')).map((type) => type['id']));
    const used = new Set<unknown>();
    setValueAt(
      c.next,
      'payments.paymentTypes',
      asList(types).map((type, index) => {
        if (type['id'] !== undefined && (!known.has(type['id']) || used.has(type['id']))) {
          issue(`payments.paymentTypes.${String(index)}.id`, 'incorrect');
        }
        const id = (type['id'] as string | undefined) ?? c.newId();
        used.add(id);
        return { ...type, id };
      }),
    );
  }

  // The images: removed, sent back as they are, or picked from the images of the group (a company or place administrator uses only the images of the company of the place).
  for (const slot of MEDIA_LOGO_SLOTS) {
    const path = `media.${slot}`;
    const value = valueAt(request, path) as ImageReference | MediaLogo | null | undefined;
    if (value != null && 'imageId' in value) {
      const source = await c.images.logoSource(c.principal, c.access, ObjectId.createFromHexString(value.imageId), c.companyId === null ? null : ObjectId.createFromHexString(c.companyId));
      if (source === null) {
        issue(path, 'incorrect');
      } else {
        setValueAt(c.next, path, source);
      }
    } else if (value !== null && changes(path)) {
      issue(path, 'notAllowed');
    }
  }
}
