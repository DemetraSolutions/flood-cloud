import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route, UrlSegment, UrlTree } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { CategoryList } from './category-list';
import { leaveCategory } from './category-leave';
import { CategoryPage } from './category-page';

const GROUP = '665f1c2e9b1d4a0012ab34a2';
const LIST = 'groups/:groupId/product-categories';
const CREATE = `${LIST}/new`;
const EDIT = `${LIST}/:categoryId`;

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

async function matches(path: string, permissions: string[]): Promise<boolean> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  signIn({ role: 'SA', permissions, groupFeatures: fakeFeatureFlags(false, {}) });
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

describe('product category routes', () => {
  it('has a list, a new page and a detail page, titled and lazy', async () => {
    expect(route(LIST).title).toBe('PRODUCT_CATEGORIES.TITLE');
    expect(route(CREATE).title).toBe('PRODUCT_CATEGORIES.FORM.NEW_TITLE');
    expect(route(EDIT).title).toBe('PRODUCT_CATEGORIES.FORM.EDIT_TITLE');
    expect(await route(LIST).loadComponent?.()).toBe(CategoryList);
    expect(await route(CREATE).loadComponent?.()).toBe(CategoryPage);
    expect(await route(EDIT).loadComponent?.()).toBe(CategoryPage);
  });

  it('asks to confirm leaving the form, not the list', () => {
    expect(route(CREATE).canDeactivate).toEqual([leaveCategory]);
    expect(route(EDIT).canDeactivate).toEqual([leaveCategory]);
    expect(route(LIST).canDeactivate).toBeUndefined();
  });

  it('reads with products:read and creates with products:update', async () => {
    expect(await matches(LIST, ['products:read'])).toBe(true);
    expect(await matches(EDIT, ['products:read'])).toBe(true);
    expect(await matches(CREATE, ['products:update'])).toBe(true);
    expect(await matches(LIST, ['places:read'])).toBe(false);
    expect(await matches(EDIT, ['places:read'])).toBe(false);
    expect(await matches(CREATE, ['products:read'])).toBe(false);
  });
});
