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
    [labels]="labels()"
    [emptyLabel]="emptyLabel()"
    [ordered]="ordered()"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
    (blurred)="blurs.set(blurs() + 1)"
  />`,
})
class Host {
  readonly loader = signal<ReferenceLoader>(() => Promise.resolve(page([A, B], 'c1')));
  readonly value = signal<string[]>(['z']);
  readonly labels = signal<Readonly<Partial<Record<string, string>>> | null>(null);
  readonly emptyLabel = signal<string | null>(null);
  readonly ordered = signal(false);
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

  describe('chosen items', () => {
    const chosen = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLLIElement>('ul.chosen li')].map((li) => li.textContent?.trim());

    it('lists nothing without labels', async () => {
      const { root, picker } = await render();
      expect(root.querySelector('ul.chosen')).toBeNull();
      expect((picker as unknown as { chosen(): unknown[] }).chosen()).toEqual([]);
    });

    it('lists the selected items by name: loaded page first, then labels, then "not found"', async () => {
      const { host, root, view } = await render();
      host.labels.set({ a: 'Alfa (etichetta)', y: 'Ypsilon' });
      host.value.set(['a', 'y', 'z']);
      await view();
      expect(root.querySelector('ul.chosen')?.getAttribute('aria-label')).toBe(
        'REFERENCE_PICKER.CHOSEN',
      );
      expect(chosen(root)).toEqual(['Alfa', 'Ypsilon', 'REFERENCE_PICKER.UNKNOWN']);
    });

    it('omits the list when nothing is selected', async () => {
      const { host, root, view } = await render();
      host.labels.set({});
      host.value.set([]);
      await view();
      expect(root.querySelector('ul.chosen')).toBeNull();
    });

    it('removes an item from the selection with its button', async () => {
      const { host, root, view } = await render();
      host.labels.set({ y: 'Ypsilon' });
      host.value.set(['y', 'z']);
      await view();
      const remove = root.querySelectorAll<HTMLButtonElement>('ul.chosen button');
      expect(remove[0].getAttribute('aria-label')).toBe(
        'REFERENCE_PICKER.REMOVE {"name":"Ypsilon"}',
      );
      expect(remove[1].getAttribute('aria-label')).toBe(
        'REFERENCE_PICKER.REMOVE {"name":"REFERENCE_PICKER.UNKNOWN"}',
      );
      remove[0].click();
      await view();
      expect(host.value()).toEqual(['z']);
      expect(chosen(root)).toEqual(['REFERENCE_PICKER.UNKNOWN']);
    });

    it('does not remove anything while disabled', async () => {
      const { host, root, view } = await render();
      host.labels.set({ z: 'Zeta' });
      host.disabled.set(true);
      await view();
      const button = root.querySelector<HTMLButtonElement>('ul.chosen button')!;
      expect(button.disabled).toBe(true);
      button.click();
      await view();
      expect(host.value()).toEqual(['z']);
    });
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

  describe('items without a name', () => {
    it('shows the neutral label in the list and in the chosen items', async () => {
      const { host, root, view } = await render(() =>
        Promise.resolve(page([{ id: 'n', name: '' }, B])),
      );
      host.emptyLabel.set('Senza nome');
      host.labels.set({ n: '' });
      host.value.set(['n']);
      await view();
      expect(root.querySelector('li label')?.textContent?.trim()).toBe('Senza nome');
      expect(root.querySelector('ul.chosen span')?.textContent?.trim()).toBe('Senza nome');
    });

    it('shows nothing for an empty name when there is no neutral label', async () => {
      const { root } = await render(() => Promise.resolve(page([{ id: 'n', name: '' }])));
      expect(root.querySelector('li label')?.textContent?.trim()).toBe('');
    });
  });

  describe('ordered selection', () => {
    async function ordered() {
      const rendered = await render();
      rendered.host.labels.set({ a: 'Alfa', b: 'Beta', c: 'Gamma' });
      rendered.host.ordered.set(true);
      rendered.host.value.set(['a', 'b', 'c']);
      await rendered.view();
      const move = (id: string, direction: 'up' | 'down') =>
        [...rendered.root.querySelectorAll<HTMLButtonElement>('button[data-move]')].filter(
          (button) => button.dataset['move'] === id,
        )[direction === 'up' ? 0 : 1];
      return { ...rendered, move };
    }

    it('offers no moving buttons unless asked', async () => {
      const { host, root, view } = await render();
      host.labels.set({ a: 'Alfa' });
      host.value.set(['a']);
      await view();
      expect(root.querySelectorAll('button[data-move]')).toHaveLength(0);
    });

    it('offers named up and down buttons, disabled at the ends', async () => {
      const { move } = await ordered();
      expect(move('a', 'up').disabled).toBe(true);
      expect(move('a', 'down').disabled).toBe(false);
      expect(move('c', 'down').disabled).toBe(true);
      expect(move('b', 'up').getAttribute('aria-label')).toBe(
        'REFERENCE_PICKER.MOVE_UP {"name":"Beta"}',
      );
      expect(move('b', 'down').getAttribute('aria-label')).toBe(
        'REFERENCE_PICKER.MOVE_DOWN {"name":"Beta"}',
      );
    });

    it('disables the buttons with the group', async () => {
      const { host, move, view } = await ordered();
      host.disabled.set(true);
      await view();
      expect(move('b', 'up').disabled).toBe(true);
      expect(move('b', 'down').disabled).toBe(true);
    });

    it('moves an item down and announces it', async () => {
      const { host, move, root, view } = await ordered();
      move('a', 'down').click();
      await view();
      expect(host.value()).toEqual(['b', 'a', 'c']);
      expect(root.querySelector('[role=status].visually-hidden')?.textContent).toBe(
        'REFERENCE_PICKER.MOVED {"name":"Alfa","position":2,"total":3}',
      );
      expect(document.activeElement).toBe(move('a', 'down'));
    });

    it('moves an item up and keeps the focus on the same button', async () => {
      const { host, move, view } = await ordered();
      move('c', 'up').click();
      await view();
      expect(host.value()).toEqual(['a', 'c', 'b']);
      expect(document.activeElement).toBe(move('c', 'up'));
    });

    it('moves the focus to the other button when the item reaches an end', async () => {
      const { host, move, view } = await ordered();
      move('b', 'up').click();
      await view();
      expect(host.value()).toEqual(['b', 'a', 'c']);
      expect(document.activeElement).toBe(move('b', 'down'));
      move('b', 'down').click();
      await view();
      move('b', 'down').click();
      await view();
      expect(host.value()).toEqual(['a', 'c', 'b']);
      expect(document.activeElement).toBe(move('b', 'up'));
    });
  });
});
