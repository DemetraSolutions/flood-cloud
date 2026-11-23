import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route, UrlSegment, UrlTree } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { ProductList } from './product-list';
import { leaveProduct } from './product-leave';
import { ProductPage } from './product-page';
import { FAMILIES, FAMILY_ORDER, ProductFamily } from './product.types';

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

async function matches(path: string, permissions: string[], features: Record<string, boolean> = {}): Promise<boolean> {
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

describe('product routes', () => {
  it('has the routes of the four families, in the order of the menu', () => {
    expect(FAMILY_ORDER).toHaveLength(4);
    for (const family of FAMILY_ORDER) {
      expect(route(`groups/:groupId/${FAMILIES[family].segment}`)).toBeDefined();
    }
  });

  describe.each(FAMILY_ORDER.map((family) => [family, FAMILIES[family]] as const))('%s', (family: ProductFamily, settings) => {
    const list = `groups/:groupId/${settings.segment}`;
    const create = `${list}/new`;
    const edit = `${list}/:productId`;
    const needed = settings.feature === null ? {} : { [settings.feature]: true };

    it('has a list, a new page and a detail page, titled, lazy and told which family they show', async () => {
      expect(route(list).title).toBe(`PRODUCTS.FAMILY.${settings.text}.TITLE`);
      expect(route(create).title).toBe(`PRODUCTS.FAMILY.${settings.text}.NEW_TITLE`);
      expect(route(edit).title).toBe(`PRODUCTS.FAMILY.${settings.text}.EDIT_TITLE`);
      for (const path of [list, create, edit]) {
        expect(route(path).data).toEqual({ family });
      }
      expect(await route(list).loadComponent?.()).toBe(ProductList);
      expect(await route(create).loadComponent?.()).toBe(ProductPage);
      expect(await route(edit).loadComponent?.()).toBe(ProductPage);
    });

    it('asks to confirm leaving the form, not the list', () => {
      expect(route(create).canDeactivate).toEqual([leaveProduct]);
      expect(route(edit).canDeactivate).toEqual([leaveProduct]);
      expect(route(list).canDeactivate).toBeUndefined();
    });

    it('reads with products:read and creates with products:update', async () => {
      expect(await matches(list, ['products:read'], needed)).toBe(true);
      expect(await matches(edit, ['products:read'], needed)).toBe(true);
      expect(await matches(create, ['products:update'], needed)).toBe(true);
      expect(await matches(list, ['places:read'], needed)).toBe(false);
      expect(await matches(edit, ['places:read'], needed)).toBe(false);
      expect(await matches(create, ['products:read'], needed)).toBe(false);
    });

    it(
      settings.feature === null ? 'needs no feature of the group' : `needs the ${settings.feature} feature of the group`,
      async () => {
        const all = [list, create, edit];
        const ask = (path: string, features: Record<string, boolean>) =>
          matches(path, ['products:read', 'products:update'], features);
        if (settings.feature === null) {
          for (const path of all) {
            expect(await ask(path, {})).toBe(true);
          }
        } else {
          for (const path of all) {
            expect(await ask(path, {})).toBe(false);
            expect(await ask(path, { cash: true })).toBe(false);
            expect(await ask(path, needed)).toBe(true);
          }
        }
      },
    );
  });
});
