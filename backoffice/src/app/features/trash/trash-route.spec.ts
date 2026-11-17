import { CanMatchFn, provideRouter, Route } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { TrashPage } from './trash-page';

describe('trash route', () => {
  function route() {
    const find = (list: readonly Route[]): Route | undefined => {
      for (const item of list) {
        if (item.path === 'groups/:groupId/trash') {
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

  it('is titled and loads the page', async () => {
    expect(route().title).toBe('TRASH.TITLE');
    expect(route().canMatch).toHaveLength(1);
    expect(await route().loadComponent?.()).toBe(TrashPage);
  });

  it.each([
    [['companies:read'], true],
    [['places:read'], true],
    [['users:read'], true],
    [['groups:trash', 'profile:read'], false],
  ])('matches with the read permission of any of the kinds (%j)', (permissions, allowed) => {
    TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
    signIn({ role: 'SA', permissions });
    const guard = (route().canMatch as CanMatchFn[])[0];
    expect(TestBed.runInInjectionContext(() => guard(route(), [], {} as never)) === true).toBe(
      allowed,
    );
  });
});
