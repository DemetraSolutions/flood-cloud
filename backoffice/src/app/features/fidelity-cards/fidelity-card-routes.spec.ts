import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route, Router, UrlSegment, UrlTree } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { FidelityCardList } from './fidelity-card-list';
import { leaveFidelityCard } from './fidelity-card-leave';
import { FidelityCardPage } from './fidelity-card-page';

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

const LIST = 'groups/:groupId/fidelity/cards';
const NEW = `${LIST}/new`;
const EDIT = `${LIST}/:cardId`;

describe('fidelity card routes', () => {
  it('has the three routes, titled', () => {
    expect(route(LIST).title).toBe('FIDELITY_CARDS.TITLE');
    expect(route(NEW).title).toBe('FIDELITY_CARDS.FORM.NEW_TITLE');
    expect(route(EDIT).title).toBe('FIDELITY_CARDS.FORM.EDIT_TITLE');
  });

  it('loads each page lazily', async () => {
    expect(await route(LIST).loadComponent?.()).toBe(FidelityCardList);
    expect(await route(NEW).loadComponent?.()).toBe(FidelityCardPage);
    expect(await route(EDIT).loadComponent?.()).toBe(FidelityCardPage);
  });

  it('asks to confirm leaving a form, not the list', () => {
    expect(route(NEW).canDeactivate).toEqual([leaveFidelityCard]);
    expect(route(EDIT).canDeactivate).toEqual([leaveFidelityCard]);
    expect(route(LIST).canDeactivate).toBeUndefined();
  });

  it('reads with fidelity:read and creates with fidelity:update', async () => {
    expect(await matches(LIST, ['fidelity:read'])).toBe(true);
    expect(await matches(EDIT, ['fidelity:read'])).toBe(true);
    expect(await matches(NEW, ['fidelity:update'])).toBe(true);
    expect(await matches(LIST, ['products:read'])).toBe(false);
    expect(await matches(EDIT, ['products:read'])).toBe(false);
    expect(await matches(NEW, ['fidelity:read'])).toBe(false);
  });

  it('sends who can read but not update to /forbidden from the page of a new card, not to a card called new', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
    signIn({ role: 'SA', permissions: ['fidelity:read'] });
    const found = route(NEW);
    const segments = NEW.replace(':groupId', GROUP)
      .split('/')
      .map((part) => new UrlSegment(part, {}));
    const result = await TestBed.runInInjectionContext(() =>
      (found.canMatch as CanMatchFn[])[0](found, segments, {} as never),
    );
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/forbidden');
  });
});
