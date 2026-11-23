import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { AttributeGroup } from '../product-catalog/product-catalog.types';
import { ProductAttributes } from './product-attributes';

const group = (id: string, name: Record<string, string>, attributes: [string, Record<string, string>][]): AttributeGroup => ({
  id,
  name,
  attributes: attributes.map(([attributeId, attributeName]) => ({ id: attributeId, name: attributeName }) as never),
  createdAt: null,
  updatedAt: null,
});

const GROUPS = [
  group('g1', { it: 'Taglia' }, [
    ['a1', { it: 'S' }],
    ['a2', { it: 'M' }],
  ]),
  group('g2', { en: 'Colour' }, []),
];

@Component({
  imports: [ProductAttributes],
  template: `<fc-product-attributes [groups]="groups()" [(value)]="value" [error]="error()" [disabled]="disabled()" />`,
})
class Host {
  readonly groups = signal<readonly AttributeGroup[]>(GROUPS);
  readonly value = signal<string[]>(['a2', 'gone']);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(language: 'it' | null = null) {
  TestBed.configureTestingModule({});
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key) => key);
  vi.spyOn(i18n, 'language').mockReturnValue(language);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = () => fixture.whenStable();
  const boxes = () => [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const control = fixture.debugElement.children[0].componentInstance as ProductAttributes;
  return { fixture, host: fixture.componentInstance, root, view, boxes, control };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductAttributes', () => {
  it('shows a fieldset per group with its attributes checked as chosen, and a note for an empty group', async () => {
    const { root, boxes } = await render();
    expect([...root.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Taglia', 'Colour']);
    expect([...root.querySelectorAll('label')].map((l) => l.textContent?.trim())).toEqual(['S', 'M']);
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    expect(root.querySelector('fieldset:nth-of-type(2) .note')?.textContent).toBe('PRODUCTS.ATTRIBUTES.NONE_IN_GROUP');
  });

  it('says there are no groups of attributes', async () => {
    const { host, root, view } = await render();
    host.groups.set([]);
    await view();
    expect(root.querySelector('fieldset')).toBeNull();
    expect(root.querySelector('.note')?.textContent).toBe('PRODUCTS.ATTRIBUTES.NONE');
  });

  it('chooses and unchooses attributes keeping the chosen ids that are not listed', async () => {
    const { host, boxes, view } = await render();
    boxes()[0].checked = true;
    boxes()[0].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual(['a2', 'gone', 'a1']);
    boxes()[1].checked = false;
    boxes()[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual(['gone', 'a1']);
  });

  it('names a group with the language of the user when it has it', async () => {
    const { root } = await render('it');
    expect(root.querySelector('legend')?.textContent).toBe('Taglia');
  });

  it('disables the fieldsets', async () => {
    const { host, root, view } = await render();
    const fieldsets = () => [...root.querySelectorAll('fieldset')].map((f) => f.disabled);
    expect(fieldsets()).toEqual([false, false]);
    host.disabled.set(true);
    await view();
    expect(fieldsets()).toEqual([true, true]);
  });

  it('shows the error as an alert linked to the fieldsets', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(root.querySelector('fieldset')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('[role=alert]')!;
    expect(alert.textContent).toBe('Non valido');
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('focuses the first checkbox, and does nothing without groups', async () => {
    const { host, root, view, control } = await render();
    control.focus();
    expect(document.activeElement).toBe(root.querySelector('input[type=checkbox]'));
    host.groups.set([]);
    await view();
    expect(() => control.focus()).not.toThrow();
  });
});
