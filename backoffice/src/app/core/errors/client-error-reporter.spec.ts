import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { ApiError } from '../api/api-error';
import { AppConfig } from '../config/app-config';
import { APP_VERSION } from './app-version';
import {
  ClientErrorReporter,
  DEDUPE_WINDOW_MS,
  MAX_MESSAGE_LENGTH,
  MAX_REPORTS_PER_PAGE_LOAD,
  MAX_STACK_LINES,
} from './client-error-reporter';

const URL = `${API}/v1/client-errors`;

function setup(authenticated = true) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter([
        { path: '', children: [{ path: 'groups/:groupId/users', children: [] }] },
        { path: '**', children: [] },
      ]),
    ],
  });
  if (authenticated) {
    signIn();
  }
  return TestBed.inject(ClientErrorReporter);
}

function sentBody() {
  const req = backend().expectOne(URL);
  expect(req.request.method).toBe('POST');
  req.flush(null, { status: 202, statusText: 'Accepted' });
  return req.request.body as Record<string, unknown>;
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ClientErrorReporter', () => {
  it('sends name, message, stack, route pattern, version and time of an error', async () => {
    const reporter = setup();
    await RouterTestingHarness.create('/groups/665f1c2e9b1d4a0012ab34a1/users?secret=1');
    reporter.report(new TypeError('boom'));
    const body = sentBody();
    expect(body['name']).toBe('TypeError');
    expect(body['message']).toBe('boom');
    expect(body['route']).toBe('/groups/:groupId/users');
    expect(body['appVersion']).toBe(APP_VERSION);
    expect(typeof body['stack']).toBe('string');
    expect(new Date(body['occurredAt'] as string).toISOString()).toBe(body['occurredAt']);
    expect(Object.keys(body).sort()).toEqual(
      ['appVersion', 'message', 'name', 'occurredAt', 'route', 'stack'].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('665f1c2e9b1d4a0012ab34a1');
  });

  it('truncates the message and the stack and reports the root route as /', () => {
    const reporter = setup();
    const error = new Error('x'.repeat(MAX_MESSAGE_LENGTH + 50));
    error.stack = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    reporter.report(error);
    const body = sentBody();
    expect((body['message'] as string).length).toBe(MAX_MESSAGE_LENGTH);
    expect((body['stack'] as string).split('\n')).toHaveLength(MAX_STACK_LINES);
    expect(body['route']).toBe('/');
  });

  it('cuts a very long stack line', () => {
    const reporter = setup();
    const error = new Error('long');
    error.stack = 'y'.repeat(9000);
    reporter.report(error);
    expect((sentBody()['stack'] as string).length).toBe(300);
  });

  it('describes values that are not errors, and errors without name or stack', () => {
    const reporter = setup();
    reporter.report('plain text');
    let body = sentBody();
    expect(body['name']).toBe('NonError');
    expect(body['message']).toBe('plain text');
    expect('stack' in body).toBe(false);
    const nameless = new Error('anon');
    nameless.name = '';
    nameless.stack = '';
    reporter.report(nameless);
    body = sentBody();
    expect(body['name']).toBe('Error');
    expect('stack' in body).toBe(false);
  });

  it('does not report when nobody is signed in', () => {
    const reporter = setup(false);
    reporter.report(new Error('boom'));
    backend().expectNone(URL);
  });

  it('does not report the errors of API calls', () => {
    const reporter = setup();
    reporter.report(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' }));
    reporter.report(new HttpErrorResponse({ status: 500 }));
    backend().expectNone(URL);
  });

  it('reports identical errors once a minute', () => {
    vi.useFakeTimers();
    const reporter = setup();
    const same = new Error('same');
    reporter.report(same);
    sentBody();
    reporter.report(same);
    backend().expectNone(URL);
    vi.advanceTimersByTime(DEDUPE_WINDOW_MS + 1);
    reporter.report(same);
    sentBody();
    reporter.report(new Error('other'));
    sentBody();
  });

  it('sends at most ten reports per page load', () => {
    const reporter = setup();
    for (let i = 0; i < MAX_REPORTS_PER_PAGE_LOAD + 3; i++) {
      reporter.report(new Error(`error ${i}`));
    }
    const requests = backend().match(URL);
    expect(requests).toHaveLength(MAX_REPORTS_PER_PAGE_LOAD);
    requests.forEach((r) => r.flush(null, { status: 202, statusText: 'Accepted' }));
  });

  it('only logs a report that fails, without reporting it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = setup();
    reporter.report(new Error('first'));
    backend()
      .expectOne(URL)
      .flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'Too Many Requests' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    reporter.report(new Error('second'));
    backend().expectOne(URL).error(new ProgressEvent('error'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenNthCalledWith(1, 'Error report not delivered', 'RATE_LIMITED');
    expect(warn).toHaveBeenNthCalledWith(2, 'Error report not delivered', 'NETWORK_ERROR');
    backend().expectNone(URL);
  });

  it('logs an unexpected failure of the send without details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        ...provideApiTesting(),
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
        provideRouter([]),
      ],
    });
    signIn();
    TestBed.inject(ClientErrorReporter).report(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith('Error report not delivered', 'unexpected');
  });

  it('replaces the first stack line with the truncated message and cuts every line', () => {
    const reporter = setup();
    const error = new TypeError('m'.repeat(1000));
    error.stack = `TypeError: ${'m'.repeat(1000)}\n    at ${'f'.repeat(1000)}\nOther: line`;
    reporter.report(error);
    const lines = (sentBody()['stack'] as string).split('\n');
    expect(lines[0]).toBe(`TypeError: ${'m'.repeat(300 - 'TypeError: '.length)}`);
    expect(MAX_MESSAGE_LENGTH).toBe(300);
    expect(lines[1]).toHaveLength(300);
    expect(lines[2]).toBe('Other: line');
  });

  it('replaces long quoted fragments in the message and the stack', () => {
    const reporter = setup();
    const secret = 'user typed this long text';
    const error = new SyntaxError(`Bad "${secret}" or '${secret}' but "short" stays`);
    error.stack = `SyntaxError: x\n    at parse (\`${secret}\`)\n    at "short"`;
    reporter.report(error);
    const body = sentBody();
    expect(body['message']).toBe(`Bad "…" or '…' but "short" stays`);
    expect(body['stack']).toBe(
      `SyntaxError: ${body['message']}\n    at parse (\`…\`)\n    at "short"`,
    );
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('never throws: values that cannot be converted or read are handled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = setup();
    expect(() => reporter.report(Object.create(null))).not.toThrow();
    const body = sentBody();
    expect(body['name']).toBe('NonError');
    expect(body['message']).toBe('');
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('getter');
      },
    });
    expect(() => reporter.report(hostile)).not.toThrow();
    backend().expectNone(URL);
    expect(warn).toHaveBeenCalledWith('Error report not built', 'Error');
  });

  it('describes a value whose toString throws as an empty message', () => {
    const reporter = setup();
    const thrower = {
      toString() {
        throw new Error('no text');
      },
    };
    expect(() => reporter.report(thrower)).not.toThrow();
    expect(sentBody()['message']).toBe('');
  });

  it('warns about an unexpected non-Error failure of the builder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = setup();
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'name', {
      get() {
        throw 'not an error';
      },
    });
    reporter.report(hostile);
    expect(warn).toHaveBeenCalledWith('Error report not built', 'unexpected');
  });
});
