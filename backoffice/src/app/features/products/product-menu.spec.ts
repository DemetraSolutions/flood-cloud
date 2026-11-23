import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { settle } from '../../../testing/api';
import { CategoryNode, flatten } from '../product-categories/category.types';
import { ChoiceRow, MenuRow } from './product-model';
import { ChoiceKind, ProductMenu } from './product-menu';
import { PRODUCT_LIMITS } from './product.types';

const node = (id: string, name: string | null, children: CategoryNode[] = []): CategoryNode => ({
  id,
  name,
  parentId: null,
  position: null,
  enabled: true,
  children,
});
const ENTRIES = flatten([node('c1', 'Primi', [node('c2', 'Pasta'), node('c3', null)]), node('c4', 'Dolci')]);

const menuRow = (change: Partial<MenuRow> = {}): MenuRow => ({ categoryId: 'c1', quantity: '2', course: '1', productIds: ['p1'], ...change });
const choiceRow = (change: Partial<ChoiceRow> = {}): ChoiceRow => ({
  categoryId: 'c1',
  freeQuantity: '1',
  priceRule: 'highest',
  productIds: ['p1'],
  ...change,
});

@Component({
  imports: [ProductMenu],
  template: `<fc-product-menu
    groupId="g1"
    [kind]="kind()"
    [entries]="entries"
    [rooms]="rooms()"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly entries = ENTRIES;
  readonly kind = signal<ChoiceKind>('menu');
  readonly rooms = signal(false);
  readonly value = signal<(MenuRow | ChoiceRow)[]>([]);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(kind: ChoiceKind, value: (MenuRow | ChoiceRow)[], rooms = false) {
  const reference = {
    lookup: vi.fn().mockResolvedValue({ data: [{ id: 'p1', name: 'Spaghetti' }, { id: 'p2', name: 'Penne' }], page: { limit: 25, next: null } }),
    lookupNames: vi.fn().mockResolvedValue({ p1: 'Spaghetti' }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ReferenceApi, useValue: reference }] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.kind.set(kind);
  fixture.componentInstance.value.set(value);
  fixture.componentInstance.rooms.set(rooms);
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const control = fixture.debugElement.children[0].componentInstance as ProductMenu;
  const labelOf = (label: string) => [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label);
  const field = (label: string) => labelOf(label)!.control as HTMLInputElement & HTMLSelectElement;
  const type = async (label: string, text: string) => {
    const input = field(label);
    input.value = text;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const add = () => [...root.querySelectorAll<HTMLButtonElement>('.actions button')].find((b) => b.textContent?.trim() === 'PRODUCTS.CHOICES.ADD')!;
  return { fixture, host: fixture.componentInstance, root, view, control, labelOf, field, type, add, reference };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const CATEGORY = 'PRODUCTS.CHOICES.CATEGORY {"number":1}';

describe('ProductMenu', () => {
  it('says there are no groups and offers to add one', async () => {
    const { root, add } = await render('menu', []);
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCTS.CHOICES.EMPTY');
    expect(add().disabled).toBe(false);
  });

  it('lists the categories of the tree indented, with the text for an unnamed one, and keeps one that is not in the tree', async () => {
    const { field } = await render('menu', [menuRow({ categoryId: 'gone' })]);
    const select = field(CATEGORY);
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'PRODUCTS.CHOICES.CATEGORY_NONE',
      'Primi',
      '– Pasta',
      '– PRODUCT_CATEGORIES.NO_NAME',
      'Dolci',
      'gone',
    ]);
    expect(select.value).toBe('gone');
  });

  it('edits a group of a menu: category, quantity and, with rooms, the course', async () => {
    const { host, field, type } = await render('menu', [menuRow(), menuRow({ categoryId: 'c4' })], true);
    await type(CATEGORY, 'c2');
    await type('PRODUCTS.CHOICES.QUANTITY {"number":1}', '3');
    await type('PRODUCTS.CHOICES.COURSE {"number":1}', '2');
    expect(host.value()[0]).toEqual(menuRow({ categoryId: 'c2', quantity: '3', course: '2' }));
    expect(host.value()[1]).toEqual(menuRow({ categoryId: 'c4' }));
    expect(field('PRODUCTS.CHOICES.COURSE {"number":2}').value).toBe('1');
  });

  it('has no course without rooms and no choice fields in a menu', async () => {
    const { labelOf } = await render('menu', [menuRow()]);
    expect(labelOf('PRODUCTS.CHOICES.COURSE {"number":1}')).toBeUndefined();
    expect(labelOf('PRODUCTS.CHOICES.FREE_QUANTITY {"number":1}')).toBeUndefined();
    expect(labelOf('PRODUCTS.CHOICES.PRICE_RULE {"number":1}')).toBeUndefined();
  });

  it('edits a group of modifiers: category, free quantity and price rule', async () => {
    const { host, field, type, labelOf } = await render('choices', [choiceRow()], true);
    expect(labelOf('PRODUCTS.CHOICES.QUANTITY {"number":1}')).toBeUndefined();
    expect(labelOf('PRODUCTS.CHOICES.COURSE {"number":1}')).toBeUndefined();
    expect([...field('PRODUCTS.CHOICES.PRICE_RULE {"number":1}').options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['highest', 'PRODUCTS.CHOICES.RULE_HIGHEST'],
      ['lowest', 'PRODUCTS.CHOICES.RULE_LOWEST'],
    ]);
    await type('PRODUCTS.CHOICES.FREE_QUANTITY {"number":1}', '2');
    await type('PRODUCTS.CHOICES.PRICE_RULE {"number":1}', 'lowest');
    await type(CATEGORY, 'c4');
    expect(host.value()).toEqual([choiceRow({ freeQuantity: '2', priceRule: 'lowest', categoryId: 'c4' })]);
  });

  it('shows the errors of a menu group', async () => {
    const menu = await render('menu', [menuRow({ categoryId: '', quantity: '0', course: 'x' })], true);
    expect([...menu.root.querySelectorAll('.error span')].map((e) => e.textContent)).toEqual([
      'FORM.ISSUE.REQUIRED',
      'FORM.ISSUE.MINIMUM',
      'FORM.ISSUE.TYPE',
    ]);
  });

  it('shows the errors of a modifiers group', async () => {
    const { root } = await render('choices', [choiceRow({ categoryId: '', freeQuantity: '101' })]);
    expect([...root.querySelectorAll('.error span')].map((e) => e.textContent)).toEqual([
      'FORM.ISSUE.REQUIRED',
      'FORM.ISSUE.MAXIMUM',
    ]);
  });

  it('adds a group with the defaults of the kind and removes it', async () => {
    const { host, add, view, root } = await render('menu', []);
    add().click();
    await view();
    expect(host.value()).toEqual([{ categoryId: '', quantity: '1', course: '', productIds: [] }]);
    host.kind.set('choices');
    host.value.set([]);
    await view();
    add().click();
    await view();
    expect(host.value()).toEqual([{ categoryId: '', freeQuantity: '0', priceRule: 'highest', productIds: [] }]);
    const remove = [...root.querySelectorAll<HTMLButtonElement>('li .actions button')][0];
    expect(remove.getAttribute('aria-label')).toBe('PRODUCTS.CHOICES.REMOVE_LABEL {"number":1}');
    remove.click();
    await view();
    expect(host.value()).toEqual([]);
  });

  it('removes only the chosen group', async () => {
    const { host, root, view } = await render('menu', [menuRow(), menuRow({ categoryId: 'c4' })]);
    root.querySelectorAll<HTMLButtonElement>('li .actions button')[0].click();
    await view();
    expect(host.value()).toEqual([menuRow({ categoryId: 'c4' })]);
  });

  it('does not add beyond the limit', async () => {
    const { add } = await render('menu', Array.from({ length: PRODUCT_LIMITS.menuGroups }, () => menuRow()));
    expect(add().disabled).toBe(true);
  });

  it('chooses the products of a group of a menu among the ones that are not modifiers', async () => {
    const { host, root, view, reference } = await render('menu', [menuRow()]);
    expect(reference.lookup).toHaveBeenCalledWith('g1', 'products', expect.objectContaining({ modifier: false, categoryId: 'c1' }));
    expect(reference.lookupNames).toHaveBeenCalledWith('g1', 'products', ['p1'], false);
    expect(root.querySelector('legend')?.textContent).toBe('PRODUCTS.CHOICES.PRODUCTS {"number":1}');
    expect(root.querySelector('.chosen li span')?.textContent).toBe('Spaghetti');
    const boxes = root.querySelectorAll<HTMLInputElement>('fc-reference-picker ul:not(.chosen) input[type=checkbox]');
    expect([...boxes].map((b) => b.checked)).toEqual([true, false]);
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()[0].productIds).toEqual(['p1', 'p2']);
  });

  it('chooses the products of a group of modifiers among the modifiers', async () => {
    const { reference } = await render('choices', [choiceRow()]);
    expect(reference.lookup).toHaveBeenCalledWith('g1', 'products', expect.objectContaining({ modifier: true, categoryId: 'c1' }));
    expect(reference.lookupNames).toHaveBeenCalledWith('g1', 'products', ['p1'], true);
  });

  it('searches the products of the category of each group, with a loader kept per category', async () => {
    const { host, view, reference } = await render('menu', [menuRow(), menuRow({ categoryId: 'c4' })]);
    expect(reference.lookup).toHaveBeenCalledWith('g1', 'products', expect.objectContaining({ categoryId: 'c4' }));
    reference.lookup.mockClear();
    host.value.update((rows) => rows.map((row, i) => (i === 1 ? { ...row, quantity: '5' } : row)));
    await view();
    expect(reference.lookup).not.toHaveBeenCalled();
  });

  it('is read only when disabled', async () => {
    const { host, root, view } = await render('menu', [menuRow()]);
    host.disabled.set(true);
    await view();
    expect(root.querySelector('li .actions')).toBeNull();
    expect(root.querySelector('.actions')).toBeNull();
    expect(root.querySelector('select')?.disabled).toBe(true);
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('shows the error as an alert linked to the list', async () => {
    const { host, root, view } = await render('menu', []);
    expect(root.querySelector('p.problem')).toBeNull();
    expect(root.querySelector('ul')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]')!;
    expect(alert.textContent).toBe('Non valido');
    expect(root.querySelector('ul')?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('focuses the first field, and does nothing without groups', async () => {
    const { host, root, view, control } = await render('menu', [menuRow()]);
    control.focus();
    expect(document.activeElement).toBe(root.querySelector('select'));
    host.value.set([]);
    await view();
    expect(() => control.focus()).not.toThrow();
  });
});
