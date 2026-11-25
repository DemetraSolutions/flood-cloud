import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { settle } from '../../../testing/api';
import {
  configureContactSection,
  contactSectionForm,
} from '../../../testing/contacts-section-host';
import { findControl } from '../../../testing/forms';
import { ContactCompany } from './contact-company';
import { ContactWarning } from './contact.types';

const GROUP = 'g1';
const OTHER_1 = '665f1c2e9b1d4a0012ab3c0b';
const OTHER_2 = '665f1c2e9b1d4a0012ab3c0c';

@Component({
  imports: [ContactCompany],
  template: `<fc-contact-company
    [form]="state.tree.company"
    [invoicing]="state.tree.eInvoicing"
    groupId="g1"
    [supplier]="supplier()"
    [warnings]="warnings()"
  />`,
})
class Host {
  readonly state = contactSectionForm();
  readonly supplier = signal(false);
  readonly warnings = signal<readonly ContactWarning[]>([]);
}

async function render() {
  configureContactSection();
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const type = async (label: string, value: string) => {
    const control = findControl(fixture, label);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    await view();
    return control;
  };
  return { fixture, host: fixture.componentInstance, root, view, button, type };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactCompany', () => {
  it('edits the company data of the form', async () => {
    const { host, type } = await render();
    await type('CONTACTS.COMPANY.NAME', 'Bianchi Srl');
    await type('CONTACTS.COMPANY.VAT_NUMBER', '01234567890');
    await type('CONTACTS.COMPANY.TAX_CODE', '01234567890');
    await type('CONTACTS.COMPANY.DISCOUNT', '5');
    expect(host.state.model().company).toMatchObject({
      name: 'Bianchi Srl',
      vatNumber: '01234567890',
      taxCode: '01234567890',
      discountPercent: '5',
    });
  });

  it('marks the fields as touched when they lose the focus', async () => {
    const { fixture, host, view } = await render();
    for (const label of ['NAME', 'VAT_NUMBER', 'TAX_CODE', 'DISCOUNT']) {
      findControl(fixture, `CONTACTS.COMPANY.${label}`).dispatchEvent(new Event('blur'));
    }
    await view();
    const company = host.state.tree.company;
    expect(
      [company.name, company.vatNumber, company.taxCode, company.discountPercent].map((f) =>
        f().touched(),
      ),
    ).toEqual([true, true, true, true]);
  });

  it('shows the message of a field under it, and the one of a list', async () => {
    const { fixture, host, root, view } = await render();
    host.state.serverError.set('Not valid');
    await view();
    expect(
      findControl(fixture, 'CONTACTS.COMPANY.NAME').getAttribute('aria-describedby'),
    ).toContain('error');
    const problems = [...root.querySelectorAll('fieldset p.problem[role=alert]')].map((p) =>
      p.textContent?.trim(),
    );
    // Phones, e-mail addresses, fax numbers and price lists.
    expect(problems).toEqual(['Not valid', 'Not valid', 'Not valid', 'Not valid']);
    host.state.serverError.set(null);
    await view();
    expect(root.querySelector('fieldset p.problem')).toBeNull();
  });

  describe('duplicates', () => {
    it('warns of a VAT number and of a tax code other contacts use, each under its field', async () => {
      const { host, root, view } = await render();
      expect(root.querySelector('fc-contact-warning-note p')).toBeNull();
      host.warnings.set([
        { field: 'person.taxCode', issue: 'duplicate', contactIds: [OTHER_1], others: 0 },
        { field: 'company.vatNumber', issue: 'duplicate', contactIds: [OTHER_1], others: 2 },
        { field: 'company.taxCode', issue: 'duplicate', contactIds: [OTHER_1, OTHER_2], others: 0 },
      ]);
      await view();
      const notes = [...root.querySelectorAll('fc-contact-warning-note p')];
      expect(notes).toHaveLength(2);
      expect(notes[0]!.closest('div')!.querySelector('input')?.id).toBe(
        (root.querySelectorAll('input')[1] as HTMLInputElement).id,
      );
      expect(notes[0]!.textContent).toContain('CONTACTS.WARNING.OTHERS {"count":2}');
      expect(root.textContent).toContain('CONTACTS.WARNING.FIELD_HINT');
      expect([...notes[1]!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
        `/groups/${GROUP}/contacts/${OTHER_1}`,
        `/groups/${GROUP}/contacts/${OTHER_2}`,
      ]);
      expect(notes[1]!.textContent).not.toContain('CONTACTS.WARNING.OTHERS');
    });
  });

  describe('lists', () => {
    it('adds and removes phones, e-mail addresses and fax numbers', async () => {
      const { host, root, button, view } = await render();
      button('CONTACTS.COMPANY.ADD_PHONE').click();
      button('CONTACTS.COMPANY.ADD_EMAIL').click();
      button('CONTACTS.COMPANY.ADD_FAX').click();
      await view();
      expect(host.state.model().company).toMatchObject({ phones: [''], emails: [''], faxes: [''] });
      expect(root.querySelectorAll('input[type=tel]')).toHaveLength(2);
      expect(root.querySelectorAll('fc-contact-string-list input[type=email]')).toHaveLength(1);
      button('CONTACTS.LIST.REMOVE').click();
      await view();
      expect(host.state.model().company.phones).toEqual([]);
    });

    it('stops each list at ten entries', async () => {
      const { host, button, view } = await render();
      host.state.model.update((model) => ({
        ...model,
        company: {
          ...model.company,
          phones: Array.from({ length: 10 }, (_, i) => `0${i}`),
          emails: Array.from({ length: 10 }, (_, i) => `a${i}@example.com`),
          faxes: Array.from({ length: 10 }, (_, i) => `1${i}`),
        },
      }));
      await view();
      expect(button('CONTACTS.COMPANY.ADD_PHONE').disabled).toBe(true);
      expect(button('CONTACTS.COMPANY.ADD_EMAIL').disabled).toBe(true);
      expect(button('CONTACTS.COMPANY.ADD_FAX').disabled).toBe(true);
    });

    it('shows the price lists of the supplier, highlighted only for a supplier', async () => {
      const { host, root, button, view } = await render();
      const lists = () => root.querySelector('fc-contact-supplier-lists fieldset')!;
      expect(lists().classList.contains('highlight')).toBe(false);
      host.supplier.set(true);
      await view();
      expect(lists().classList.contains('highlight')).toBe(true);
      button('CONTACTS.COMPANY.ADD_LIST').click();
      await view();
      expect(host.state.model().company.supplierPriceLists).toHaveLength(1);
    });
  });

  it('includes the e-invoicing block', async () => {
    const { root } = await render();
    expect(root.querySelector('fc-contact-e-invoicing legend')?.textContent?.trim()).toBe(
      'CONTACTS.E_INVOICING.TITLE',
    );
  });

  it('is read only when the form is', async () => {
    const { host, root, view } = await render();
    host.state.readOnly.set(true);
    await view();
    expect([...root.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
    expect(root.querySelector('fc-contact-string-list button')).toBeNull();
  });
});
