import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { throwError } from 'rxjs';
import { AppConfig } from '../config/app-config';
import { apiBaseUrlInterceptor } from './api-base-url.interceptor';
import { ApiError } from './api-error';
import { apiErrorInterceptor } from './api-error.interceptor';

function setup(baseUrl: string | null) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiBaseUrlInterceptor, apiErrorInterceptor])),
      provideHttpClientTesting(),
      { provide: AppConfig, useValue: { apiBaseUrl: signal(baseUrl).asReadonly() } },
    ],
  });
  return { http: TestBed.inject(HttpClient), backend: TestBed.inject(HttpTestingController) };
}

describe('apiBaseUrlInterceptor', () => {
  it('prefixes /v1/ requests with the API base URL', () => {
    const { http, backend } = setup('https://api.example.com');
    http.get('/v1/products').subscribe();
    backend.expectOne('https://api.example.com/v1/products').flush({});
    backend.verify();
  });

  it('leaves other requests untouched', () => {
    const { http, backend } = setup('https://api.example.com');
    http.get('/i18n/it.json').subscribe();
    http.get('/v10/x').subscribe();
    http.get('https://other.example.com/v1/x').subscribe();
    backend.expectOne('/i18n/it.json').flush({});
    backend.expectOne('/v10/x').flush({});
    backend.expectOne('https://other.example.com/v1/x').flush({});
    backend.verify();
  });

  it('fails loudly when the configuration is not loaded', () => {
    const { http } = setup(null);
    let caught: unknown;
    http.get('/v1/products').subscribe({ error: (e: unknown) => (caught = e) });
    expect((caught as Error).message).toMatch(/not loaded/);
  });
});

describe('apiErrorInterceptor', () => {
  it('turns API failures into ApiError', () => {
    const { http, backend } = setup('https://api.example.com');
    let caught: unknown;
    http.get('/v1/products').subscribe({ error: (e: unknown) => (caught = e) });
    backend
      .expectOne('https://api.example.com/v1/products')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'No' } },
        { status: 403, statusText: 'Forbidden', headers: { 'X-Request-Id': 'r-9' } },
      );
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('FORBIDDEN');
    expect((caught as ApiError).requestId).toBe('r-9');
  });

  it('maps network failures to NETWORK_ERROR', () => {
    const { http, backend } = setup('https://api.example.com');
    let caught: unknown;
    http.get('/v1/products').subscribe({ error: (e: unknown) => (caught = e) });
    backend.expectOne('https://api.example.com/v1/products').error(new ProgressEvent('error'));
    expect((caught as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('does not touch failures of non-API requests', () => {
    const { http, backend } = setup('https://api.example.com');
    let caught: unknown;
    http.get('/config.json').subscribe({ error: (e: unknown) => (caught = e) });
    backend.expectOne('/config.json').flush('x', { status: 500, statusText: 'Error' });
    expect(caught).not.toBeInstanceOf(ApiError);
  });

  it('rethrows errors that are not HTTP failures as they are', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([
            apiBaseUrlInterceptor,
            apiErrorInterceptor,
            () => throwError(() => new Error('boom')),
          ]),
        ),
        { provide: AppConfig, useValue: { apiBaseUrl: signal('https://api.example.com') } },
      ],
    });
    let caught: unknown;
    TestBed.inject(HttpClient)
      .get('/v1/x')
      .subscribe({ error: (e: unknown) => (caught = e) });
    expect(caught).toEqual(new Error('boom'));
  });
});
