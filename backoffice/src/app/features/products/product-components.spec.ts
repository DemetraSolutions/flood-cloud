import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { settle } from '../../../testing/api';
import { SearchCombobox } from '../../shared/ui/search-combobox/search-combobox';
import { ComponentRow } from './product-model';
import { ProductComponents } from './product-components';
import { PRODUCT_LIMITS } from './product.types';

const row = (productId: string, quantity = '1', waste = ''): ComponentRow => ({ productId, quantity, waste });

@Component({
  imports: [ProductComponents],
  template: `<fc-product-components [groupId]="groupId()" [(value)]="value" [error]="error()" [disabled]="disabled()" />`,
})
class Host {
  readonly groupId = signal('g1');
  readonly value = signal<ComponentRow[]>([row('p1', '2', '5'), row('p9')]);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(value?: ComponentRow[]) {
  const reference = {
    lookup: vi.fn().mockResolvedValue({
      data: [
        { id: 'p1', name: 'Farina' },
        { id: 'p2', name: 'Sale' },
      ],
      page: { limit: 25, next: null },
    }),
    lookupNames: vi.fn().mockResolvedValue({ p1: 'Farina da server' }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ReferenceApi, useValue: reference }] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  if (value) {
    fixture.componentInstance.value.set(value);
  }
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const control = fixture.debugElement.children[0].componentInstance as ProductComponents;
  const field = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!.control as HTMLInputElement;
  const type = async (label: string, text: string) => {
    const input = field(label);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const names = () => [...root.querySelectorAll('li strong')].map((s) => s.textContent);
  const combobox = () => root.querySelector<HTMLInputElement>('input[role=combobox]')!;
  const options = () => [...root.querySelectorAll<HTMLElement>('[role=option]')];
  const openOptions = async () => {
    combobox().dispatchEvent(new Event('focus'));
    await view();
  };
  return { fixture, host: fixture.componentInstance, root, view, control, field, type, names, combobox, options, openOptions, reference };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductComponents', () => {
  it('lists the components with the names read from the server, and a text for the unknown ones', async () => {
    const { names, reference, root } = await render();
    expect(names()).toEqual(['Farina da server', 'REFERENCE_PICKER.UNKNOWN']);
    expect(reference.lookupNames).toHaveBeenCalledWith('g1', 'products', ['p1', 'p9']);
    expect(root.querySelector('.hint')?.textContent).toBe('PRODUCTS.COMPONENTS.HINT');
  });

  it('says there are no components', async () => {
    const { root } = await render([]);
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCTS.COMPONENTS.EMPTY');
  });

  it('searches the products that are not modifiers and offers only the ones not yet in the list', async () => {
    const { reference, openOptions, options } = await render();
    await openOptions();
    expect(reference.lookup).toHaveBeenCalledWith('g1', 'products', { q: '', modifier: false, limit: 25 });
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Sale']);
  });

  it('adds the chosen product with quantity 1, remembering its name', async () => {
    const { host, names, openOptions, options, view, reference } = await render();
    await openOptions();
    options()[0].click();
    await view();
    expect(host.value()).toEqual([row('p1', '2', '5'), row('p9'), row('p2')]);
    expect(names()).toEqual(['Farina da server', 'REFERENCE_PICKER.UNKNOWN', 'Sale']);
    expect(reference.lookupNames).toHaveBeenLastCalledWith('g1', 'products', ['p1', 'p9', 'p2']);
  });

  it('ignores a cleared choice and does not add beyond the limit', async () => {
    const full = Array.from({ length: PRODUCT_LIMITS.components }, (_, i) => row(`x${i}`));
    const { fixture, host, openOptions, options, view } = await render(full);
    const combobox = fixture.debugElement.query(By.directive(SearchCombobox)).componentInstance as SearchCombobox;
    combobox.choice.emit(null);
    await view();
    expect(host.value()).toHaveLength(PRODUCT_LIMITS.components);
    await openOptions();
    options()[0].click();
    await view();
    expect(host.value()).toHaveLength(PRODUCT_LIMITS.components);
  });

  it('removes a component', async () => {
    const { host, root, view } = await render();
    const remove = root.querySelector<HTMLButtonElement>('button')!;
    expect(remove.getAttribute('aria-label')).toBe('PRODUCTS.COMPONENTS.REMOVE_LABEL {"name":"Farina da server"}');
    remove.click();
    await view();
    expect(host.value()).toEqual([row('p9')]);
  });

  it('edits the quantity and the waste of a component', async () => {
    const { host, type, field } = await render();
    expect(field('PRODUCTS.COMPONENTS.QUANTITY {"name":"Farina da server"}').value).toBe('2');
    await type('PRODUCTS.COMPONENTS.QUANTITY {"name":"Farina da server"}', '3');
    await type('PRODUCTS.COMPONENTS.WASTE {"name":"Farina da server"}', '10');
    expect(host.value()[0]).toEqual(row('p1', '3', '10'));
    expect(host.value()[1]).toEqual(row('p9'));
  });

  it('shows the error of the quantity and of the waste of a component', async () => {
    const { root, type } = await render();
    expect(root.querySelector('.error span')).toBeNull();
    await type('PRODUCTS.COMPONENTS.QUANTITY {"name":"Farina da server"}', '0');
    await type('PRODUCTS.COMPONENTS.WASTE {"name":"Farina da server"}', '101');
    expect([...root.querySelectorAll('.error span')].map((e) => e.textContent)).toEqual([
      'FORM.ISSUE.MINIMUM',
      'FORM.ISSUE.MAXIMUM',
    ]);
  });

  it('is read only when disabled: no remove buttons and no search', async () => {
    const { host, root, view } = await render();
    expect(root.querySelectorAll('button').length).toBeGreaterThan(0);
    host.disabled.set(true);
    await view();
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('fc-search-combobox')).toBeNull();
    expect([...root.querySelectorAll('input')].every((i) => i.disabled)).toBe(true);
  });

  it('shows the error as an alert linked to the list', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('p.problem')).toBeNull();
    expect(root.querySelector('ul')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]')!;
    expect(alert.textContent).toBe('Non valido');
    expect(root.querySelector('ul')?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('focuses the first field, and does nothing when there is none', async () => {
    const { host, root, view, control } = await render();
    control.focus();
    expect(document.activeElement).toBe(root.querySelector('input'));
    host.disabled.set(true);
    host.value.set([]);
    await view();
    expect(() => control.focus()).not.toThrow();
  });
});
