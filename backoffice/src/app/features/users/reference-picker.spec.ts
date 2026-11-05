import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { settle } from '../../../testing/api';
import { ReferenceLoader, ReferencePicker } from './reference-picker';

const A = { id: 'a', name: 'Alfa' };
const B = { id: 'b', name: 'Beta' };
const page = (data: object[], next: string | null = null) => ({
  data: data as never[],
  page: { limit: 25, next },
});

@Component({
  imports: [ReferencePicker],
  template: `<fc-reference-picker
    label="Aziende"
    [loader]="loader()"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
    (blurred)="blurs.set(blurs() + 1)"
  />`,
})
class Host {
  readonly loader = signal<ReferenceLoader>(() => Promise.resolve(page([A, B], 'c1')));
  readonly value = signal<string[]>(['z']);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly blurs = signal(0);
}

async function render(loader?: ReferenceLoader) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  if (loader) {
    fixture.componentInstance.loader.set(loader);
  }
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const boxes = () => [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const picker = fixture.debugElement.children[0].componentInstance as ReferencePicker;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  return { fixture, host: fixture.componentInstance, root, boxes, picker, view };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('ReferencePicker', () => {
  it('lists the items with their selection and counts the selected ids', async () => {
    const { root, boxes } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('Aziende');
    expect(root.querySelectorAll('li label')).toHaveLength(2);
    expect(boxes().map((b) => b.checked)).toEqual([false, false]);
    expect(root.querySelector('.count')?.textContent).toBe('REFERENCE_PICKER.SELECTED {"count":1}');
  });

  it('selects and deselects items, keeping ids that are not on the page', async () => {
    const { host, boxes, view } = await render();
    boxes()[0].checked = true;
    boxes()[0].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual(['z', 'a']);
    expect(boxes()[0].checked).toBe(true);
    boxes()[0].checked = false;
    boxes()[0].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual(['z']);
  });

  it('shows the error, links it to the boxes and reports blur', async () => {
    const { host, root, boxes, view } = await render();
    host.error.set('Selezione non valida');
    await view();
    expect(root.querySelector('fieldset > .error')?.textContent).toContain('Selezione non valida');
    expect(boxes()[0].getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toContain('-error');
    boxes()[0].dispatchEvent(new Event('blur'));
    expect(host.blurs()).toBe(1);
  });

  it('can be disabled', async () => {
    const { host, root, view } = await render();
    host.disabled.set(true);
    await view();
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('focuses the first box, and nothing when empty', async () => {
    const { boxes, picker } = await render();
    picker.focus();
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it('has nothing to focus when empty', async () => {
    const { picker } = await render(() => Promise.resolve(page([])));
    expect(() => picker.focus()).not.toThrow();
  });

  it('loads more items when the page has a next cursor', async () => {
    const calls: { q: string; cursor: string | null }[] = [];
    const { root, boxes, view } = await render((query) => {
      calls.push(query);
      return Promise.resolve(query.cursor === null ? page([A], 'c1') : page([B]));
    });
    root.querySelector<HTMLButtonElement>('button')!.click();
    await view();
    expect(calls[1]).toEqual({ q: '', cursor: 'c1' });
    expect(boxes()).toHaveLength(2);
    expect(root.querySelector('button')).toBeNull();
  });

  it('says so when there is nothing to choose from', async () => {
    const { root } = await render(() => Promise.resolve(page([])));
    expect(root.querySelector('.note')?.textContent).toBe('REFERENCE_PICKER.EMPTY');
  });

  it('shows a failure, retries and reloads when the loader changes', async () => {
    let fail = true;
    const { host, root, boxes, view } = await render(() =>
      fail
        ? Promise.reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'm' }))
        : Promise.resolve(page([A])),
    );
    expect(root.querySelector('[role=alert]')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    fail = false;
    root.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    await view();
    expect(boxes()).toHaveLength(1);
    host.loader.set(() => Promise.resolve(page([B])));
    await view();
    expect(root.querySelector('li')?.textContent?.trim()).toBe('Beta');
  });

  it('searches after the typing pauses', async () => {
    const calls: string[] = [];
    const { fixture, root, view } = await render((query) => {
      calls.push(query.q);
      return Promise.resolve(page([A]));
    });
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'al';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(calls).toEqual(['']);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls).toEqual(['', 'al']);
    await view();
  });

  it('ignores a superseded answer and a superseded failure', async () => {
    const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    const { host, root, boxes, view } = await render(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve: resolve as never, reject });
        }),
    );
    host.loader.set(() => Promise.resolve(page([B])));
    await view();
    pending[0].resolve(page([A]));
    await view();
    expect(boxes()).toHaveLength(1);
    expect(root.querySelector('li')?.textContent?.trim()).toBe('Beta');

    const failing: { reject: (e: unknown) => void }[] = [];
    host.loader.set(
      () =>
        new Promise((_resolve, reject) => {
          failing.push({ reject });
        }),
    );
    await view();
    host.loader.set(() => Promise.resolve(page([A])));
    await view();
    failing[0].reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'm' }));
    await view();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(boxes()).toHaveLength(1);
  });
});
