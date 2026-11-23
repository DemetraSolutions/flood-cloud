import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ProductBlock } from './product-errors';
import { ProductReferenceBlock } from './product-reference-block';

const BLOCK: ProductBlock = {
  product: 'Pizza',
  groups: [
    { kind: 'menu' as never, items: ['Menu A', 'Menu B'], hidden: false },
    { kind: 'category' as never, items: [], hidden: true },
  ],
};

@Component({
  imports: [ProductReferenceBlock],
  template: `<fc-product-reference-block [block]="block()" (closed)="closed.set(closed() + 1)" />`,
})
class Host {
  readonly block = signal<ProductBlock>(BLOCK);
  readonly closed = signal(0);
}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, root: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductReferenceBlock', () => {
  it('names the product and lists what refers to it, kind by kind', async () => {
    const { root } = await render();
    const panel = root.querySelector('[role=alert]')!;
    expect(panel.querySelector('h2')?.textContent).toBe('PRODUCTS.DELETE.BLOCKED_TITLE {"name":"Pizza"}');
    expect(panel.getAttribute('aria-labelledby')).toBe(panel.querySelector('h2')?.id);
    expect([...panel.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'PRODUCTS.REFERENCE.menu',
      'PRODUCTS.REFERENCE.category',
    ]);
    const lists = panel.querySelectorAll('ul');
    expect([...lists[0].querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Menu A', 'Menu B']);
  });

  it('says there are references the user cannot see only when the server hid some', async () => {
    const { root } = await render();
    const lists = root.querySelectorAll('ul');
    expect([...lists[1].querySelectorAll('li')].map((li) => li.textContent)).toEqual(['PRODUCTS.DELETE.HIDDEN']);
    expect(lists[0].textContent).not.toContain('PRODUCTS.DELETE.HIDDEN');
  });

  it('tells the panel was dismissed when the user closes it', async () => {
    const { host, root } = await render();
    root.querySelector('button')!.click();
    expect(root.querySelector('button')?.textContent?.trim()).toBe('COMMON.CLOSE');
    expect(host.closed()).toBe(1);
  });
});
