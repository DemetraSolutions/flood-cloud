import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { settle } from '../../../testing/api';
import { CategoryTreeView } from './category-tree-view';
import { CategoryNode } from './category.types';

const node = (
  id: string,
  name: string | null,
  children: CategoryNode[] = [],
  enabled = true,
): CategoryNode => ({ id, name, parentId: null, position: null, enabled, children });

const TREE = [
  node('a', 'Alfa', [node('a1', 'Figlio', [], false), node('a2', null)]),
  node('b', 'Beta'),
];

@Component({
  imports: [CategoryTreeView],
  template: `<fc-category-tree-view label="Categorie" [nodes]="nodes()" (open)="opened.push($event)" />`,
})
class Host {
  readonly nodes = signal(TREE);
  readonly opened: string[] = [];
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const items = () => [...root.querySelectorAll<HTMLElement>('[role=treeitem]')];
  const item = (id: string) => root.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const key = async (el: HTMLElement, k: string) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    await view();
    return event;
  };
  return { fixture, host: fixture.componentInstance, root, items, item, view, key };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CategoryTreeView', () => {
  it('renders a flat tree with the ARIA level, size, position and state of each row', async () => {
    const { root, items } = await render();
    expect(root.querySelector('[role=tree]')?.getAttribute('aria-label')).toBe('Categorie');
    expect(items().map((i) => i.dataset['id'])).toEqual(['a', 'a1', 'a2', 'b']);
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2', '1']);
    expect(items().map((i) => i.getAttribute('aria-setsize'))).toEqual(['2', '2', '2', '2']);
    expect(items().map((i) => i.getAttribute('aria-posinset'))).toEqual(['1', '1', '2', '2']);
    expect(items().map((i) => i.getAttribute('aria-expanded'))).toEqual(['true', null, null, null]);
    expect(items().map((i) => i.querySelector('.name')?.textContent)).toEqual([
      'Alfa',
      'Figlio',
      'PRODUCT_CATEGORIES.NO_NAME',
      'Beta',
    ]);
  });

  it('shows a badge only for the categories that are not enabled', async () => {
    const { root, item } = await render();
    expect(root.querySelectorAll('fc-status-badge')).toHaveLength(1);
    expect(item('a1').querySelector('fc-status-badge')?.textContent).toContain('PRODUCT_CATALOG.STATE.DISABLED');
  });

  it('has a single tab stop, on the first row', async () => {
    const { items } = await render();
    expect(items().map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });

  it('moves with Down, Up, Home and End, and stops at the ends', async () => {
    const { item, key, items } = await render();
    await key(item('a'), 'ArrowDown');
    expect(document.activeElement).toBe(item('a1'));
    expect(items().map((i) => i.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
    await key(item('a1'), 'ArrowUp');
    expect(document.activeElement).toBe(item('a'));
    await key(item('a'), 'ArrowUp');
    expect(document.activeElement).toBe(item('a'));
    await key(item('a'), 'End');
    expect(document.activeElement).toBe(item('b'));
    const down = await key(item('b'), 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item('b'));
    await key(item('b'), 'Home');
    expect(document.activeElement).toBe(item('a'));
  });

  it('closes a branch with Left, goes to the parent with Left, opens with Right then goes to the first child', async () => {
    const { item, key, items } = await render();
    await key(item('a'), 'ArrowLeft');
    expect(items().map((i) => i.dataset['id'])).toEqual(['a', 'b']);
    expect(item('a').getAttribute('aria-expanded')).toBe('false');
    await key(item('a'), 'ArrowRight');
    expect(items()).toHaveLength(4);
    expect(item('a').getAttribute('aria-expanded')).toBe('true');
    await key(item('a'), 'ArrowRight');
    expect(document.activeElement).toBe(item('a1'));
    // A leaf: Right does nothing, Left goes to the parent.
    await key(item('a1'), 'ArrowRight');
    expect(document.activeElement).toBe(item('a1'));
    await key(item('a1'), 'ArrowLeft');
    expect(document.activeElement).toBe(item('a'));
    // A root leaf: Left does nothing.
    item('b').focus();
    const left = await key(item('b'), 'ArrowLeft');
    expect(left.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item('b'));
  });

  it('opens the category with Enter and Space', async () => {
    const { host, item, key } = await render();
    expect((await key(item('b'), 'Enter')).defaultPrevented).toBe(true);
    await key(item('a1'), ' ');
    expect(host.opened).toEqual(['b', 'a1']);
  });

  it('ignores the other keys without preventing them', async () => {
    const { host, item, key } = await render();
    const event = await key(item('a'), 'x');
    expect(event.defaultPrevented).toBe(false);
    expect(host.opened).toEqual([]);
  });

  it('opens the category with a click on the row', async () => {
    const { host, item, view, items } = await render();
    item('b').click();
    await view();
    expect(host.opened).toEqual(['b']);
    expect(items().map((i) => i.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '0']);
  });

  it('opens and closes a branch with its button, without opening the category', async () => {
    const { host, root, item, view, items } = await render();
    const button = () => item('a').querySelector<HTMLButtonElement>('button')!;
    expect(button().getAttribute('aria-label')).toBe('PRODUCT_CATEGORIES.TREE.COLLAPSE {"name":"Alfa"}');
    button().click();
    await view();
    expect(items()).toHaveLength(2);
    expect(button().getAttribute('aria-label')).toBe('PRODUCT_CATEGORIES.TREE.EXPAND {"name":"Alfa"}');
    expect(button().textContent?.trim()).toBe('+');
    button().click();
    await view();
    expect(items()).toHaveLength(4);
    expect(button().textContent?.trim()).toBe('−');
    expect(host.opened).toEqual([]);
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });

  it('does not let a key pressed on the button reach the row', async () => {
    const { host, item, key } = await render();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    item('a').querySelector('button')!.dispatchEvent(event);
    await key(item('a'), 'x');
    expect(host.opened).toEqual([]);
  });

  it('gives the tab stop back to the first row when the current one disappears', async () => {
    const { item, key, items, view } = await render();
    await key(item('a'), 'ArrowDown');
    expect(item('a1').getAttribute('tabindex')).toBe('0');
    item('a').querySelector<HTMLButtonElement>('button')!.click();
    await view();
    expect(items().map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1']);
  });

  it('has no tab stop and no rows without categories', async () => {
    const { fixture, host, items, view } = await render();
    const tree = fixture.debugElement.children[0].componentInstance as unknown as { stop(): string | null };
    expect(tree.stop()).toBe('a');
    host.nodes.set([]);
    await view();
    expect(items()).toHaveLength(0);
    expect(tree.stop()).toBeNull();
  });
});
