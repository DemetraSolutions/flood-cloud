import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route, UrlSegment, UrlTree } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { AttributeGroupsPage } from './attribute-groups-page';
import { CatalogItemPage } from './catalog-item-page';
import { leaveCatalogItem } from './catalog-item-leave';
import { CatalogList } from './catalog-list';

const GROUP = '665f1c2e9b1d4a0012ab34a2';

function route(path: string): Route {
  const find = (list: readonly Route[]): Route | undefined => {
    for (const item of list) {
      if (item.path === path) {
        return item;
      }
      const found = find(item.children ?? []);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return find(routes) as Route;
}

async function matches(
  path: string,
  permissions: string[],
  features: Record<string, boolean> = { cash: true },
): Promise<boolean> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  signIn({ role: 'SA', permissions, groupFeatures: fakeFeatureFlags(false, features) });
  const found = route(path);
  const segments = path
    .replace(':groupId', GROUP)
    .split('/')
    .map((part) => new UrlSegment(part, {}));
  for (const guard of found.canMatch as CanMatchFn[]) {
    const result = await TestBed.runInInjectionContext(() => guard(found, segments, {} as never));
    if (result instanceof UrlTree || result !== true) {
      return false;
    }
  }
  return true;
}

const SEGMENTS = [
  ['departments', 'product-departments', 'DEPARTMENTS'],
  ['brands', 'product-brands', 'BRANDS'],
] as const;

describe('product catalog routes', () => {
  describe.each(SEGMENTS)('%s', (kind, segment, text) => {
    const list = `groups/:groupId/${segment}`;
    const create = `${list}/new`;
    const edit = `${list}/:itemId`;

    it('has a list, a new page and a detail page, titled and lazy', async () => {
      expect(route(list).title).toBe(`PRODUCT_CATALOG.${text}.TITLE`);
      expect(route(create).title).toBe(`PRODUCT_CATALOG.${text}.FORM.NEW_TITLE`);
      expect(route(edit).title).toBe(`PRODUCT_CATALOG.${text}.FORM.EDIT_TITLE`);
      expect(await route(list).loadComponent?.()).toBe(CatalogList);
      expect(await route(create).loadComponent?.()).toBe(CatalogItemPage);
      expect(await route(edit).loadComponent?.()).toBe(CatalogItemPage);
    });

    it('passes the kind as route data', () => {
      for (const path of [list, create, edit]) {
        expect(route(path).data).toEqual({ kind });
      }
    });

    it('asks to confirm leaving the form, not the list', () => {
      expect(route(create).canDeactivate).toEqual([leaveCatalogItem]);
      expect(route(edit).canDeactivate).toEqual([leaveCatalogItem]);
      expect(route(list).canDeactivate).toBeUndefined();
    });

    it('reads with products:read and creates with products:update', async () => {
      expect(await matches(list, ['products:read'])).toBe(true);
      expect(await matches(edit, ['products:read'])).toBe(true);
      expect(await matches(create, ['products:update'])).toBe(true);
      expect(await matches(list, ['places:read'])).toBe(false);
      expect(await matches(edit, ['places:read'])).toBe(false);
      expect(await matches(create, ['products:read'])).toBe(false);
    });
  });

  it('the departments need the cash feature of the group, the brands do not', async () => {
    for (const path of [
      'groups/:groupId/product-departments',
      'groups/:groupId/product-departments/new',
      'groups/:groupId/product-departments/:itemId',
    ]) {
      expect(await matches(path, ['products:read', 'products:update'], { cash: false })).toBe(false);
    }
    for (const path of [
      'groups/:groupId/product-brands',
      'groups/:groupId/product-brands/new',
      'groups/:groupId/product-brands/:itemId',
    ]) {
      expect(await matches(path, ['products:read', 'products:update'], { cash: false })).toBe(true);
    }
  });

  it('the attribute groups are titled, lazy and for who reads products', async () => {
    const found = route('groups/:groupId/product-attribute-groups');
    expect(found.title).toBe('PRODUCT_CATALOG.ATTRIBUTES.TITLE');
    expect(await found.loadComponent?.()).toBe(AttributeGroupsPage);
    expect(await matches('groups/:groupId/product-attribute-groups', ['products:read'], {})).toBe(true);
    expect(await matches('groups/:groupId/product-attribute-groups', ['places:read'], {})).toBe(false);
  });
});
