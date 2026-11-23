import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { settle } from '../../../testing/api';
import { CategoryCheckList } from './category-check-list';
import { CategoryNode, flatten } from './category.types';

const node = (id: string, name: string | null, children: CategoryNode[] = []): CategoryNode => ({
  id,
  name,
  parentId: null,
  position: null,
  enabled: true,
  children,
});

const TREE = [node('a', 'Alfa', [node('a1', 'Figlio'), node('a2', null)]), node('b', 'Beta')];

@Component({
  imports: [CategoryCheckList],
  template: `<fc-category-check-list
    label="Modificatori"
    [entries]="entries()"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly entries = signal(flatten(TREE));
  readonly value = signal<string[]>(['out']);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const boxes = () => [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const list = fixture.debugElement.children[0].componentInstance as CategoryCheckList;
  return { fixture, host: fixture.componentInstance, root, boxes, view, list };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CategoryCheckList', () => {
  it('lists the categories indented by level, with the text for the empty name', async () => {
    const { root } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('Modificatori');
    expect([...root.querySelectorAll('li label')].map((l) => l.textContent?.trim())).toEqual([
      'Alfa',
      'Figlio',
      'PRODUCT_CATEGORIES.NO_NAME',
      'Beta',
    ]);
    const items = [...root.querySelectorAll<HTMLElement>('li')];
    expect(items.map((li) => li.style.paddingInlineStart)).toEqual(['0rem', '1.25rem', '1.25rem', '0rem']);
  });

  it('chooses and unchooses a category, keeping the ids that are not in the tree', async () => {
    const { host, boxes, view } = await render();
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false, false]);
    boxes()[1].checked = true;
    boxes()[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual(['out', 'a1']);
    expect(boxes()[1].checked).toBe(true);
    boxes()[1].checked = false;
    boxes()[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual(['out']);
  });

  it('disables the group', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('fieldset')?.disabled).toBe(false);
    host.disabled.set(true);
    await view();
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('shows the error as an alert linked to the group', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(root.querySelector('fieldset')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('[role=alert]');
    expect(alert?.textContent).toBe('Non valido');
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('focuses the first checkbox, and does nothing without categories', async () => {
    const { host, boxes, view, list } = await render();
    list.focus();
    expect(document.activeElement).toBe(boxes()[0]);
    host.entries.set([]);
    await view();
    expect(() => list.focus()).not.toThrow();
  });
});
