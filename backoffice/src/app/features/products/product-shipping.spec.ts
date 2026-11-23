import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, validate } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { coreModelOf } from '../../../testing/product-tabs-b-form';
import { CoreModel } from './product-model';
import { ProductShipping } from './product-shipping';

@Component({
  imports: [ProductShipping],
  template: `<fc-product-shipping [form]="f" />`,
})
class Host {
  readonly model = signal<CoreModel>(coreModelOf());
  readonly f = form(this.model, (path) => {
    for (const side of ['width', 'height', 'depth', 'weight'] as const) {
      validate(path.shipping[side], ({ value }) => (value() === 'x' ? { kind: 'required' } : undefined));
    }
  });
}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const field = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!.control as HTMLInputElement;
  return { fixture, host: fixture.componentInstance, root, field };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductShipping', () => {
  it('has the four measures bound to the form', async () => {
    const { host, fixture, field } = await render();
    const labels = ['WIDTH', 'HEIGHT', 'DEPTH', 'WEIGHT'];
    const keys = ['width', 'height', 'depth', 'weight'] as const;
    for (const [index, label] of labels.entries()) {
      const input = field(`PRODUCTS.SHIPPING.${label}`);
      expect(input.getAttribute('inputmode')).toBe('decimal');
      input.value = `${index + 1}`;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(host.model().shipping[keys[index]]).toBe(`${index + 1}`);
    }
  });

  it('shows the error of a field only after the user left it', async () => {
    const { fixture, root, field } = await render();
    const width = field('PRODUCTS.SHIPPING.WIDTH');
    width.value = 'x';
    width.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root.querySelector('.error span')).toBeNull();
    width.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(root.querySelector('.error span')?.textContent).toBe('FORM.ISSUE.REQUIRED');
  });

  it('marks every field as touched when it loses the focus', async () => {
    const { host, fixture, field } = await render();
    for (const label of ['HEIGHT', 'DEPTH', 'WEIGHT']) {
      field(`PRODUCTS.SHIPPING.${label}`).dispatchEvent(new Event('blur'));
    }
    await fixture.whenStable();
    expect(host.f.shipping.height().touched()).toBe(true);
    expect(host.f.shipping.depth().touched()).toBe(true);
    expect(host.f.shipping.weight().touched()).toBe(true);
    expect(host.f.shipping.width().touched()).toBe(false);
  });
});
