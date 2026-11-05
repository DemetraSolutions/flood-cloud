import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signIn } from '../../../testing/session';
import { SessionService } from '../session/session.service';
import { GroupContext, LAST_GROUP_ID_KEY, LAST_GROUP_NAME_KEY } from './group-context';

const ID = '665f1c2e9b1d4a0012ab34a2';

function create(): GroupContext {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'login', children: [] }]),
    ],
  });
  return TestBed.inject(GroupContext);
}

describe('GroupContext', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('has no group before the sign-in', () => {
    const context = create();
    expect(context.canChoose()).toBe(false);
    expect(context.groupId()).toBeNull();
    expect(context.groupName()).toBe('');
  });

  it.each(['SA', 'CA', 'PA'] as const)('uses the group of the profile for %s', (role) => {
    const context = create();
    signIn({ role });
    expect(context.canChoose()).toBe(false);
    expect(context.groupId()).toBe('665f1c2e9b1d4a0012ab34a1');
    expect(context.groupName()).toBe('Gruppo Esempio');
  });

  it('has an empty name when the profile has no group', () => {
    const context = create();
    signIn({ role: 'SA', group: null });
    expect(context.groupName()).toBe('');
  });

  it.each(['PSA', 'D'] as const)('lets %s choose and remembers the choice', (role) => {
    const context = create();
    signIn({ role, groupId: null, group: null });
    expect(context.canChoose()).toBe(true);
    expect(context.groupId()).toBeNull();
    expect(context.groupName()).toBe('');
    context.choose({ id: ID, name: 'Alfa' });
    expect(context.groupId()).toBe(ID);
    expect(context.groupName()).toBe('Alfa');
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBe(ID);
    expect(sessionStorage.getItem(LAST_GROUP_NAME_KEY)).toBe('Alfa');
  });

  it('restores the preference of the tab at sign-in, with an empty name if missing', () => {
    sessionStorage.setItem(LAST_GROUP_ID_KEY, ID);
    const context = create();
    signIn({ role: 'PSA' });
    expect(context.groupId()).toBe(ID);
    expect(context.groupName()).toBe('');
  });

  it('ignores a stored value that is not an id', () => {
    sessionStorage.setItem(LAST_GROUP_ID_KEY, 'not-an-id');
    const context = create();
    signIn({ role: 'PSA' });
    expect(context.groupId()).toBeNull();
  });

  it('forgets the preference when the session ends', async () => {
    const context = create();
    signIn({ role: 'PSA' });
    context.choose({ id: ID, name: 'Alfa' });
    TestBed.tick();
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBe(ID);
    TestBed.inject(SessionService).expire();
    TestBed.tick();
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBeNull();
    expect(sessionStorage.getItem(LAST_GROUP_NAME_KEY)).toBeNull();
    expect(context.groupId()).toBeNull();
  });

  it('adopts the group of the URL for a PSA, keeping the name of a group already chosen', () => {
    const context = create();
    signIn({ role: 'PSA', groupId: null, group: null });
    context.adopt(ID);
    expect(context.groupId()).toBe(ID);
    expect(context.groupName()).toBe('');
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBe(ID);
    context.choose({ id: ID, name: 'Alfa' });
    context.adopt(ID);
    expect(context.groupName()).toBe('Alfa');
  });

  it('does not adopt anything for a user bound to a group', () => {
    const context = create();
    signIn({ role: 'SA' });
    context.adopt(ID);
    expect(context.groupId()).toBe('665f1c2e9b1d4a0012ab34a1');
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBeNull();
  });

  it('ignores a group id that is not an object id, whether chosen or adopted', () => {
    const context = create();
    signIn({ role: 'PSA', groupId: null, group: null });
    context.choose({ id: '../../x', name: 'Bad' });
    context.adopt('not-an-id');
    expect(context.groupId()).toBeNull();
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBeNull();
  });
});
