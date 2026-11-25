import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, required } from '@angular/forms/signals';
import { errorOf, findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { Countries } from '../../core/reference/countries';
import { AddressModel } from './contact-model';
import { ContactAddress } from './contact-address';

const LIST = signal([
  {
    code: 'IT',
    name: 'Italia',
    areas: [
      { code: 'MI', name: 'Milano' },
      { code: 'RM', name: 'Roma' },
    ],
  },
  { code: 'FR', name: 'Francia', areas: [] },
]);

const ADDRESS: AddressModel = {
  street: 'Via Roma 1',
  postcode: '20100',
  city: 'Milano',
  countryCode: 'IT',
  areaCode: 'MI',
};

@Component({
  imports: [ContactAddress],
  template: `<fc-contact-address [form]="f" legend="Indirizzo" />`,
})
class Host {
  readonly model = signal<AddressModel>({ ...ADDRESS });
  readonly f = form(this.model, (path) => required(path.street));
}

function render(address: AddressModel = ADDRESS) {
  const need = vi.fn();
  const countries = {
    list: LIST.asReadonly(),
    areas: (code: string) => LIST().find((country) => country.code === code)?.areas ?? [],
    need,
  };
  TestBed.configureTestingModule({ providers: [{ provide: Countries, useValue: countries }] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.model.set({ ...address });
  document.body.appendChild(fixture.nativeElement);
  return {
    fixture,
    host: fixture.componentInstance,
    need,
    root: fixture.nativeElement as HTMLElement,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactAddress', () => {
  it('asks for the countries and shows the address under its legend', async () => {
    const { fixture, need, root } = render();
    await fixture.whenStable();
    expect(need).toHaveBeenCalledOnce();
    expect(root.querySelector('legend')?.textContent).toBe('Indirizzo');
    expect(findControl(fixture, 'CONTACTS.ADDRESS.STREET').value).toBe('Via Roma 1');
    expect(findControl(fixture, 'CONTACTS.ADDRESS.CITY').value).toBe('Milano');
    expect(findControl(fixture, 'CONTACTS.ADDRESS.COUNTRY').value).toBe('IT');
    expect(findControl(fixture, 'CONTACTS.ADDRESS.PROVINCE').value).toBe('MI');
  });

  it('offers the provinces of the country with their codes', async () => {
    const { fixture } = render();
    await fixture.whenStable();
    const province = findControl(fixture, 'CONTACTS.ADDRESS.PROVINCE') as HTMLSelectElement;
    expect([...province.options].map((option) => option.textContent?.trim())).toContain(
      'Roma (RM)',
    );
  });

  it('writes what the user types into the form', async () => {
    const { fixture, host } = render();
    await fixture.whenStable();
    await typeInto(fixture, 'CONTACTS.ADDRESS.POSTCODE', '00100');
    expect(host.model().postcode).toBe('00100');
  });

  it('keeps the province when the new country has it, and clears it when it does not', async () => {
    const { fixture, host } = render({ ...ADDRESS, countryCode: 'FR', areaCode: 'MI' });
    await fixture.whenStable();
    await typeInto(fixture, 'CONTACTS.ADDRESS.COUNTRY', 'IT');
    expect(host.model().areaCode).toBe('MI');
    await typeInto(fixture, 'CONTACTS.ADDRESS.COUNTRY', 'FR');
    expect(host.model().countryCode).toBe('FR');
    expect(host.model().areaCode).toBe('');
  });

  it('has no province choice for a country without provinces', async () => {
    const { fixture, root } = render({ ...ADDRESS, countryCode: 'FR', areaCode: '' });
    await fixture.whenStable();
    expect(
      [...root.querySelectorAll('label')].map((label) => label.textContent?.trim()),
    ).not.toContain('CONTACTS.ADDRESS.PROVINCE');
  });

  it('keeps a country or province the lists do not have, so it is shown and not replaced', async () => {
    const { fixture } = render({ ...ADDRESS, countryCode: 'XX', areaCode: 'ZZ' });
    await fixture.whenStable();
    const country = findControl(fixture, 'CONTACTS.ADDRESS.COUNTRY') as HTMLSelectElement;
    expect(country.value).toBe('XX');
    expect([...country.options].map((option) => option.value)).toContain('XX');
  });

  it('keeps a province the country does not list', async () => {
    const { fixture } = render({ ...ADDRESS, areaCode: 'ZZ' });
    await fixture.whenStable();
    const province = findControl(fixture, 'CONTACTS.ADDRESS.PROVINCE') as HTMLSelectElement;
    expect(province.value).toBe('ZZ');
    expect([...province.options].map((option) => option.value)).toContain('ZZ');
  });

  it('shows the error of a field the user touched', async () => {
    const { fixture } = render({ ...ADDRESS, street: '' });
    await fixture.whenStable();
    expect(errorOf(fixture, 'CONTACTS.ADDRESS.STREET')).toBe('');
    findControl(fixture, 'CONTACTS.ADDRESS.STREET').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(errorOf(fixture, 'CONTACTS.ADDRESS.STREET')).not.toBe('');
  });

  it('marks every control touched when it loses the focus', async () => {
    const { fixture, root } = render({ ...ADDRESS });
    await fixture.whenStable();
    const controls = root.querySelectorAll('input, select');
    expect(controls.length).toBeGreaterThan(4);
    controls.forEach((control) => control.dispatchEvent(new Event('blur')));
    await fixture.whenStable();
    expect(root.querySelectorAll('input, select').length).toBe(controls.length);
  });
});
