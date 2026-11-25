import { TestBed } from '@angular/core/testing';
import { CanMatchFn, provideRouter, Route, UrlSegment, UrlTree } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { ContactGroupList } from '../contact-groups/contact-group-list';
import { leaveContactGroup } from '../contact-groups/contact-group-leave';
import { ContactGroupPage } from '../contact-groups/contact-group-page';
import { ContactList } from './contact-list';
import { leaveContact } from './contact-leave';
import { ContactPage } from './contact-page';

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

const CONTACT_LIST = 'groups/:groupId/contacts';
const CONTACT_NEW = `${CONTACT_LIST}/new`;
const CONTACT_EDIT = `${CONTACT_LIST}/:contactId`;
const GROUP_LIST = 'groups/:groupId/contact-groups';
const GROUP_NEW = `${GROUP_LIST}/new`;
const GROUP_EDIT = `${GROUP_LIST}/:contactGroupId`;

describe('contact routes', () => {
  it('has the six routes, titled', () => {
    expect(route(CONTACT_LIST).title).toBe('CONTACTS.TITLE');
    expect(route(CONTACT_NEW).title).toBe('CONTACTS.FORM.NEW_TITLE');
    expect(route(CONTACT_EDIT).title).toBe('CONTACTS.FORM.EDIT_TITLE');
    expect(route(GROUP_LIST).title).toBe('CONTACT_GROUPS.TITLE');
    expect(route(GROUP_NEW).title).toBe('CONTACT_GROUPS.FORM.NEW_TITLE');
    expect(route(GROUP_EDIT).title).toBe('CONTACT_GROUPS.FORM.EDIT_TITLE');
  });

  it('loads each page lazily', async () => {
    expect(await route(CONTACT_LIST).loadComponent?.()).toBe(ContactList);
    expect(await route(CONTACT_NEW).loadComponent?.()).toBe(ContactPage);
    expect(await route(CONTACT_EDIT).loadComponent?.()).toBe(ContactPage);
    expect(await route(GROUP_LIST).loadComponent?.()).toBe(ContactGroupList);
    expect(await route(GROUP_NEW).loadComponent?.()).toBe(ContactGroupPage);
    expect(await route(GROUP_EDIT).loadComponent?.()).toBe(ContactGroupPage);
  });

  it('asks to confirm leaving a form, not a list', () => {
    expect(route(CONTACT_NEW).canDeactivate).toEqual([leaveContact]);
    expect(route(CONTACT_EDIT).canDeactivate).toEqual([leaveContact]);
    expect(route(CONTACT_LIST).canDeactivate).toBeUndefined();
    expect(route(GROUP_NEW).canDeactivate).toEqual([leaveContactGroup]);
    expect(route(GROUP_EDIT).canDeactivate).toEqual([leaveContactGroup]);
    expect(route(GROUP_LIST).canDeactivate).toBeUndefined();
  });

  it.each([
    [CONTACT_LIST, CONTACT_NEW, CONTACT_EDIT],
    [GROUP_LIST, GROUP_NEW, GROUP_EDIT],
  ])('reads %s with contacts:read and creates with contacts:write', async (list, create, edit) => {
    expect(await matches(list, ['contacts:read'])).toBe(true);
    expect(await matches(edit, ['contacts:read'])).toBe(true);
    expect(await matches(create, ['contacts:write'])).toBe(true);
    expect(await matches(list, ['products:read'])).toBe(false);
    expect(await matches(edit, ['products:read'])).toBe(false);
    expect(await matches(create, ['contacts:read'])).toBe(false);
  });
});

describe('trash route of a group', () => {
  it('admits contacts:read alone, and refuses a user who reads none of the kinds', async () => {
    expect(await matches('groups/:groupId/trash', ['contacts:read'])).toBe(true);
    expect(await matches('groups/:groupId/trash', ['contacts:write'])).toBe(false);
  });
});
