import { DOCUMENT } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AppConfig } from '../config/app-config';
import { I18nService } from '../i18n/i18n.service';
import { PageReloader } from './page-reloader';
import { initializeApp } from './app-initializer';
import { STARTUP_ERROR_FALLBACK, StartupError } from './startup-error';
import { StartupState } from './startup-state';

const DICTIONARY = {
  COMMON: { RETRY: 'Riprova!' },
  STARTUP: { ERROR: { TITLE: 'Titolo', MESSAGE: 'Messaggio' } },
};

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
});

afterEach(() => vi.restoreAllMocks());

describe('StartupState', () => {
  it('starts not failed and can be failed', () => {
    const state = TestBed.inject(StartupState);
    expect(state.failed()).toBe(false);
    state.fail();
    expect(state.failed()).toBe(true);
  });
});

describe('initializeApp', () => {
  async function run(
    dictionary: { status: number; body: object | string },
    config: { status: number; body: object | string },
  ) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const done = TestBed.runInInjectionContext(() => initializeApp());
    const backend = TestBed.inject(HttpTestingController);
    backend
      .expectOne('/i18n/it.json')
      .flush(dictionary.body, { status: dictionary.status, statusText: 'x' });
    backend
      .expectOne('/config.json')
      .flush(config.body, { status: config.status, statusText: 'x' });
    await done;
    return TestBed.inject(StartupState);
  }

  it('succeeds when dictionary and configuration load', async () => {
    const state = await run(
      { status: 200, body: DICTIONARY },
      { status: 200, body: { apiBaseUrl: 'https://api.example.com' } },
    );
    expect(state.failed()).toBe(false);
    expect(TestBed.inject(AppConfig).apiBaseUrl()).toBe('https://api.example.com');
    expect(TestBed.inject(I18nService).ready()).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('fails startup and logs when the dictionary fails', async () => {
    const state = await run(
      { status: 500, body: 'x' },
      { status: 200, body: { apiBaseUrl: 'https://api.example.com' } },
    );
    expect(state.failed()).toBe(true);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('fails startup and logs when the configuration is invalid', async () => {
    const state = await run({ status: 200, body: DICTIONARY }, { status: 200, body: {} });
    expect(state.failed()).toBe(true);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('logs both failures', async () => {
    const state = await run({ status: 500, body: 'x' }, { status: 404, body: 'x' });
    expect(state.failed()).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

describe('StartupError', () => {
  it('shows the hard-wired fallback texts when the dictionary is not loaded', async () => {
    const fixture = TestBed.createComponent(StartupError);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe(STARTUP_ERROR_FALLBACK.title);
    expect(root.querySelector('p')?.textContent).toBe(STARTUP_ERROR_FALLBACK.message);
    expect(root.querySelector('button')?.textContent).toBe(STARTUP_ERROR_FALLBACK.retry);
    expect(root.querySelector('main')?.getAttribute('role')).toBe('alert');
  });

  it('shows dictionary texts when the dictionary is loaded', async () => {
    const loading = TestBed.inject(I18nService).use('it');
    TestBed.inject(HttpTestingController).expectOne('/i18n/it.json').flush(DICTIONARY);
    await loading;
    const fixture = TestBed.createComponent(StartupError);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe('Titolo');
    expect(root.querySelector('p')?.textContent).toBe('Messaggio');
    expect(root.querySelector('button')?.textContent).toBe('Riprova!');
  });

  it('reloads the page on retry', async () => {
    const reload = vi.fn();
    TestBed.overrideProvider(PageReloader, { useValue: { reload } });
    const fixture = TestBed.createComponent(StartupError);
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector('button')?.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('PageReloader', () => {
  it('asks the document location to reload', () => {
    const reload = vi.fn();
    TestBed.overrideProvider(DOCUMENT, { useValue: { location: { reload } } });
    TestBed.inject(PageReloader).reload();
    expect(reload).toHaveBeenCalledOnce();
  });
});
