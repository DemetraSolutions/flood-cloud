import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, validate } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { settle } from '../../../testing/api';
import { coreModelOf } from '../../../testing/product-tabs-b-form';
import { CategoryNode, flatten } from '../product-categories/category.types';
import { CoreModel } from './product-model';
import { ProductVariants } from './product-variants';

const node = (id: string, name: string): CategoryNode => ({ id, name, parentId: null, position: null, enabled: true, children: [] });
const ENTRIES = flatten([node('c1', 'Extra'), node('c2', 'Salse')]);
const PAGE = { data: [{ id: 'm1', name: 'Senza glutine' }], page: { limit: 25, next: null } };

@Component({
  imports: [ProductVariants],
  template: `<fc-product-variants [form]="f" [groupId]="groupId()" [entries]="entries" [chosenIds]="chosenIds()" />`,
})
class Host {
  readonly groupId = signal('g1');
  readonly entries = ENTRIES;
  readonly chosenIds = signal<readonly string[]>(['m1', 'm2', 'm3']);
  readonly model = signal<CoreModel>(coreModelOf({ requiredModifierIds: ['m1'], modifierIds: ['m2'], excludedModifierIds: ['m3'] }));
  readonly f = form(this.model, (path) => {
    for (const field of [path.requiredModifierIds, path.modifierIds, path.excludedModifierIds, path.modifierCategoryIds]) {
      validate(field, ({ value }) => (value().includes('bad') ? { kind: 'server', message: 'Non valido' } : undefined));
    }
  });
}

async function render() {
  const reference = {
    lookup: vi.fn().mockResolvedValue(PAGE),
    lookupNames: vi.fn().mockResolvedValue({ m1: 'Senza glutine', m2: 'Piccante', m3: 'Aglio' }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ReferenceApi, useValue: reference }] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const pickers = () => [...root.querySelectorAll('fc-reference-picker')];
  return { fixture, host: fixture.componentInstance, root, view, pickers, reference };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductVariants', () => {
  it('shows the hint, three pickers of modifiers and the categories of modifiers', async () => {
    const { root, pickers } = await render();
    expect(root.querySelector('.note')?.textContent).toBe('PRODUCTS.VARIANTS.HINT');
    expect(pickers().map((p) => p.querySelector('legend')?.textContent)).toEqual([
      'PRODUCTS.VARIANTS.REQUIRED',
      'PRODUCTS.VARIANTS.SELECTABLE',
      'PRODUCTS.VARIANTS.EXCLUDED',
    ]);
    const list = root.querySelector('fc-category-check-list')!;
    expect(list.querySelector('legend')?.textContent).toBe('PRODUCTS.VARIANTS.CATEGORIES');
    expect([...list.querySelectorAll('li label')].map((l) => l.textContent?.trim())).toEqual(['Extra', 'Salse']);
  });

  it('searches the modifier products on the server and reads the names of the three lists once', async () => {
    const { reference, pickers } = await render();
    expect(reference.lookup).toHaveBeenCalledTimes(3);
    expect(reference.lookup).toHaveBeenCalledWith('g1', 'products', expect.objectContaining({ modifier: true }));
    expect(reference.lookupNames).toHaveBeenCalledTimes(1);
    expect(reference.lookupNames).toHaveBeenCalledWith('g1', 'products', ['m1', 'm2', 'm3'], true);
    expect(pickers().map((p) => p.querySelector('.chosen li span')?.textContent)).toEqual([
      'Senza glutine',
      'Piccante',
      'Aglio',
    ]);
  });

  it('reads the products again from the group when the group changes', async () => {
    const { host, reference, view } = await render();
    reference.lookup.mockClear();
    host.groupId.set('g2');
    await view();
    expect(reference.lookup).toHaveBeenCalledWith('g2', 'products', expect.objectContaining({ modifier: true }));
  });

  it('chooses a modifier and a category into the form', async () => {
    const { host, root, view, pickers } = await render();
    const boxes = [...root.querySelectorAll<HTMLInputElement>('fc-category-check-list input[type=checkbox]')];
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.model().modifierCategoryIds).toEqual(['c2']);
    const remove = pickers()[0].querySelector<HTMLButtonElement>('.chosen button')!;
    remove.click();
    await view();
    expect(host.model().requiredModifierIds).toEqual([]);
  });

  it('shows the error of every field and nothing for a valid form', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('.error span, [role=alert]')).toBeNull();
    host.model.update((model) => ({
      ...model,
      requiredModifierIds: ['bad'],
      modifierIds: ['bad'],
      excludedModifierIds: ['bad'],
      modifierCategoryIds: ['bad'],
    }));
    await view();
    expect([...root.querySelectorAll('.error span, [role=alert]')].map((a) => a.textContent?.trim())).toEqual([
      'Non valido',
      'Non valido',
      'Non valido',
      'Non valido',
    ]);
  });

  it('marks a field as touched when the focus leaves a checkbox of its picker', async () => {
    const { host, view, pickers } = await render();
    const lists = ['requiredModifierIds', 'modifierIds', 'excludedModifierIds'] as const;
    expect(lists.map((name) => host.f[name]().touched())).toEqual([false, false, false]);
    for (const [index, picker] of pickers().entries()) {
      picker.querySelector('ul:not(.chosen) input[type=checkbox]')!.dispatchEvent(new Event('blur'));
      await view();
      expect(lists.map((name) => host.f[name]().touched())).toEqual(lists.map((_, at) => at <= index));
    }
  });
});
