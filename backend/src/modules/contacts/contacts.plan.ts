import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { addressProblem } from '../companies/address.ts';
import type { Country } from '../companies/companies.repository.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { isRecord, recordsOf, valueAt } from '../groups/catalogs/kit.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { applyChange } from '../product-categories/categories.document.ts';
import { CONTACT_CONTAINERS, CONTACT_FIELDS, cardsOf, clearText, contactData, isEncrypted, sameStored } from './contacts.document.ts';
import type { AddressData, ContactService, SupplierPriceList } from './contacts.document.ts';
import type { ContactsRepository } from './contacts.repository.ts';
import type { ContactBody } from './contacts.schemas.ts';

/** What the plan of a write reads. */
export interface PlanDeps {
  readonly repository: Pick<ContactsRepository, 'groupExists' | 'companyExists' | 'invalidServices' | 'accountTaken' | 'productsUsingPriceLists'>;
  readonly catalogs: Pick<CatalogsService, 'list'>;
  /** Reads a country of the platform by its code. */
  readonly findCountry: (code: string) => Promise<Country | null>;
  /** Generator of the ids of the new supplier price lists. */
  readonly newElementId: () => string;
}

/** What a write of a contact comes to. */
export interface ContactPlan {
  /** The `422` problems: a value that is not acceptable, a reference that does not exist. */
  readonly issues: ErrorDetail[];
  /** The `409` problems (only worked out when there are no issues): an account another contact has, a price list a product still uses. A card code is never one: several contacts may share a card. */
  readonly conflicts: ErrorDetail[];
  /** The fields to set and to unset, as dotted paths of the document (a container as a whole only when it was not an object). */
  readonly set: Document;
  readonly unset: Document;
  /** The containers that are in `set` as a whole. */
  readonly containers: string[];
  /** What the document had at each path of `set` and `unset` (not the containers), `undefined` when nothing. */
  readonly readValues: Record<string, unknown>;
  /** The codes of the cards to add and to remove. */
  readonly added: string[];
  readonly removed: string[];
  /** Whether the request changes anything. */
  readonly changed: boolean;
}

/** The address checks of one address: the country and the province must exist, and a province needs a country. */
async function addressIssues(deps: PlanDeps, prefix: string, address: AddressData, changed: ReadonlySet<string>): Promise<ErrorDetail[]> {
  const country = changed.has(`${prefix}.countryCode`);
  if (!country && !changed.has(`${prefix}.areaCode`)) {
    return [];
  }
  if (address.countryCode === null) {
    return address.areaCode === null ? [] : [{ field: `${prefix}.areaCode`, issue: 'incorrect' }];
  }
  const problem = await addressProblem(deps.findCountry, address.countryCode, address.areaCode ?? '', country);
  return problem === null ? [] : [{ field: `${prefix}.${problem === 'address.country' ? 'countryCode' : 'areaCode'}`, issue: 'incorrect' }];
}

/** The supplier price lists of a request: the ones that have no id get one. */
function withIds(value: readonly { readonly id?: string | undefined; readonly name: string; readonly favorite?: boolean | undefined }[], newId: () => string): SupplierPriceList[] {
  return value.map((item) => ({ id: item.id ?? newId(), name: item.name, favorite: item.favorite === true }));
}

/**
 * Works out what a creation or a modification of a contact writes. Only the fields the request names are looked at, and only the ones whose stored value differs are written; a reference (group of contacts, price list, company,
 * service, country, province) is judged only when the request changes it, so an old reference that is gone never blocks an unrelated change. The cards are a difference of codes (never a rewrite of the array); the supplier
 * price lists are replaced as a whole, and one a product still uses cannot be taken away. A container (`fattura_elettronica`, `account`) that is not an object in the document is replaced as a whole.
 *
 * @param deps The reads.
 * @param input The caller, the group, the stored contact (a blank one for a creation) and the validated body.
 */
