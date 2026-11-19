import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { PriceListPage } from '../price-list/price-list-page';
import { ActivationsPage } from './activations-page';
import { StatementPage } from './statement-page';

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

function matches(path: string, role: 'PSA' | 'D' | 'SA', permissions: string[]): boolean {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  signIn({ role, permissions });
  const found = route(path);
  return (found.canMatch as CanMatchFn[]).every(
    (guard) => TestBed.runInInjectionContext(() => guard(found, [], {} as never)) === true,
  );
}

describe('activations routes', () => {
  it.each([
    ['activations', 'ACTIVATIONS.TITLE', ActivationsPage],
    ['activations/:dealerId', 'ACTIVATIONS.STATEMENT.PAGE_TITLE', StatementPage],
    ['settings/price-list', 'PRICE_LIST.TITLE', PriceListPage],
  ])('%s is titled and lazy', async (path, title, component) => {
    const found = route(path);
    expect(found.title).toBe(title);
    expect(await found.loadComponent?.()).toBe(component);
  });

  it.each([
    ['tools/activations', 'activations'],
    ['tools/activations/:dealerId', 'activations/:dealerId'],
    ['tools/price-list', 'settings/price-list'],
  ])('the old address %s redirects to %s keeping the query', (from, to) => {
    const found = route(from);
    expect(found.redirectTo).toBe(to);
    expect(found.pathMatch).toBe('full');
  });

  it.each(['activations', 'activations/:dealerId'])(
    '%s is for who holds activations:read',
    (path) => {
      expect(matches(path, 'D', ['activations:read'])).toBe(true);
    },
  );

  it.each(['activations', 'activations/:dealerId'])(
    '%s does not match without activations:read',
    (path) => {
      expect(matches(path, 'PSA', ['places:read'])).toBe(false);
    },
  );

  it('the price list is for platform administrators with activations:manage', () => {
    expect(matches('settings/price-list', 'PSA', ['activations:manage'])).toBe(true);
    expect(matches('settings/price-list', 'PSA', ['activations:read'])).toBe(false);
    expect(matches('settings/price-list', 'D', ['activations:manage'])).toBe(false);
  });
});
