import { Component, Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, settle } from '../../../testing/api';
import {
  configureContactSection,
  contactSectionForm,
} from '../../../testing/contacts-section-host';
import { findControl } from '../../../testing/forms';
import { AppConfig } from '../../core/config/app-config';
import { ContactPerson } from './contact-person';
import { ContactWarning } from './contact.types';

const GROUP = 'g1';
const COMPANY_ID = '665f1c2e9b1d4a0012ab3c0a';
const OTHER_ID = '665f1c2e9b1d4a0012ab3c0b';
const LIST = `${API}/v1/groups/${GROUP}/contacts`;

@Component({
  imports: [ContactPerson],
  template: `<fc-contact-person [form]="state.tree.person" groupId="g1" [warnings]="warnings()" />`,
})
class Host {
  readonly state = contactSectionForm();
  readonly warnings = signal<readonly ContactWarning[]>([]);
}

async function render(companyId = '', providers: Provider[] = []) {
  configureContactSection(providers);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  if (companyId !== '') {
    fixture.componentInstance.state.model.update((model) => ({
      ...model,
      person: { ...model.person, associatedCompanyId: companyId },
    }));
  }
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const combobox = () => root.querySelector<HTMLInputElement>('fc-search-combobox input')!;
  const type = async (text: string) => {
    const input = combobox();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await view();
  };
  const read = (id: string) => backend().expectOne(`${LIST}/${id}`);
  return { fixture, host: fixture.componentInstance, root, view, combobox, type, read };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactPerson', () => {
  it('edits the personal data of the form', async () => {
    const { fixture, host, view } = await render();
    const first = findControl(fixture, 'CONTACTS.PERSON.FIRST_NAME');
    first.value = 'Anna';
    first.dispatchEvent(new Event('input'));
    const tax = findControl(fixture, 'CONTACTS.PERSON.TAX_CODE');
    tax.value = 'RSSMRA80A01H501U';
    tax.dispatchEvent(new Event('input'));
    const birth = findControl(fixture, 'CONTACTS.PERSON.BIRTH_DATE');
    birth.value = '1980-01-01';
    birth.dispatchEvent(new Event('input'));
    await view();
    expect(host.state.model().person).toMatchObject({
      firstName: 'Anna',
      taxCode: 'RSSMRA80A01H501U',
      birthDate: '1980-01-01',
    });
    expect(birth.getAttribute('type')).toBe('date');
  });

  it('marks the fields as touched when they lose the focus', async () => {
    const { fixture, host, view } = await render();
    for (const label of ['FIRST_NAME', 'LAST_NAME', 'TAX_CODE', 'BIRTH_DATE', 'DISCOUNT']) {
      findControl(fixture, `CONTACTS.PERSON.${label}`).dispatchEvent(new Event('blur'));
    }
    await view();
    const person = host.state.tree.person;
    expect(
      [
        person.firstName,
        person.lastName,
        person.taxCode,
        person.birthDate,
        person.discountPercent,
      ].map((f) => f().touched()),
    ).toEqual([true, true, true, true, true]);
  });

  it('shows the message of a field, and of the company, under them', async () => {
    const { fixture, host, root, view } = await render();
    host.state.serverError.set('Not valid');
    await view();
    const control = findControl(fixture, 'CONTACTS.PERSON.FIRST_NAME');
    expect(control.getAttribute('aria-describedby')).toContain('error');
    const alert = root.querySelector('fieldset p.problem[role=alert]');
    expect(alert?.textContent?.trim()).toBe('Not valid');
    host.state.serverError.set(null);
    await view();
    expect(root.querySelector('fieldset p.problem')).toBeNull();
  });

  it('lists the phones and the e-mail addresses with their own limits', async () => {
    const { root, view } = await render();
    const add = (text: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === text,
      )!;
    add('CONTACTS.PERSON.ADD_PHONE').click();
    add('CONTACTS.PERSON.ADD_EMAIL').click();
    await view();
    const legends = [...root.querySelectorAll('legend')].map((l) => l.textContent?.trim());
    expect(legends).toEqual(
      expect.arrayContaining([
        'CONTACTS.PERSON.ADDRESS',
        'CONTACTS.PERSON.PHONES',
        'CONTACTS.PERSON.EMAILS',
      ]),
    );
    expect(root.querySelector('input[type=tel]')).not.toBeNull();
    expect(root.querySelector('input[type=email]')).not.toBeNull();
  });

  describe('duplicate tax code', () => {
    it('warns with a link to each other contact', async () => {
      const { host, root, view } = await render();
      expect(root.querySelector('fc-contact-warning-note p')).toBeNull();
      host.warnings.set([
        { field: 'company.vatNumber', issue: 'duplicate', contactIds: [OTHER_ID], others: 0 },
        { field: 'person.taxCode', issue: 'duplicate', contactIds: [OTHER_ID], others: 3 },
      ]);
      await view();
      const notes = [...root.querySelectorAll('fc-contact-warning-note p')];
      expect(notes).toHaveLength(1);
      expect(notes[0]!.textContent).toContain('CONTACTS.WARNING.DUPLICATE');
      expect(notes[0]!.querySelector('a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/contacts/${OTHER_ID}`,
      );
      expect(notes[0]!.textContent).toContain('CONTACTS.WARNING.OTHERS {"count":3}');
    });
  });

  describe('associated company', () => {
    it('shows no company and asks for at least three characters', async () => {
      const { root, combobox, type, view } = await render();
      expect(combobox().value).toBe('');
      expect(root.querySelector('fc-search-combobox button')).toBeNull();
      combobox().dispatchEvent(new Event('focus'));
      await view();
      backend()
        .expectOne((r) => r.url === LIST)
        .flush({ data: [], page: { limit: 25, next: null } });
      await view();
      await type('bi');
      expect(root.querySelector('fc-search-combobox .note')?.textContent).toContain(
        'SEARCH_COMBOBOX.MIN_CHARS {"count":3}',
      );
    });

    it('searches the contacts that have a company name, chooses one and knows its name at once', async () => {
      const { host, root, combobox, type, view } = await render();
      combobox().dispatchEvent(new Event('focus'));
      await view();
      const first = backend().expectOne((r) => r.url === LIST);
      expect(first.request.params.has('q')).toBe(false);
      first.flush({ data: [], page: { limit: 25, next: null } });
      await view();
      await type('bia');
      const req = backend().expectOne((r) => r.url === LIST);
      expect(req.request.params.get('q')).toBe('bia');
      expect(req.request.params.get('limit')).toBe('25');
      req.flush({
        data: [
          { id: COMPANY_ID, company: { name: 'Bianchi Srl', vatNumber: '' } },
          { id: OTHER_ID, company: { name: '', vatNumber: '' } },
        ],
        page: { limit: 25, next: null },
      });
      await view();
      const options = [...root.querySelectorAll<HTMLElement>('fc-search-combobox [role=option]')];
      expect(options.map((o) => o.textContent?.trim())).toEqual(['Bianchi Srl']);
      options[0]!.click();
      await view();
      expect(host.state.model().person.associatedCompanyId).toBe(COMPANY_ID);
      expect(combobox().value).toBe('Bianchi Srl');
      // Clearing the choice empties the field.
      root.querySelector<HTMLButtonElement>('fc-search-combobox button')!.click();
      await view();
      // The field takes the focus back and opens the first options.
      backend()
        .expectOne((r) => r.url === LIST)
        .flush({ data: [], page: { limit: 25, next: null } });
      await view();
      expect(host.state.model().person.associatedCompanyId).toBe('');
      expect(combobox().value).toBe('');
    });

    it('reads the name of a company chosen in another session', async () => {
      const { combobox, read, view } = await render(COMPANY_ID);
      expect(combobox().value).toBe(`…${COMPANY_ID.slice(-6)}`);
      const req = read(COMPANY_ID);
      expect(req.request.method).toBe('GET');
      req.flush(
        { data: { id: COMPANY_ID, displayName: 'Bianchi Srl' } },
        { headers: { ETag: '"1"' } },
      );
      await view();
      expect(combobox().value).toBe('Bianchi Srl');
    });

    it('keeps the short id when the company has no name', async () => {
      const { combobox, read, view } = await render(COMPANY_ID);
      read(COMPANY_ID).flush(
        { data: { id: COMPANY_ID, displayName: null } },
        { headers: { ETag: '"1"' } },
      );
      await view();
      expect(combobox().value).toBe(`…${COMPANY_ID.slice(-6)}`);
    });

    it('keeps the short id and logs only the code when the company cannot be read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { combobox, read, view } = await render(COMPANY_ID);
      read(COMPANY_ID).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await view();
      expect(combobox().value).toBe(`…${COMPANY_ID.slice(-6)}`);
      expect(warn).toHaveBeenCalledWith(
        'Cannot read the name of the associated company',
        'NOT_FOUND',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(COMPANY_ID);
    });

    it('logs a generic code for a failure that is not an API error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { combobox, view } = await render(COMPANY_ID, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(combobox().value).toBe(`…${COMPANY_ID.slice(-6)}`);
      expect(warn).toHaveBeenCalledWith(
        'Cannot read the name of the associated company',
        'unexpected',
      );
    });

    it('reads the name again when the company changes outside the page', async () => {
      const { host, combobox, read, view } = await render(COMPANY_ID);
      read(COMPANY_ID).flush(
        { data: { displayName: 'Bianchi Srl' } },
        { headers: { ETag: '"1"' } },
      );
      await view();
      host.state.model.update((model) => ({
        ...model,
        person: { ...model.person, associatedCompanyId: OTHER_ID },
      }));
      await view();
      read(OTHER_ID).flush({ data: { displayName: 'Verdi Spa' } }, { headers: { ETag: '"1"' } });
      await view();
      expect(combobox().value).toBe('Verdi Spa');
    });

    it('shows the name as text, without a field, when the form is read only', async () => {
      const { host, root, read, view } = await render(COMPANY_ID);
      host.state.readOnly.set(true);
      await view();
      expect(root.querySelector('fc-search-combobox')).toBeNull();
      read(COMPANY_ID).flush(
        { data: { displayName: 'Bianchi Srl' } },
        { headers: { ETag: '"1"' } },
      );
      await view();
      expect(root.querySelector('fieldset:last-of-type p:not(.hint)')?.textContent?.trim()).toBe(
        'Bianchi Srl',
      );
    });

    it('says there is no company when read only and none is set', async () => {
      const { host, root, view } = await render();
      host.state.readOnly.set(true);
      await view();
      expect(root.querySelector('fieldset:last-of-type p:not(.hint)')?.textContent?.trim()).toBe(
        'CONTACTS.NONE',
      );
    });
  });
});
