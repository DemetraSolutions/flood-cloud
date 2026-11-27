import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { SearchCombobox, SearchOption } from './search-combobox';

const A: SearchOption = { value: 'a', label: 'Alfa' };
const B: SearchOption = { value: 'b', label: 'Beta' };
const C: SearchOption = { value: 'c', label: 'Gamma' };

type Search = (text: string) => Promise<readonly SearchOption[]>;

@Component({
  imports: [SearchCombobox],
  template: `<fc-search-combobox
      label="Gruppo"
      [placeholder]="placeholder()"
      clearLabel="Mostra tutti"
      [search]="search"
      [value]="value()"
      [valueLabel]="valueLabel()"
      [error]="error()"
      (choice)="choices.push($event)"
    /><button id="outside" type="button">fuori</button>`,
})
class Host {
  search: Search = () => Promise.resolve([A, B, C]);
  readonly value = signal('');
  readonly valueLabel = signal<string | null>(null);
  readonly placeholder = signal<string | null>('Tutti');
  readonly error = signal<string | null>(null);
  readonly choices: (SearchOption | null)[] = [];
}

async function render(search: Search = () => Promise.resolve([A, B, C])) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.search = vi.fn(search);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  fixture.detectChanges();
  const input = root.querySelector<HTMLInputElement>('input')!;
  const key = async (name: string) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    await view();
    return event;
  };
  const type = async (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const options = () => [...root.querySelectorAll<HTMLElement>('[role=option]')];
  const note = () => root.querySelector('.note')?.textContent?.replace(/\s+/g, ' ').trim();
  const open = async () => {
    input.dispatchEvent(new Event('focus'));
    await view();
  };
  return {
    fixture,
    host: fixture.componentInstance,
    root,
    input,
    key,
    type,
    options,
    note,
    open,
    view,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SearchCombobox', () => {
  it('is an ARIA combobox with a visible label, and lists the first options when opened', async () => {
    const { root, input, options, open, host, view } = await render();
    expect(root.querySelector('label')?.textContent).toBe('Gruppo');
    expect(root.querySelector('label')?.getAttribute('for')).toBe(input.id);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.placeholder).toBe('Tutti');
    await open();
    expect(host.search).toHaveBeenCalledExactlyOnceWith('');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(root.querySelector('[role=listbox]')?.id);
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Alfa', 'Beta', 'Gamma']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(root.querySelector('[role=status]')?.textContent).toContain('"count":3');
    // Opening again (click on an open field) does not search again.
    input.click();
    await view();
    expect(host.search).toHaveBeenCalledTimes(1);
  });

  it('waits for a pause and for the minimum length before searching', async () => {
    const { host, type, note, view, open } = await render();
    await open();
    await type('a');
    await view(500);
    expect(host.search).toHaveBeenCalledTimes(1);
    expect(note()).toContain('SEARCH_COMBOBOX.MIN_CHARS');
    expect(note()).toContain('"count":2');
    await type('al');
    await type('alf');
    await view(249);
    expect(host.search).toHaveBeenCalledTimes(1);
    await view(1);
    expect(host.search).toHaveBeenCalledTimes(2);
    expect(host.search).toHaveBeenLastCalledWith('alf');
  });

  it('searches the trimmed text and shows the first options again when the text is cleared', async () => {
    const { host, type, view, open } = await render();
    await open();
    await type('  al  ');
    await view(250);
    expect(host.search).toHaveBeenLastCalledWith('al');
    await type('');
    await view(250);
    expect(host.search).toHaveBeenLastCalledWith('');
  });

  it('uses only the answer of the latest search', async () => {
    const answers: ((value: readonly SearchOption[]) => void)[] = [];
    const { type, options, view, open } = await render(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    await open();
    await type('al');
    await view(250);
    answers[1]([B]);
    await view();
    answers[0]([A, C]);
    await view();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Beta']);
  });

  it('shows loading, no results and the error with a retry', async () => {
    let calls = 0;
    const { note, view, open, options, root } = await render(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'x' }))
        : calls === 2
          ? Promise.resolve([])
          : Promise.resolve([A]);
    });
    await open();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('COMMON.RETRY');
    root.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    await view();
    expect(note()).toBe('SEARCH_COMBOBOX.EMPTY');
    expect(options()).toHaveLength(0);
    expect(root.querySelector('[role=status]')?.textContent).toContain('"count":0');
    // A third search that is slow shows the loading note.
    expect(calls).toBe(2);
  });

  it('shows the loading note while waiting', async () => {
    const { note, open } = await render(() => new Promise(() => undefined));
    await open();
    expect(note()).toBe('COMMON.LOADING');
  });

  it('ignores a failure that arrives after a newer search', async () => {
    const rejects: ((error: unknown) => void)[] = [];
    const answers: ((value: readonly SearchOption[]) => void)[] = [];
    let calls = 0;
    const { type, options, view, open, root } = await render(
      () =>
        new Promise((resolve, reject) => {
          calls++;
          if (calls === 1) {
            rejects.push(reject);
          } else {
            answers.push(resolve);
          }
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await open();
    await type('al');
    await view(250);
    answers[0]([A]);
    await view();
    rejects[0](new Error('late'));
    await view();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(options()).toHaveLength(1);
  });

  it('moves with the arrows, Home and End and chooses with Enter', async () => {
    const { key, options, input, host, root } = await render();
    await key('ArrowDown');
    expect(options()).toHaveLength(3);
    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    await key('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    await key('ArrowUp');
    await key('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await key('End');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    await key('Home');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await key('ArrowDown');
    const enter = await key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(host.choices).toEqual([B]);
    expect(root.querySelector('[role=listbox]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes with Escape (without letting it reach the page) and keeps what was chosen', async () => {
    const { key, root, input } = await render();
    await key('ArrowDown');
    const escape = await key('Escape');
    expect(root.querySelector('[role=listbox]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(escape.defaultPrevented).toBe(false);
  });

  it('leaves Escape, Enter, Home and End alone when closed or without options', async () => {
    const { key, host, root } = await render(() => Promise.resolve([]));
    expect((await key('Enter')).defaultPrevented).toBe(false);
    expect((await key('Home')).defaultPrevented).toBe(false);
    expect((await key('Escape')).defaultPrevented).toBe(false);
    await key('ArrowDown');
    expect((await key('End')).defaultPrevented).toBe(false);
    expect((await key('Enter')).defaultPrevented).toBe(false);
    expect(host.choices).toEqual([]);
    expect(root.querySelector('[role=listbox]')).not.toBeNull();
    await key('Tab');
  });

  it('chooses an option by clicking it and marks the current value as selected', async () => {
    const { host, options, open, view } = await render();
    host.value.set('b');
    await open();
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    options()[2].click();
    await view();
    expect(host.choices).toEqual([C]);
  });

  it('shows the chosen name, the name given for the value, or nothing', async () => {
    const { host, input, options, open, view } = await render();
    expect(input.value).toBe('');
    host.valueLabel.set('Nome dall’URL');
    host.value.set('x');
    await view();
    expect(input.value).toBe('Nome dall’URL');
    await open();
    options()[0].click();
    host.value.set('a');
    await view();
    expect(input.value).toBe('Alfa');
    host.value.set('zzz');
    await view();
    expect(input.value).toBe('Nome dall’URL');
  });

  it('clears the choice from the button and keeps the focus in the field', async () => {
    const { host, root, input, view } = await render();
    expect(root.querySelector('button[title]')).toBeNull();
    host.value.set('a');
    await view();
    const clear = root.querySelector<HTMLButtonElement>('button[title="Mostra tutti"]')!;
    expect(clear.getAttribute('aria-label')).toBe('Mostra tutti');
    clear.click();
    await view();
    expect(host.choices).toEqual([null]);
    expect(document.activeElement).toBe(input);
  });

  it('closes when the focus leaves, not when it moves inside', async () => {
    const { root, input, open, view } = await render();
    await open();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: input }));
    await view();
    expect(root.querySelector('[role=listbox]')).not.toBeNull();
    input.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: root.querySelector('#outside') }),
    );
    await view();
    expect(root.querySelector('[role=listbox]')).toBeNull();
  });

  it('ignores the answer of a search that was running when the list closed', async () => {
    let answer: (value: readonly SearchOption[]) => void = () => undefined;
    const { key, root, view, open } = await render(
      () => new Promise((resolve) => (answer = resolve)),
    );
    await open();
    await key('Escape');
    answer([A]);
    await view();
    expect(root.querySelector('[role=listbox]')).toBeNull();
  });

  it('keeps the focus in the field when the list is pressed', async () => {
    const { root, open } = await render();
    await open();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    root.querySelector('.popup')!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('has no placeholder attribute when none is given', async () => {
    const { host, input, view } = await render();
    expect(input.getAttribute('placeholder')).toBe('Tutti');
    host.placeholder.set(null);
    await view();
    expect(input.hasAttribute('placeholder')).toBe(false);
  });

  it('shows its error under the field, linked to the input, and takes it away', async () => {
    const { host, input, root, view } = await render();
    const message = () => root.querySelector('.error')?.textContent?.trim();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
    expect(message()).toBe('');
    host.error.set('Cliente non valido');
    await view();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(message()).toBe('Cliente non valido');
    expect(input.getAttribute('aria-describedby')).toBe(root.querySelector('.error')?.id);
    host.error.set(null);
    await view();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});
