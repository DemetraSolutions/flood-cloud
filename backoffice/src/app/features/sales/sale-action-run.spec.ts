import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { ApiErrorCode, ClientErrorCode } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { FieldOf, NO_FIELDS, SaleActionRun, saleFailure } from './sale-action-run';

function i18n(): I18nService {
  const service = TestBed.inject(I18nService);
  vi.spyOn(service, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  return service;
}

function apiError(
  status: number,
  code: ApiErrorCode | ClientErrorCode,
  extra: { details?: { field: string; issue: string }[]; retryAfterSeconds?: number } = {},
): ApiError {
  return new ApiError({ status, code, message: code, ...extra });
}

const NONE: FieldOf = () => undefined;
const IDENTITY: FieldOf = (field) => field;

describe('saleFailure', () => {
  it.each([
    [0, 'NETWORK_ERROR'],
    [500, 'INTERNAL_ERROR'],
    [502, 'PROVIDER_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const)(
    'reads the status %s as an outcome that is not known, so the sale is read again',
    (status, code) => {
      expect(saleFailure(i18n(), apiError(status, code), false, NONE)).toEqual({
        message: 'SALES.ACTION.UNCERTAIN',
        fields: {},
        reread: true,
        uncertain: true,
      });
    },
  );

  it('reads a 412 as a sale that changed: read again, but not uncertain', () => {
    expect(saleFailure(i18n(), apiError(412, 'PRECONDITION_FAILED'), true, NONE)).toEqual({
      message: 'SALES.ACTION.STALE',
      fields: {},
      reread: true,
      uncertain: false,
    });
  });

  it('says the loyalty permission is missing on a 403 of a write that moves credit', () => {
    expect(saleFailure(i18n(), apiError(403, 'FORBIDDEN'), true, NONE)).toEqual({
      message: 'SALES.ACTION.FIDELITY_REQUIRED',
      fields: {},
      reread: false,
      uncertain: false,
    });
  });

  it('uses the central message for a 403 when the loyalty permission is not what is missing', () => {
    expect(saleFailure(i18n(), apiError(403, 'FORBIDDEN'), false, NONE)).toEqual({
      message: 'ERRORS.API.FORBIDDEN',
      fields: {},
      reread: false,
      uncertain: false,
    });
  });

  it('uses the text of the first detail of a 409 it knows, and the generic one otherwise', () => {
    expect(
      saleFailure(
        i18n(),
        apiError(409, 'CONFLICT', { details: [{ field: 'products.0', issue: 'refundExceeds' }] }),
        false,
        NONE,
      ),
    ).toEqual({
      message: 'SALES.ACTION.CONFLICT.REFUND_EXCEEDS',
      fields: {},
      reread: true,
      uncertain: false,
    });
    expect(
      saleFailure(
        i18n(),
        apiError(409, 'CONFLICT', { details: [{ field: 'x', issue: 'y' }] }),
        false,
        NONE,
      ).message,
    ).toBe('SALES.ACTION.CONFLICT.GENERIC');
    expect(saleFailure(i18n(), apiError(409, 'CONFLICT'), false, NONE).message).toBe(
      'SALES.ACTION.CONFLICT.GENERIC',
    );
  });

  it('gives the issue of every field of the form a 422 names, with the central message and no new read', () => {
    const failure = saleFailure(
      i18n(),
      apiError(422, 'VALIDATION_ERROR', {
        details: [
          { field: 'payments.cash', issue: 'type' },
          { field: 'payments.cash', issue: 'maximum' },
          { field: 'lotteryCode', issue: 'maxLength' },
        ],
      }),
      false,
      (field) => (field === 'payments.cash' ? 'cash' : field),
    );
    expect(failure).toEqual({
      message: 'ERRORS.API.VALIDATION_ERROR',
      fields: { cash: 'type', lotteryCode: 'maxLength' },
      reread: false,
      uncertain: false,
    });
  });

  it('keeps the first issue when two fields of the request belong to the same field of the form', () => {
    const failure = saleFailure(
      i18n(),
      apiError(422, 'VALIDATION_ERROR', {
        details: [
          { field: 'a', issue: 'type' },
          { field: 'b', issue: 'maximum' },
        ],
      }),
      false,
      () => 'same',
    );
    expect(failure.fields).toEqual({ same: 'type' });
    expect(failure.message).toBe('ERRORS.API.VALIDATION_ERROR');
  });

  it('says it in the message when a detail of a 422 belongs to no field of the form', () => {
    const failure = saleFailure(
      i18n(),
      apiError(422, 'VALIDATION_ERROR', {
        details: [
          { field: 'cash', issue: 'type' },
          { field: 'unknown', issue: 'required' },
        ],
      }),
      false,
      (field) => (field === 'cash' ? 'cash' : undefined),
    );
    expect(failure.message).toBe('SALES.ACTION.INVALID_UNMAPPED');
    expect(failure.fields).toEqual({ cash: 'type' });
    expect(failure.reread).toBe(false);
  });

  it('says it in the message when a 422 has no details at all', () => {
    expect(saleFailure(i18n(), apiError(422, 'VALIDATION_ERROR'), false, IDENTITY)).toEqual({
      message: 'SALES.ACTION.INVALID_UNMAPPED',
      fields: {},
      reread: false,
      uncertain: false,
    });
  });

  it('uses the central message for the other errors, with the wait of a 429', () => {
    expect(saleFailure(i18n(), apiError(404, 'NOT_FOUND'), false, NONE)).toEqual({
      message: 'ERRORS.API.NOT_FOUND',
      fields: {},
      reread: false,
      uncertain: false,
    });
    const limited = saleFailure(
      i18n(),
      apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }),
      false,
      NONE,
    );
    expect(limited.message).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    expect(limited.message).toContain('30');
    expect(limited.reread).toBe(false);
    expect(limited.uncertain).toBe(false);
  });

  it('logs an error that is not an API error and reports it generically', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');
    expect(saleFailure(i18n(), error, false, NONE)).toEqual({
      message: 'ERRORS.GENERIC.MESSAGE',
      fields: {},
      reread: false,
      uncertain: false,
    });
    expect(log).toHaveBeenCalledWith(error);
  });

  it('has a fieldOf for requests without fields that maps nothing', () => {
    expect(NO_FIELDS('anything')).toBeUndefined();
  });
});

