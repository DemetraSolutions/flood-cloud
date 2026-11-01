import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ToastRegion } from './toast-region';
import { TOAST_DEFAULT_DURATION, TOAST_MAX, ToastService } from './toast.service';

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
  const service = TestBed.inject(ToastService);
  const fixture = TestBed.createComponent(ToastRegion);
  const root = fixture.nativeElement as HTMLElement;
  const settle = async () => fixture.detectChanges();
  const items = () => root.querySelectorAll('fc-toast');
  return { service, root, settle, items };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToastService', () => {
  it('queues notifications, keeps at most TOAST_MAX and dismisses by id', () => {
    const service = TestBed.inject(ToastService);
    service.success('a');
    service.info('b');
    service.error('c');
    expect(service.toasts().map((t) => [t.kind, t.message, t.duration])).toEqual([
      ['success', 'a', TOAST_DEFAULT_DURATION],
      ['info', 'b', TOAST_DEFAULT_DURATION],
      ['error', 'c', TOAST_DEFAULT_DURATION],
    ]);
    service.dismiss(service.toasts()[1].id);
    expect(service.toasts().map((t) => t.message)).toEqual(['a', 'c']);
    for (let i = 0; i < TOAST_MAX + 2; i++) {
      service.info(`n${i}`);
    }
    expect(service.toasts().length).toBe(TOAST_MAX);
    expect(service.toasts().at(-1)?.message).toBe(`n${TOAST_MAX + 1}`);
  });
});

describe('ToastRegion', () => {
  it('is a named polite live region that renders toasts with a close button', async () => {
    const { service, root, settle, items } = setup();
    await settle();
    const region = root.querySelector('section')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-label')).toBe('[TOAST.REGION]');
    service.success('Salvato');
    service.error('Errore');
    await settle();
    expect(items().length).toBe(2);
    expect(items()[0].textContent).toContain('Salvato');
    expect(items()[0].hasAttribute('role')).toBe(false);
    expect(items()[1].getAttribute('role')).toBe('alert');
    expect(items()[1].querySelector('button')?.getAttribute('aria-label')).toBe('[COMMON.CLOSE]');
  });

  it('closes a toast with its button', async () => {
    const { service, settle, items } = setup();
    service.info('Ciao');
    await settle();
    items()[0].querySelector('button')!.click();
    await settle();
    expect(items().length).toBe(0);
    expect(service.toasts()).toEqual([]);
  });

  it('auto-closes after the duration', async () => {
    const { service, settle, items } = setup();
    service.info('Ciao');
    await settle();
    vi.advanceTimersByTime(TOAST_DEFAULT_DURATION - 1);
    await settle();
    expect(items().length).toBe(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(items().length).toBe(0);
  });

  it('pauses while hovered or focused and resumes with the remaining time', async () => {
    const { service, settle, items } = setup();
    service.show('info', 'Ciao', 1000);
    await settle();
    const toast = items()[0];
    vi.advanceTimersByTime(400);
    toast.dispatchEvent(new Event('mouseenter'));
    toast.dispatchEvent(new Event('focusin'));
    vi.advanceTimersByTime(5000);
    await settle();
    expect(items().length).toBe(1);

    toast.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(5000);
    await settle();
    expect(items().length).toBe(1);

    toast.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(599);
    await settle();
    expect(items().length).toBe(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(items().length).toBe(0);
  });

  it('never auto-closes with duration 0', async () => {
    const { service, settle, items } = setup();
    service.show('error', 'Resta', 0);
    await settle();
    vi.advanceTimersByTime(60000);
    await settle();
    expect(items().length).toBe(1);
  });

  it('stops the timer when destroyed', async () => {
    const { service, settle } = setup();
    service.info('Ciao');
    await settle();
    service.dismiss(service.toasts()[0].id);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});
