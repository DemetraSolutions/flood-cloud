import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route, UrlSegment, UrlTree } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { SalePage } from './sale-page';

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

async function matches(path: string, permissions: string[]): Promise<boolean> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  signIn({ role: 'SA', permissions });
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

const SALE = 'groups/:groupId/sales/:saleId';

describe('sale route', () => {
  it('has a fixed title and loads the page lazily', async () => {
    expect(route(SALE).title).toBe('SALES.PAGE_TITLE');
    expect(await route(SALE).loadComponent?.()).toBe(SalePage);
    expect(route(SALE).canDeactivate).toBeUndefined();
  });

  it('is for whoever reads the sales', async () => {
    expect(await matches(SALE, ['sales:read'])).toBe(true);
    expect(await matches(SALE, ['contacts:read'])).toBe(false);
  });
});