describe('SaleActionRun', () => {
  function create() {
    TestBed.configureTestingModule({});
    i18n();
    const refreshing = signal(false);
    const reread = vi.fn();
    const run = TestBed.runInInjectionContext(() => new SaleActionRun(refreshing, reread));
    const tick = () => TestBed.tick();
    return { refreshing, reread, run, tick };
  }

  afterEach(() => vi.restoreAllMocks());

  it('does the write, is busy meanwhile and returns true', async () => {
    const { run } = create();
    let finish: () => void = () => undefined;
    const pending = run.run(() => new Promise<void>((resolve) => (finish = resolve)), false, NONE);
    expect(run.busy()).toBe(true);
    expect(run.blocked()).toBe(true);
    finish();
    expect(await pending).toBe(true);
    expect(run.busy()).toBe(false);
    expect(run.blocked()).toBe(false);
    expect(run.failure()).toBeNull();
  });

  it('clears the failure and the fields of the last try when it starts again', async () => {
    const { run } = create();
    await run.run(
      () =>
        Promise.reject(
          apiError(422, 'VALIDATION_ERROR', { details: [{ field: 'a', issue: 'type' }] }),
        ),
      false,
      IDENTITY,
    );
    expect(run.fields()).toEqual({ a: 'type' });
    expect(run.failure()).toBe('ERRORS.API.VALIDATION_ERROR');
    await run.run(() => Promise.resolve(), false, NONE);
    expect(run.fields()).toEqual({});
    expect(run.failure()).toBeNull();
  });

  it('keeps the dialog open to a failure that does not need a new read', async () => {
    const { run, reread } = create();
    expect(await run.run(() => Promise.reject(apiError(403, 'FORBIDDEN')), true, NONE)).toBe(false);
    expect(run.failure()).toBe('SALES.ACTION.FIDELITY_REQUIRED');
    expect(run.busy()).toBe(false);
    expect(run.blocked()).toBe(false);
    expect(reread).not.toHaveBeenCalled();
  });

  it('asks for a new read after an uncertain outcome and blocks until the read starts and ends', async () => {
    const { run, reread, refreshing, tick } = create();
    tick();
    expect(await run.run(() => Promise.reject(apiError(0, 'NETWORK_ERROR')), false, NONE)).toBe(
      false,
    );
    expect(run.failure()).toBe('SALES.ACTION.UNCERTAIN');
    expect(reread).toHaveBeenCalledOnce();
    expect(run.busy()).toBe(false);
    expect(run.blocked()).toBe(true);
    tick();
    // The page is not reading yet: still blocked.
    expect(run.blocked()).toBe(true);
    refreshing.set(true);
    tick();
    expect(run.blocked()).toBe(true);
    refreshing.set(false);
    tick();
    expect(run.blocked()).toBe(false);
  });

  it('waits for the read that was already running at the failure to end', async () => {
    const { run, refreshing, tick } = create();
    refreshing.set(true);
    tick();
    await run.run(() => Promise.reject(apiError(500, 'INTERNAL_ERROR')), false, NONE);
    expect(run.blocked()).toBe(true);
    refreshing.set(false);
    tick();
    expect(run.blocked()).toBe(false);
  });

  it('ignores the changes of the read while it is not waiting', () => {
    const { run, refreshing, tick } = create();
    refreshing.set(true);
    tick();
    refreshing.set(false);
    tick();
    expect(run.blocked()).toBe(false);
  });

  it('starts every opening of the dialog clean', async () => {
    const { run, refreshing, tick } = create();
    await run.run(() => Promise.reject(apiError(412, 'PRECONDITION_FAILED')), false, NONE);
    refreshing.set(true);
    tick();
    run.reset();
    expect(run.failure()).toBeNull();
    expect(run.fields()).toEqual({});
    expect(run.busy()).toBe(false);
    expect(run.blocked()).toBe(false);
    // The read that was going on is not taken for the one of the new opening.
    refreshing.set(false);
    tick();
    expect(run.blocked()).toBe(false);
  });

  it('flags an outcome that may have been applied as uncertain, and clears it when it sends again', async () => {
    const { run, refreshing, tick } = create();
    expect(run.uncertain()).toBe(false);
    await run.run(() => Promise.reject(apiError(0, 'NETWORK_ERROR')), false, NONE);
    expect(run.uncertain()).toBe(true);
    refreshing.set(true);
    tick();
    refreshing.set(false);
    tick();
    await run.run(() => Promise.reject(apiError(404, 'NOT_FOUND')), false, NONE);
    expect(run.uncertain()).toBe(false);
    await run.run(() => Promise.reject(apiError(500, 'INTERNAL_ERROR')), false, NONE);
    expect(run.uncertain()).toBe(true);
    await run.run(() => Promise.resolve(), false, NONE);
    expect(run.uncertain()).toBe(false);
  });

  it('does not flag a 412 as uncertain although it reads the sale again', async () => {
    const { run, reread } = create();
    await run.run(() => Promise.reject(apiError(412, 'PRECONDITION_FAILED')), false, NONE);
    expect(run.uncertain()).toBe(false);
    expect(reread).toHaveBeenCalledOnce();
  });

  it('clears the uncertain outcome when the dialog is opened again', async () => {
    const { run } = create();
    await run.run(() => Promise.reject(apiError(503, 'SERVICE_UNAVAILABLE')), false, NONE);
    expect(run.uncertain()).toBe(true);
    run.reset();
    expect(run.uncertain()).toBe(false);
  });

  it('says it is reading the sale again only while it waits for the read', async () => {
    const { run, refreshing, tick } = create();
    expect(run.rereading()).toBe(false);
    await run.run(() => Promise.reject(apiError(0, 'NETWORK_ERROR')), false, NONE);
    expect(run.rereading()).toBe(true);
    refreshing.set(true);
    tick();
    expect(run.rereading()).toBe(true);
    refreshing.set(false);
    tick();
    expect(run.rereading()).toBe(false);
  });

  it('does not say it is reading again for a request in progress or a failure that needs no read', async () => {
    const { run } = create();
    let finish: () => void = () => undefined;
    const pending = run.run(() => new Promise<void>((resolve) => (finish = resolve)), false, NONE);
    expect(run.busy()).toBe(true);
    expect(run.rereading()).toBe(false);
    finish();
    await pending;
    await run.run(() => Promise.reject(apiError(404, 'NOT_FOUND')), false, NONE);
    expect(run.rereading()).toBe(false);
  });

  it('shows the fields of the form of a refused write and the message of unmapped ones', async () => {
    const { run } = create();
    await run.run(
      () =>
        Promise.reject(
          apiError(422, 'VALIDATION_ERROR', { details: [{ field: 'x', issue: 'type' }] }),
        ),
      false,
      NONE,
    );
    expect(run.fields()).toEqual({});
    expect(run.failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
  });
});