export async function planContact(deps: PlanDeps, input: { readonly principal: ScopeHolder; readonly access: GroupAccess; readonly id: ObjectId; readonly stored: Document; readonly body: ContactBody; readonly creating: boolean }): Promise<ContactPlan> {
  const { principal, access, id, stored, body, creating } = input;
  const { repository } = deps;
  const set: Document = {};
  const unset: Document = {};
  const changed = new Set<string>();
  for (const field of CONTACT_FIELDS) {
    const value = valueAt(body, field.key);
    if (value === undefined) {
      continue;
    }
    const next = field.key === 'company.supplierPriceLists' ? withIds(value as Parameters<typeof withIds>[0], deps.newElementId) : value;
    const written: unknown = field.store(next as never);
    const raw = valueAt(stored, field.doc);
    // A text the legacy stored encrypted is shown as `''`: sending `''` back does not overwrite it.
    if (sameStored(raw, written) || (isEncrypted(raw) && sameStored(field.read(raw), next))) {
      continue;
    }
    changed.add(field.key);
    if (written === undefined) {
      unset[field.doc] = '';
    } else {
      set[field.doc] = written;
    }
  }
  const readValues: Record<string, unknown> = {};
  const containers: string[] = [];
  const shapes = isRecord(stored['__shapes']) ? stored['__shapes'] : {};
  for (const container of CONTACT_CONTAINERS) {
    const leaves = CONTACT_FIELDS.filter((field) => field.doc.startsWith(`${container}.`));
    // `object` and `missing` take leaves; anything else (a `null`, a text…) is replaced as a whole.
    if (shapes[container] !== undefined && shapes[container] !== 'object' && shapes[container] !== 'missing' && leaves.some((field) => field.doc in set)) {
      // The legacy left something that is not an object where the leaves go: it is replaced, only if it is still what was read.
      const whole: Document = {};
      for (const field of leaves) {
        // A leaf the request does not change takes its default: it cannot have a stored value, since the container is not an object.
        const written: unknown = field.doc in set ? set[field.doc] : field.store(field.empty as never);
        if (written !== undefined) {
          whole[field.doc.slice(container.length + 1)] = written;
        }
        delete set[field.doc];
      }
      set[container] = whole;
      containers.push(container);
    }
  }
  for (const path of [...Object.keys(set), ...Object.keys(unset)].filter((key) => !containers.includes(key))) {
    readValues[path] = valueAt(stored, path);
  }

  const currentCards = cardsOf(stored['fidelities']).map((card) => card.code);
  const wantedCards = body.fidelityCards?.map((card) => card.code);
  const added = wantedCards === undefined ? [] : wantedCards.filter((code) => !currentCards.includes(code));
  // A card is removed by the code it is stored with (`' ABC '` is shown, and asked for, as `ABC`).
  const removed = wantedCards === undefined ? [] : recordsOf(stored['fidelities']).flatMap((card) => (currentCards.includes(clearText(card['code'])) && !wantedCards.includes(clearText(card['code'])) ? [card['code'] as string] : []));

  const after = contactData(applyChange(stored, set, unset));
  const issues: ErrorDetail[] = [];
  if ((creating || changed.has('person.firstName') || changed.has('company.name')) && after.person.firstName === '' && after.company.name === '') {
    issues.push({ field: 'person.firstName', issue: 'required' }, { field: 'company.name', issue: 'required' });
  }
  issues.push(...(await addressIssues(deps, 'person.address', after.person.address, changed)), ...(await addressIssues(deps, 'company.address', after.company.address, changed)));
  if (changed.has('contactGroupId') && after.contactGroupId !== null && !(await repository.groupExists(principal, access, ObjectId.createFromHexString(after.contactGroupId)))) {
    issues.push({ field: 'contactGroupId', issue: 'incorrect' });
  }
  if (changed.has('priceListId') && after.priceListId !== null && !((await deps.catalogs.list(priceLists, access)) as PriceList[]).some((list) => list.id === after.priceListId && list.enabled)) {
    issues.push({ field: 'priceListId', issue: 'incorrect' });
  }
  const company = after.person.associatedCompanyId;
  if (changed.has('person.associatedCompanyId') && company !== null && (company === id.toHexString() || !(await repository.companyExists(principal, access, ObjectId.createFromHexString(company))))) {
    issues.push({ field: 'person.associatedCompanyId', issue: 'incorrect' });
  }
  if (body.services !== undefined && !access.features.services) {
    issues.push({ field: 'services', issue: 'notAllowed' });
  } else if (body.services !== undefined && changed.has('services')) {
    const known = new Set(contactData(stored).services.map((service) => service.productId));
    const requested: readonly ContactService[] = body.services;
    const fresh = requested.filter((service) => !known.has(service.productId));
    const invalid = fresh.length === 0 ? [] : await repository.invalidServices(principal, access, fresh.map((service) => service.productId));
    issues.push(...invalid.map((position) => ({ field: `services.${String(requested.indexOf(fresh[position]!))}.productId`, issue: 'incorrect' })));
  }

  const conflicts: ErrorDetail[] = [];
  if (issues.length === 0) {
    const account = await repository.accountTaken(principal, access, id, { email: changed.has('account.email') ? after.account.email : null, phone: changed.has('account.phone') ? after.account.phone : null });
    if (account.email) {
      conflicts.push({ field: 'account.email', issue: 'taken' });
    }
    if (account.phone) {
      conflicts.push({ field: 'account.phone', issue: 'taken' });
    }
    if (changed.has('company.supplierPriceLists')) {
      const kept = new Set(after.company.supplierPriceLists.map((list) => list.id));
      const gone = contactData(stored).company.supplierPriceLists.filter((list) => !kept.has(list.id)).map((list) => list.id);
      const using = gone.length === 0 ? [] : await repository.productsUsingPriceLists(principal, access, id, gone);
      conflicts.push(...using.map((product) => ({ field: `products.${product}`, issue: 'referenced' })));
    }
  }
  return { issues, conflicts, set, unset, containers, readValues, added, removed, changed: Object.keys(set).length > 0 || Object.keys(unset).length > 0 || added.length > 0 || removed.length > 0 };
}
