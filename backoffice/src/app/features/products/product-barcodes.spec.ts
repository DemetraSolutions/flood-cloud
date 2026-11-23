import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { settle } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { BarcodeRow } from './product-model';
import { ProductBarcodes, stripScannerPrefix } from './product-barcodes';
import { ProductWarning } from './product.types';

@Component({
  imports: [ProductBarcodes],
  template: `<fc-product-barcodes
    groupId="g1"
    [(value)]="value"
    [warehouse]="warehouse()"
    [ratio]="ratio()"
    [warnings]="warnings()"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly value = signal<BarcodeRow[]>([{ value: '8001', loadQuantity: '2', saleQuantity: '1' }]);
  readonly warehouse = signal(true);
  readonly ratio = signal<number | null>(1.5);
  readonly warnings = signal<readonly ProductWarning[]>([]);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render() {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: ReferenceApi, useValue: { lookupNames: vi.fn().mockResolvedValue({ p1: 'Pizza' }) } }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const rows = () => [...root.querySelectorAll<HTMLElement>('ul > li')];
  const inputs = (i: number) => [...rows()[i].querySelectorAll<HTMLInputElement>('input')];
  const buttonOf = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const component = fixture.debugElement.children[0].componentInstance as ProductBarcodes;
  return { host: fixture.componentInstance, root, view, rows, inputs, buttonOf, type, component };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('stripScannerPrefix', () => {
  it('removes a leading @ only', () => {
    expect(stripScannerPrefix('@8001')).toBe('8001');
    expect(stripScannerPrefix('80@01')).toBe('80@01');
  });
});

describe('ProductBarcodes', () => {
  it('says there are no barcodes when none is set', async () => {
    const { host, root, view } = await render();
    host.value.set([]);
    await view();
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCTS.BARCODES.EMPTY');
  });

  it('shows value, load, unload (read only: load times ratio) and sale quantity', async () => {
    const { inputs } = await render();
    const [value, load, unload, sale] = inputs(0);
    expect([value.value, load.value, unload.value, sale.value]).toEqual(['8001', '2', '3', '1']);
    expect(unload.readOnly).toBe(true);
  });

  it('leaves out load and unload without the warehouse', async () => {
    const { host, inputs, view } = await render();
    host.warehouse.set(false);
    await view();
    expect(inputs(0).map((i) => i.value)).toEqual(['8001', '1']);
  });

  it('leaves the unload empty when the load or the ratio is missing', async () => {
    const { host, inputs, view } = await render();
    host.ratio.set(null);
    await view();
    expect(inputs(0)[2].value).toBe('');
    host.ratio.set(2);
    host.value.set([{ value: 'a', loadQuantity: '  ', saleQuantity: '' }]);
    await view();
    expect(inputs(0)[2].value).toBe('');
    host.value.set([{ value: 'a', loadQuantity: 'x', saleQuantity: '' }]);
    await view();
    expect(inputs(0)[2].value).toBe('');
  });

  it('adds a barcode, up to the limit', async () => {
    const { host, buttonOf, view, rows } = await render();
    buttonOf('PRODUCTS.BARCODES.ADD').click();
    await view();
    expect(host.value()).toEqual([
      { value: '8001', loadQuantity: '2', saleQuantity: '1' },
      { value: '', loadQuantity: '', saleQuantity: '' },
    ]);
    expect(rows()).toHaveLength(2);
    host.value.set(Array.from({ length: 100 }, (_, n) => ({ value: `c${n}`, loadQuantity: '', saleQuantity: '' })));
    await view();
    expect(buttonOf('PRODUCTS.BARCODES.ADD').disabled).toBe(true);
  });

  it('removes the barcode of the row', async () => {
    const { host, buttonOf, view } = await render();
    host.value.set([
      { value: 'a', loadQuantity: '', saleQuantity: '' },
      { value: 'b', loadQuantity: '', saleQuantity: '' },
    ]);
    await view();
    const remove = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="PRODUCTS.BARCODES.REMOVE_LABEL"]')];
    expect(remove).toHaveLength(2);
    remove[0].click();
    await view();
    expect(host.value().map((row) => row.value)).toEqual(['b']);
    expect(buttonOf('PRODUCTS.REMOVE')).toBeTruthy();
  });

  it('changes only the row that was edited and strips the scanner prefix', async () => {
    const { host, inputs, type, view } = await render();
    host.value.set([
      { value: 'a', loadQuantity: '', saleQuantity: '' },
      { value: 'b', loadQuantity: '', saleQuantity: '' },
    ]);
    await view();
    await type(inputs(1)[0], '@7777');
    expect(inputs(1)[0].value).toBe('7777');
    await type(inputs(1)[1], '4');
    await type(inputs(1)[3], '5');
    expect(host.value()).toEqual([
      { value: 'a', loadQuantity: '', saleQuantity: '' },
      { value: '7777', loadQuantity: '4', saleQuantity: '5' },
    ]);
  });

  it('shows the error of each field of a row', async () => {
    const { host, root, view } = await render();
    host.value.set([{ value: '', loadQuantity: 'x', saleQuantity: '-1' }]);
    await view();
    const messages = [...root.querySelectorAll('.error span')].map((span) => span.textContent);
    expect(messages).toEqual(['FORM.ISSUE.REQUIRED', 'FORM.ISSUE.TYPE', 'FORM.ISSUE.MINIMUM']);
  });

  it('shows no error for a valid row and flags a value that is too long or has control characters', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('.error span')).toBeNull();
    host.value.set([{ value: 'x'.repeat(65), loadQuantity: '', saleQuantity: '' }]);
    await view();
    expect(root.querySelector('.error span')?.textContent).toBe('FORM.ISSUE.MAX_LENGTH');
    host.value.set([{ value: 'a\u0001b', loadQuantity: '', saleQuantity: '' }]);
    await view();
    expect(root.querySelector('.error span')?.textContent).toBe('FORM.ISSUE.PATTERN');
  });

  it('shows the warning of the row it belongs to', async () => {
    const { host, root, view, rows } = await render();
    host.value.set([
      { value: 'a', loadQuantity: '', saleQuantity: '' },
      { value: 'b', loadQuantity: '', saleQuantity: '' },
    ]);
    host.warnings.set([{ field: 'barcodes.1', issue: 'duplicate', productIds: ['p1'], others: 0 }]);
    await view();
    expect(rows()[0].querySelector('p[role=status]')).toBeNull();
    expect(rows()[1].querySelector('p[role=status] a')?.textContent).toBe('Pizza');
    expect(root.querySelectorAll('p[role=status]')).toHaveLength(1);
  });

  it('hides add and remove, and disables the fields, when disabled', async () => {
    const { host, root, inputs, view } = await render();
    host.disabled.set(true);
    await view();
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(inputs(0).filter((i) => !i.readOnly).every((i) => i.disabled)).toBe(true);
  });

  it('shows the error as an alert linked to the list', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('ul')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Troppi');
    await view();
    const alert = root.querySelector('p.problem[role=alert]');
    expect(alert?.textContent).toBe('Troppi');
    expect(root.querySelector('ul')?.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('focuses the first field, and does nothing without barcodes', async () => {
    const { host, inputs, view, component } = await render();
    component.focus();
    expect(document.activeElement).toBe(inputs(0)[0]);
    host.value.set([]);
    await view();
    expect(() => component.focus()).not.toThrow();
  });
});
