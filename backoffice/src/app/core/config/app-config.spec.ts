import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AppConfig, parsePublicConfig } from './app-config';

describe('parsePublicConfig', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com/gw//', 'https://api.example.com/gw'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000'],
  ])('accepts %s', (input, expected) => {
    expect(parsePublicConfig({ apiBaseUrl: input, extra: 'ignored' })).toEqual({
      apiBaseUrl: expected,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a missing apiBaseUrl', {}],
    ['a non-string apiBaseUrl', { apiBaseUrl: 1 }],
    ['a relative URL', { apiBaseUrl: '/v1' }],
    ['http on a remote host', { apiBaseUrl: 'http://api.example.com' }],
    ['another protocol', { apiBaseUrl: 'ftp://localhost' }],
    ['credentials', { apiBaseUrl: 'https://user:pw@api.example.com' }],
    ['a username only', { apiBaseUrl: 'https://user@api.example.com' }],
    ['a query', { apiBaseUrl: 'https://api.example.com?a=1' }],
    ['an empty query', { apiBaseUrl: 'https://api.example.com/?' }],
    ['a fragment', { apiBaseUrl: 'https://api.example.com#x' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parsePublicConfig(raw)).toThrow(/Invalid public configuration/);
  });
});

describe('AppConfig', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('loads /config.json and exposes the API base URL', async () => {
    const config = TestBed.inject(AppConfig);
    expect(config.apiBaseUrl()).toBeNull();
    const loading = config.load();
    TestBed.inject(HttpTestingController)
      .expectOne('/config.json')
      .flush({ apiBaseUrl: 'https://api.example.com/' });
    await loading;
    expect(config.apiBaseUrl()).toBe('https://api.example.com');
  });

  it('rejects and stays unloaded when the content is invalid', async () => {
    const config = TestBed.inject(AppConfig);
    const loading = config.load();
    TestBed.inject(HttpTestingController).expectOne('/config.json').flush({ apiBaseUrl: 'nope' });
    await expect(loading).rejects.toThrow(/Invalid public configuration/);
    expect(config.apiBaseUrl()).toBeNull();
  });

  it('rejects when the file cannot be fetched', async () => {
    const config = TestBed.inject(AppConfig);
    const loading = config.load();
    TestBed.inject(HttpTestingController)
      .expectOne('/config.json')
      .flush('x', { status: 404, statusText: 'Not Found' });
    await expect(loading).rejects.toThrow();
  });
});
