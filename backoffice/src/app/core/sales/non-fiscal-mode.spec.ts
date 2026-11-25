import { TestBed } from '@angular/core/testing';
import { NON_FISCAL_CLICKS, NON_FISCAL_KEY, NON_FISCAL_WINDOW_MS, NonFiscalMode } from './non-fiscal-mode';

function mode(): NonFiscalMode {
  TestBed.resetTestingModule();
  return TestBed.inject(NonFiscalMode);
}

function click(target: NonFiscalMode, times: number, from = 0, step = 100): void {
  for (let index = 0; index < times; index++) {
    target.brandClick(from + index * step);
  }
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('NonFiscalMode', () => {
  it('is off at the start', () => {
    expect(mode().nonFiscalVisible()).toBe(false);
  });

  it('turns on after seven clicks within three seconds and keeps only the flag in the tab', () => {
    const target = mode();
    click(target, NON_FISCAL_CLICKS - 1);
    expect(target.nonFiscalVisible()).toBe(false);
    target.brandClick(700);
    expect(target.nonFiscalVisible()).toBe(true);
    expect(sessionStorage.getItem(NON_FISCAL_KEY)).toBe('1');
    expect(localStorage.getItem(NON_FISCAL_KEY)).toBeNull();
  });

  it('does not count clicks that are further apart than the window', () => {
    const target = mode();
    click(target, NON_FISCAL_CLICKS, 0, NON_FISCAL_WINDOW_MS / 2);
    expect(target.nonFiscalVisible()).toBe(false);
  });

  it('counts the clicks of the window only, forgetting the older ones', () => {
    const target = mode();
    click(target, 3, 0);
    click(target, NON_FISCAL_CLICKS - 1, 10_000);
    expect(target.nonFiscalVisible()).toBe(false);
    target.brandClick(10_800);
    expect(target.nonFiscalVisible()).toBe(true);
  });

  it('turns off with one click while on, and the next seven clicks turn it on again', () => {
    const target = mode();
    click(target, NON_FISCAL_CLICKS);
    target.brandClick(1_000);
    expect(target.nonFiscalVisible()).toBe(false);
    expect(sessionStorage.getItem(NON_FISCAL_KEY)).toBeNull();
    click(target, NON_FISCAL_CLICKS, 5_000);
    expect(target.nonFiscalVisible()).toBe(true);
  });

  it('uses the clock when no time is given', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const target = mode();
    for (let index = 0; index < NON_FISCAL_CLICKS; index++) {
      target.brandClick();
    }
    expect(target.nonFiscalVisible()).toBe(true);
  });

  it('is restored from the tab and reset at sign-out', () => {
    sessionStorage.setItem(NON_FISCAL_KEY, '1');
    const target = mode();
    expect(target.nonFiscalVisible()).toBe(true);
    target.reset();
    expect(target.nonFiscalVisible()).toBe(false);
    expect(sessionStorage.getItem(NON_FISCAL_KEY)).toBeNull();
  });
});
