import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { LANGUAGE_STORAGE_KEY } from './language';

const DICTIONARY = { COMMON: { RETRY: 'Riprova' }, GREETING: 'Ciao {name}' };

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { service: TestBed.inject(I18nService), backend: TestBed.inject(HttpTestingController) };
}

describe('I18nService', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.lang = '';
    vi.restoreAllMocks();
  });

  it('is not ready before a dictionary is loaded', () => {
    const { service } = setup();
    expect(service.ready()).toBe(false);
    expect(service.language()).toBeNull();
  });

  it('loads the dictionary, sets the language and the document lang', async () => {
    const { service, backend } = setup();
    const loading = service.use('it');
    backend.expectOne('/i18n/it.json').flush(DICTIONARY);
    await loading;
    expect(service.ready()).toBe(true);
    expect(service.language()).toBe('it');
    expect(document.documentElement.lang).toBe('it');
    expect(service.t('COMMON.RETRY')).toBe('Riprova');
    expect(service.t('GREETING', { name: 'Anna' })).toBe('Ciao Anna');
  });

  it('initializes from the saved preference', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'it');
    const { service, backend } = setup();
    const loading = service.initialize();
    backend.expectOne('/i18n/it.json').flush(DICTIONARY);
    await loading;
    expect(service.language()).toBe('it');
  });

  it('initializes from the browser languages without a saved preference', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US', 'it-IT']);
    const { service, backend } = setup();
    const loading = service.initialize();
    backend.expectOne('/i18n/it.json').flush(DICTIONARY);
    await loading;
    expect(service.language()).toBe('it');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('select() activates the language and saves the preference', async () => {
    const { service, backend } = setup();
    const selecting = service.select('it');
    backend.expectOne('/i18n/it.json').flush(DICTIONARY);
    await selecting;
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('it');
  });

  it('rejects when the dictionary cannot be fetched and stays not ready', async () => {
    const { service, backend } = setup();
    const loading = service.use('it');
    backend.expectOne('/i18n/it.json').flush('x', { status: 500, statusText: 'Error' });
    await expect(loading).rejects.toThrow();
    expect(service.ready()).toBe(false);
  });

  it('rejects an invalid dictionary', async () => {
    const { service, backend } = setup();
    const loading = service.use('it');
    backend.expectOne('/i18n/it.json').flush({ A: 1 });
    await expect(loading).rejects.toThrow(/Invalid dictionary/);
    expect(service.language()).toBeNull();
  });

  it('shows a visible marker for a missing key and warns once per key', () => {
    const { service } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(service.t('NOPE')).toBe('⟦NOPE⟧');
    expect(service.t('NOPE')).toBe('⟦NOPE⟧');
    expect(service.t('OTHER')).toBe('⟦OTHER⟧');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
