import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
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
  it.each([
    ['/', 'HOME.TITLE'],
    ['/forbidden', 'ERRORS.FORBIDDEN.TITLE'],
    ['/error', 'ERRORS.GENERIC.TITLE'],
    ['/does/not/exist', 'ERRORS.NOT_FOUND.TITLE'],
  ])('lazy-loads %s inside the shell', async (url, title) => {
    setup();
    const harness = await RouterTestingHarness.create();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('main h1')?.textContent).toBe(`⟦${title}⟧`);
    expect(root.querySelector('header')).not.toBeNull();
  });
});
