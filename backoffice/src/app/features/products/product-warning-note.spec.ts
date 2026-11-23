import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { settle } from '../../../testing/api';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ProductWarning } from './product.types';
import { ProductWarningNote } from './product-warning-note';

const WARNING: ProductWarning = { field: 'code', issue: 'duplicate', productIds: ['aaaaaa111111', 'bbbbbb222222'], others: 0 };

async function render(lookupNames: ReturnType<typeof vi.fn>, warning?: ProductWarning, pending = false) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: ReferenceApi, useValue: { lookupNames } }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(ProductWarningNote);
  fixture.componentRef.setInput('groupId', 'g1');
  fixture.componentRef.setInput('warning', warning);
  // A read that never ends keeps the fixture unstable: only wait for the first render.
  await settle();
  if (!pending) {
    await fixture.whenStable();
  }
  const root = fixture.nativeElement as HTMLElement;
  const links = () => [...root.querySelectorAll('a')];
  return { fixture, root, links };
}

afterEach(() => vi.restoreAllMocks());

describe('ProductWarningNote', () => {
  it('shows nothing without a warning and reads nothing', async () => {
    const lookupNames = vi.fn();
    const { root } = await render(lookupNames);
    expect(root.querySelector('p')).toBeNull();
    expect(lookupNames).not.toHaveBeenCalled();
  });

  it('links the products by name and says nothing about others when there are none', async () => {
    const lookupNames = vi.fn().mockResolvedValue({ aaaaaa111111: 'Pizza', bbbbbb222222: '' });
    const { root, links } = await render(lookupNames, WARNING);
    expect(lookupNames).toHaveBeenCalledWith('g1', 'products', ['aaaaaa111111', 'bbbbbb222222']);
    expect(root.querySelector('p')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('p')?.textContent).toContain('PRODUCTS.WARNING.DUPLICATE');
    // A product without a name shows the end of its id.
    expect(links().map((link) => link.textContent)).toEqual(['Pizza', '…222222']);
    expect(links()[0].getAttribute('href')).toBe('/groups/g1/products/aaaaaa111111');
    expect(root.textContent).toContain('Pizza, ');
    expect(root.textContent).not.toContain('PRODUCTS.WARNING.OTHERS');
  });

  it('says how many other products use the value', async () => {
    const { root } = await render(vi.fn().mockResolvedValue({}), { ...WARNING, others: 3 });
    expect(root.textContent).toContain('PRODUCTS.WARNING.OTHERS {"count":3}');
  });

  it('shows the short ids while the names are being read', async () => {
    const lookupNames = vi.fn().mockReturnValue(new Promise(() => undefined));
    const { links } = await render(lookupNames, WARNING, true);
    expect(links().map((link) => link.textContent)).toEqual(['…111111', '…222222']);
  });

  it('shows the short ids and logs only the code when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'https://x/products?ids=aaaaaa111111' });
    const { links } = await render(vi.fn().mockRejectedValue(error), WARNING);
    expect(links().map((link) => link.textContent)).toEqual(['…111111', '…222222']);
    expect(warn).toHaveBeenCalledWith('Cannot read the names of the products that use the same value', 'INTERNAL_ERROR');
  });

  it('logs an unexpected failure as such', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(vi.fn().mockRejectedValue(new Error('boom')), WARNING);
    expect(warn).toHaveBeenCalledWith('Cannot read the names of the products that use the same value', 'unexpected');
  });

  it('reads nothing when the warning names no product', async () => {
    const lookupNames = vi.fn();
    const { root, links } = await render(lookupNames, { ...WARNING, productIds: [], others: 2 });
    expect(lookupNames).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
    expect(root.textContent).toContain('PRODUCTS.WARNING.OTHERS {"count":2}');
  });
});
