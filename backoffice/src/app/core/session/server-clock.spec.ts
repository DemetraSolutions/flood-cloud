import {
  HttpClient,
  HttpInterceptorFn,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API } from '../../../testing/api';
import { apiBaseUrlInterceptor } from '../api/api-base-url.interceptor';
import { AppConfig } from '../config/app-config';
import { throwError } from 'rxjs';
import { ServerClock } from './server-clock';
import { serverClockInterceptor } from './server-clock.interceptor';

describe('ServerClock', () => {
  afterEach(() => vi.useRealTimers());

  it('follows the local clock until it has seen a server date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T10:00:00.900Z'));
    expect(new ServerClock().nowSeconds()).toBe(Date.parse('2026-11-24T10:00:00Z') / 1000);
  });

  it('applies the offset to the local clock, as whole seconds', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const clock = new ServerClock();
    clock.observe('Tue, 24 Nov 2026 09:58:00 GMT');
    vi.setSystemTime(new Date('2026-11-24T10:00:05.500Z'));
    expect(clock.nowSeconds()).toBe(Date.parse('2026-11-24T09:58:05Z') / 1000);
  });

  it('ignores a missing or invalid date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const clock = new ServerClock();
    clock.observe(null);
    clock.observe('not a date');
    expect(clock.nowSeconds()).toBe(Date.parse('2026-11-24T10:00:00Z') / 1000);
  });
});

describe('serverClockInterceptor', () => {
  const date = (hhmmss: string) => `Tue, 24 Nov 2026 ${hhmmss} GMT`;

  function setup(...inner: HttpInterceptorFn[]) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([apiBaseUrlInterceptor, serverClockInterceptor, ...inner]),
        ),
        provideHttpClientTesting(),
        { provide: AppConfig, useValue: { apiBaseUrl: signal(API).asReadonly() } },
      ],
    });
    const clock = TestBed.inject(ServerClock);
    return {
      clock,
      observe: vi.spyOn(clock, 'observe'),
      http: TestBed.inject(HttpClient),
      backend: TestBed.inject(HttpTestingController),
    };
  }

  it('reads the Date of a successful API response', () => {
    const { http, backend, observe } = setup();
    http.get('/v1/things').subscribe();
    backend.expectOne(`${API}/v1/things`).flush({}, { headers: { Date: date('10:00:00') } });
    expect(observe).toHaveBeenCalledWith(date('10:00:00'));
  });

  it('reads the Date of an API error response', () => {
    const { http, backend, observe } = setup();
    http.get('/v1/things').subscribe({ error: () => undefined });
    backend
      .expectOne(`${API}/v1/things`)
      .flush({}, { status: 401, statusText: 'x', headers: { Date: date('10:00:01') } });
    expect(observe).toHaveBeenCalledWith(date('10:00:01'));
  });

  it('ignores events that are not responses', () => {
    const { http, backend, observe } = setup();
    http.get('/v1/things', { reportProgress: true, observe: 'events' }).subscribe();
    backend.expectOne(`${API}/v1/things`).event({ type: 1 /* Sent */ } as never);
    expect(observe).not.toHaveBeenCalled();
  });

  it('ignores a network failure (no headers) and failures that are not HTTP errors', () => {
    const { http, backend, observe } = setup();
    http.get('/v1/things').subscribe({ error: () => undefined });
    backend.expectOne(`${API}/v1/things`).error(new ProgressEvent('error'));
    expect(observe).toHaveBeenCalledWith(null);
    TestBed.resetTestingModule();
    const failing = setup(() => throwError(() => new Error('boom')));
    let error: unknown;
    failing.http.get('/v1/things').subscribe({ error: (e: unknown) => (error = e) });
    expect(error).toEqual(new Error('boom'));
    expect(failing.observe).not.toHaveBeenCalled();
  });

  it('leaves other requests alone', () => {
    const { http, backend, observe } = setup();
    http.get('/config.json').subscribe();
    backend.expectOne('/config.json').flush({}, { headers: { Date: date('10:00:00') } });
    expect(observe).not.toHaveBeenCalled();
  });
});
