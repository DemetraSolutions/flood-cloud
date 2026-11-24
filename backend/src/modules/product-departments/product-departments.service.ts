import { Int32 } from 'mongodb';
import type { Document, ObjectId } from 'mongodb';
import type { ReferencesRepository } from '../groups/catalogs/references.repository.ts';
import { PRODUCTS_DEPARTMENTS_OWNED_FIELDS } from '../../db/collections.ts';
import { integerOf, conflict, invalid, referenced, valueAt } from '../groups/catalogs/kit.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { taxes } from '../groups/catalogs/taxes.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import { createEntityService } from '../product-catalog/entity.service.ts';
import type { EntityChanges, EntityKind, EntityService, EntityView, KindContext } from '../product-catalog/entity.service.ts';
import type { GroupLanguages } from '../product-catalog/group-languages.ts';
import { userField } from '../product-catalog/product-references.ts';
import type { ProductReferences } from '../product-catalog/product-references.ts';
import { codeOf, departmentExtra, taxCopyOf } from './product-departments.mapper.ts';
import type { DepartmentExtra } from './product-departments.mapper.ts';
import type { DepartmentsRepository } from './product-departments.repository.ts';
import { departmentsListFor } from './product-departments.schemas.ts';
import type { CreateDepartmentBody, PatchDepartmentBody } from './product-departments.schemas.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';

/** A department as the API shows it. */
export type Department = EntityView & DepartmentExtra;

/** The service of the departments of a group (`doc/Tasks.md` step C1). */
export type DepartmentsService = EntityService<Department, CreateDepartmentBody, PatchDepartmentBody> & EntityChanges<Department>;

/** Collaborators of {@link createDepartmentsService}. */
export interface DepartmentsServiceDeps {
  readonly repository: DepartmentsRepository;
  /** Reads the tax rates of the group document. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
  readonly products: Pick<ProductReferences, 'withDepartmentNumber'>;
  readonly references: Pick<ReferencesRepository, 'missing'>;
  readonly images: { imageSource(principal: CatalogCaller, access: GroupAccess, imageId: ObjectId): Promise<MediaLogo | null> };
  readonly languages: GroupLanguages;
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  readonly versionKey: Buffer;
  readonly now: () => number;
  readonly newId?: () => ObjectId;
}

/**
 * The department-only rules: the code is a whole number from 1 to 99, unique in the group (compared as a number: `'1'` and `1` are the same code), the tax rate is one of the group, and a department
 * is deleted only when nothing of the cash register needs it.
 */
function createDepartmentsKind(deps: Pick<DepartmentsServiceDeps, 'repository' | 'catalogs' | 'products'>): EntityKind<DepartmentExtra, CreateDepartmentBody, PatchDepartmentBody> {
  const { repository, catalogs, products } = deps;
  const taxOf = async ({ access }: KindContext, id: string): Promise<Tax> => {
    const tax = ((await catalogs.list(taxes, access)) as Tax[]).find((candidate) => candidate.id === id);
    if (tax === undefined) {
      throw invalid('taxId', 'incorrect');
    }
    return tax;
  };
  const assertCodeFree = async ({ principal, access }: KindContext, code: number, except: ObjectId | null): Promise<void> => {
    if ((await repository.codes(principal, access)).some((entry) => codeOf(entry.code) === code && (except === null || !entry.id.equals(except)))) {
      throw conflict('code', 'taken');
    }
  };
  return {
    resource: 'productDepartment',
    actions: { created: 'productDepartment.created', updated: 'productDepartment.updated', deleted: 'productDepartment.deleted' },
    ownedFields: PRODUCTS_DEPARTMENTS_OWNED_FIELDS,
    listConfig: departmentsListFor,
    extra: departmentExtra,
    loggable: (extra) => ({ code: extra.code, taxId: extra.taxId, noDiscount: extra.noDiscount, secondaryFiscalPrinter: extra.secondaryFiscalPrinter }),

    create: async (context, body) => {
      const tax = await taxOf(context, body.taxId);
      await assertCodeFree(context, body.code, null);
      return { code: new Int32(body.code), tax: taxCopyOf(tax), noDiscount: body.noDiscount ?? false, secondaryFiscalPrinter: body.secondaryFiscalPrinter ?? false };
    },

    patch: async (context, found, body) => {
      const set: Document = {};
      const stored = departmentExtra(found);
      if (body.code !== undefined && stored.code !== body.code) {
        await assertCodeFree(context, body.code, found['_id'] as ObjectId);
        set['code'] = new Int32(body.code);
      }
      if (body.taxId !== undefined && stored.taxId !== body.taxId) {
        set['tax'] = taxCopyOf(await taxOf(context, body.taxId));
      }
      if (body.noDiscount !== undefined && stored.noDiscount !== body.noDiscount) {
        set['noDiscount'] = body.noDiscount;
      }
      if (body.secondaryFiscalPrinter !== undefined && stored.secondaryFiscalPrinter !== body.secondaryFiscalPrinter) {
        set['secondaryFiscalPrinter'] = body.secondaryFiscalPrinter;
      }
      return set;
    },

    settle: async (context, { id, previous, document }) => {
      // Without a unique index two requests can both pass the check. The one that wrote last (the more recent `updateDate`, the larger `_id` on a tie) loses and has its whole write undone by the
      // service. A known limit: two writes closer than the difference between the clocks of the servers can each see the other as the later one and both be undone, or the other way round, and the
      // definitive answer is an index the collections of a group cannot have yet (a decision of the owner).
      const code = codeOf(document['code']);
      if (code === null || (previous !== undefined && codeOf(previous['code']) === code)) {
        return null;
      }
      const time = (value: unknown): number => (value instanceof Date ? value.getTime() : 0);
      const mine = time(document['updateDate']);
      const lost = (await repository.codes(context.principal, context.access)).some(
        (entry) => codeOf(entry.code) === code && !entry.id.equals(id) && (time(entry.updateDate) < mine || (time(entry.updateDate) === mine && entry.id.toHexString() < id.toHexString())),
      );
      return lost ? conflict('code', 'taken') : null;
    },

    guardRemove: async ({ principal, access }, found) => {
      // The POS matches the department of the cash register with the department number of the tax of a price: the last active department with that number cannot go while a product still has it.
      const department = integerOf(valueAt(found, 'tax.department'));
      if (found['status'] !== true || department === null) {
        return;
      }
      if (await repository.hasOtherActiveWithNumber(principal, access, found['_id'] as ObjectId, department)) {
        return;
      }
      const users = await products.withDepartmentNumber(principal, access, department);
      if (users.length > 0) {
        throw referenced(users.map((id) => userField('products', id)));
      }
    },
  };
}

/**
 * Builds the service of the departments of a group: the rules of {@link createEntityService} and the ones of a department.
 *
 * @param deps Repository, the tax rates, the products, the places, the images, the languages, the users, the activity log, the version key and the clock.
 */
export function createDepartmentsService(deps: DepartmentsServiceDeps): DepartmentsService {
  return createEntityService({
    kind: createDepartmentsKind(deps),
    repository: deps.repository,
    places: deps.references,
    images: deps.images,
    languages: deps.languages,
    users: deps.users,
    activityLog: deps.activityLog,
    logger: deps.logger,
    versionKey: deps.versionKey,
    now: deps.now,
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
}

