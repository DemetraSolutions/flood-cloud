import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createDebouncer, Debouncer } from './debouncer';

@Component({ selector: 'fc-host', template: '' })
class Host {
  readonly debouncer: Debouncer = createDebouncer(100);
}

describe('createDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs only the last action after the delay', () => {
    const { debouncer } = TestBed.createComponent(Host).componentInstance;
    const first = vi.fn();
    const last = vi.fn();
    debouncer.schedule(first);
    vi.advanceTimersByTime(50);
    debouncer.schedule(last);
    vi.advanceTimersByTime(99);
    expect(last).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledOnce();
  });

  it('can be cancelled, and is cancelled when the host is destroyed', () => {
    const fixture = TestBed.createComponent(Host);
    const action = vi.fn();
    fixture.componentInstance.debouncer.schedule(action);
    fixture.componentInstance.debouncer.cancel();
    vi.advanceTimersByTime(200);
    fixture.componentInstance.debouncer.schedule(action);
    fixture.destroy();
    vi.advanceTimersByTime(200);
    expect(action).not.toHaveBeenCalled();
  });

  it('uses the default search delay', () => {
    const fixture = TestBed.createComponent(Host);
    expect(createDebouncerDefault()).toBeGreaterThan(0);
    fixture.destroy();
  });
});

function createDebouncerDefault(): number {
  return TestBed.runInInjectionContext(() => {
    const action = vi.fn();
    const debouncer = createDebouncer();
    debouncer.schedule(action);
    vi.advanceTimersByTime(299);
    const early = action.mock.calls.length;
    vi.advanceTimersByTime(1);
    return action.mock.calls.length - early;
  });
}
