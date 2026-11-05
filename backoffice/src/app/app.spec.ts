import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { signIn } from '../testing/session';
import { App } from './app';
import { StartupState } from './core/startup/startup-state';
import { routes } from './app.routes';

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
  });
}

describe('App', () => {
  it('renders the routed application when startup succeeded', async () => {
    setup();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('router-outlet')).not.toBeNull();
    expect(root.querySelector('fc-toast-region')).not.toBeNull();
    expect(root.querySelector('fc-startup-error')).toBeNull();
  });

  it('renders the startup error page instead of the application when startup failed', async () => {
    setup();
    TestBed.inject(StartupState).fail();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('fc-startup-error')).not.toBeNull();
    expect(root.querySelector('router-outlet')).toBeNull();
    expect(root.querySelector('fc-toast-region')).toBeNull();
  });
});

describe('routes', () => {
  async function open(url: string) {
    setup();
    const harness = await RouterTestingHarness.create();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await harness.navigateByUrl(url);
    return { harness, root: harness.routeNativeElement as HTMLElement };
  }

  const title = (root: HTMLElement) => root.querySelector('h1')?.textContent;
  const location = () => TestBed.inject(Router).url;

  it.each([
    ['/', 'HOME.TITLE'],
    ['/forbidden', 'ERRORS.FORBIDDEN.TITLE'],
    ['/error', 'ERRORS.GENERIC.TITLE'],
    ['/does/not/exist', 'ERRORS.NOT_FOUND.TITLE'],
    ['/profile', 'PROFILE.TITLE'],
    ['/profile/sessions', 'SESSIONS.TITLE'],
    ['/change-password', 'AUTH.CHANGE_PASSWORD.TITLE'],
  ])('lazy-loads %s inside the shell for a signed-in user', async (url, expected) => {
    setup();
    signIn();
    const harness = await RouterTestingHarness.create();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('main h1')?.textContent).toBe(`⟦${expected}⟧`);
    expect(root.querySelector('header')).not.toBeNull();
  });

  it('shows the login page, outside the shell, to an anonymous visitor', async () => {
    const { root } = await open('/login');
    expect(title(root)).toBe('⟦AUTH.LOGIN.TITLE⟧');
    expect(root.querySelector('header')).toBeNull();
  });

  it('sends an anonymous visitor to the login keeping the requested page', async () => {
    const { root } = await open('/profile/sessions?x=1');
    expect(location()).toBe('/login?returnUrl=%2Fprofile%2Fsessions%3Fx%3D1');
    expect(title(root)).toBe('⟦AUTH.LOGIN.TITLE⟧');
  });

  it('sends an anonymous visitor of the home page to a plain login', async () => {
    await open('/');
    expect(location()).toBe('/login');
  });

  it('keeps a signed-in user away from the login page', async () => {
    setup();
    signIn();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login');
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('lets only the change-password page through while a temporary password is pending', async () => {
    setup();
    signIn({ passwordChangeRequired: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = await RouterTestingHarness.create();
    for (const url of ['/', '/profile', '/does/not/exist']) {
      await harness.navigateByUrl(url);
      expect(TestBed.inject(Router).url).toBe('/change-password');
    }
    expect((harness.routeNativeElement as HTMLElement).querySelector('h1')?.textContent).toBe(
      '⟦AUTH.CHANGE_PASSWORD.TITLE⟧',
    );
  });

  it('protects the route, not only the menu entry, with the permission', async () => {
    setup();
    signIn({ permissions: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/profile/sessions');
    expect(TestBed.inject(Router).url).toBe('/forbidden');
  });
});
