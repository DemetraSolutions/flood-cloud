import { TestBed } from '@angular/core/testing';
import { CanMatchFn, Route, Router, UrlSegment, UrlTree } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signIn } from '../../../testing/session';
import {
  anonymousOnly,
  authenticated,
  groupLanding,
  passwordChangeAllowed,
  permission,
  role,
} from './guards';
import { GroupContext } from '../groups/group-context';

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
});
afterEach(() => vi.restoreAllMocks());

function run(guard: CanMatchFn, segments: UrlSegment[] = []) {
  return TestBed.runInInjectionContext(() => guard({} as Route, segments, {} as never)) as
    boolean | UrlTree;
}

function serialized(result: boolean | UrlTree): string {
  return TestBed.inject(Router).serializeUrl(result as UrlTree);
}

function navigatingTo(url: string) {
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'getCurrentNavigation').mockReturnValue({
    extractedUrl: router.parseUrl(url),
  } as ReturnType<Router['getCurrentNavigation']>);
}

describe('authenticated', () => {
  it('lets a signed-in user through', () => {
    signIn();
    expect(run(authenticated)).toBe(true);
  });

  it('lets a user with a pending password change through (the next guard handles it)', () => {
    signIn({ passwordChangeRequired: true });
    expect(run(authenticated)).toBe(true);
  });

  it('sends an anonymous visitor to the login with the page being opened', () => {
    navigatingTo('/profile/sessions?x=1');
    expect(serialized(run(authenticated))).toBe('/login?returnUrl=%2Fprofile%2Fsessions%3Fx%3D1');
  });

  it('falls back to the matched segments outside a navigation', () => {
    const result = run(authenticated, [new UrlSegment('users', {}), new UrlSegment('42', {})]);
    expect(serialized(result)).toBe('/login?returnUrl=%2Fusers%2F42');
  });

  it.each(['/', '/login', '/login?returnUrl=%2Fx'])('sends %s to a plain login', (url) => {
    navigatingTo(url);
    expect(serialized(run(authenticated))).toBe('/login');
  });
});

describe('anonymousOnly', () => {
  it('lets an anonymous visitor see the login', () => {
    expect(run(anonymousOnly)).toBe(true);
  });

  it('sends a signed-in user to the home page', () => {
    signIn();
    expect(serialized(run(anonymousOnly))).toBe('/');
  });
});

describe('passwordChangeAllowed', () => {
  it('lets everyone through unless a password change is pending', () => {
    expect(run(passwordChangeAllowed)).toBe(true);
    signIn();
    expect(run(passwordChangeAllowed)).toBe(true);
  });

  it('sends a user with a temporary password to the change-password page', () => {
    signIn({ passwordChangeRequired: true });
    expect(serialized(run(passwordChangeAllowed))).toBe('/change-password');
  });
});

describe('permission', () => {
  it('lets a user with the permission through', () => {
    signIn({ permissions: ['users:read'] });
    expect(run(permission('users:read'))).toBe(true);
  });

  it('sends a user without the permission to /forbidden', () => {
    signIn({ permissions: ['profile:read'] });
    expect(serialized(run(permission('users:read')))).toBe('/forbidden');
  });

  it('sends an anonymous visitor to /forbidden', () => {
    expect(serialized(run(permission('users:read')))).toBe('/forbidden');
  });
});

describe('role', () => {
  it('lets one of the allowed roles through', () => {
    signIn({ role: 'PSA' });
    expect(run(role('PSA', 'D'))).toBe(true);
  });

  it('sends other roles, and anonymous visitors, to /forbidden', () => {
    expect(serialized(run(role('PSA')))).toBe('/forbidden');
    signIn({ role: 'SA' });
    expect(serialized(run(role('PSA')))).toBe('/forbidden');
  });
});

describe('groupLanding', () => {
  it('redirects to the users of the working group', () => {
    signIn({ role: 'SA' });
    expect(serialized(run(groupLanding))).toBe('/groups/665f1c2e9b1d4a0012ab34a1/users');
  });

  it('stays on the page when a PSA has not chosen a group', () => {
    sessionStorage.clear();
    signIn({ role: 'PSA' });
    expect(run(groupLanding)).toBe(true);
  });

  it('uses the group chosen with the selector', () => {
    signIn({ role: 'D' });
    TestBed.inject(GroupContext).choose({ id: '665f1c2e9b1d4a0012ab34a2', name: 'Alfa' });
    expect(serialized(run(groupLanding))).toBe('/groups/665f1c2e9b1d4a0012ab34a2/users');
    sessionStorage.clear();
  });
});
