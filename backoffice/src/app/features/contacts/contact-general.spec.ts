import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, maxLength } from '@angular/forms/signals';
import { provideRouter } from '@angular/router';
import { errorOf, findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactApi } from './contact-api';
import { ContactGeneral } from './contact-general';
import { ContactModel, toModel } from './contact-model';
import { ContactWarning } from './contact.types';

@Component({
  imports: [ContactGeneral],
  template: `<fc-contact-general
    [form]="f"
    groupId="g1"
    [groups]="groups"
    [priceLists]="priceLists"
    [warnings]="warnings()"
  />`,
})
class Host {
  readonly model = signal<ContactModel>({ ...toModel(null), code: 'C-1', notes: 'Note' });
  readonly warnings = signal<readonly ContactWarning[]>([]);
  readonly groups = [{ value: 'cg1', label: 'VIP' }];
  readonly priceLists = [{ value: 'pl1', label: 'Listino 1' }];
  readonly f = form(this.model, (path) => maxLength(path.code, 3));
}

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: ContactApi,
        useValue: { namesUsing: vi.fn().mockResolvedValue({ aaaaaa111111: 'Anna Verdi' }) },
      },
    ],
  });
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

describe('ContactGeneral', () => {
  it('shows the role, the group, the price list, the code and the notes', async () => {
    const { fixture, root } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('CONTACTS.GENERAL.KIND');
    expect((findControl(fixture, 'CONTACTS.GENERAL.CUSTOMER') as HTMLInputElement).checked).toBe(
      true,
    );
    expect((findControl(fixture, 'CONTACTS.GENERAL.SUPPLIER') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(findControl(fixture, 'CONTACTS.GENERAL.CODE').value).toBe('C-1');
    expect(findControl(fixture, 'CONTACTS.GENERAL.NOTES').value).toBe('Note');
    const group = findControl(fixture, 'CONTACTS.GENERAL.GROUP') as HTMLSelectElement;
    expect([...group.options].map((option) => option.textContent?.trim())).toContain('VIP');
    const lists = findControl(fixture, 'CONTACTS.GENERAL.PRICE_LIST') as HTMLSelectElement;
    expect([...lists.options].map((option) => option.textContent?.trim())).toContain('Listino 1');
  });

  it('writes the choices and the text of the user into the form', async () => {
    const { fixture, host } = await render();
    await typeInto(fixture, 'CONTACTS.GENERAL.GROUP', 'cg1');
    await typeInto(fixture, 'CONTACTS.GENERAL.PRICE_LIST', 'pl1');
    await typeInto(fixture, 'CONTACTS.GENERAL.NOTES', 'Altro');
    findControl(fixture, 'CONTACTS.GENERAL.SUPPLIER').click();
    await fixture.whenStable();
    expect(host.model()).toMatchObject({
      contactGroupId: 'cg1',
      priceListId: 'pl1',
      notes: 'Altro',
      supplier: true,
    });
  });

  it('explains the role under its legend, linked to the group', async () => {
    const { root } = await render();
    const hint = root.querySelector('#contact-kind-hint')!;
    expect(hint.textContent).toBe('CONTACTS.GENERAL.KIND_HINT');
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBe(
      'contact-kind-hint',
    );
  });

  it('hints at the warning under the code only when there is one', async () => {
    const { fixture, host, root } = await render();
    expect(root.textContent).not.toContain('CONTACTS.WARNING.FIELD_HINT');
    host.warnings.set([
      { field: 'code', issue: 'duplicate', value: 'C-1', contactIds: [], others: 1 },
    ]);
    await fixture.whenStable();
    expect(root.textContent).toContain('CONTACTS.WARNING.FIELD_HINT');
  });

  it('shows the error of the code once the user touched it', async () => {
    const { fixture } = await render();
    await typeInto(fixture, 'CONTACTS.GENERAL.CODE', 'ABCDE');
    expect(errorOf(fixture, 'CONTACTS.GENERAL.CODE')).toBe('');
    findControl(fixture, 'CONTACTS.GENERAL.CODE').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(errorOf(fixture, 'CONTACTS.GENERAL.CODE')).not.toBe('');
  });

  it('warns about a code other contacts use, and ignores the warnings of other fields', async () => {
    const { fixture, host, root } = await render();
    expect(root.querySelector('[role=status]')).toBeNull();
    host.warnings.set([
      { field: 'person.taxCode', issue: 'duplicate', contactIds: ['x'], others: 0 },
    ]);
    await fixture.whenStable();
    expect(root.querySelector('[role=status]')).toBeNull();
    host.warnings.set([
      { field: 'person.taxCode', issue: 'duplicate', contactIds: ['x'], others: 0 },
      { field: 'code', issue: 'duplicate', value: 'C-1', contactIds: ['aaaaaa111111'], others: 2 },
    ]);
    await fixture.whenStable();
    const note = root.querySelector('[role=status]')!;
    expect(note.textContent).toContain('CONTACTS.WARNING.DUPLICATE');
    expect(note.textContent).toContain('Anna Verdi');
    expect(note.textContent).toContain('CONTACTS.WARNING.OTHERS {"count":2}');
  });

  it('marks every control touched when it loses the focus', async () => {
    const { fixture, root } = await render();
    const controls = root.querySelectorAll('input, select, textarea');
    expect(controls.length).toBeGreaterThan(4);
    controls.forEach((control) => control.dispatchEvent(new Event('blur')));
    await fixture.whenStable();
    expect(root.querySelectorAll('input, select, textarea').length).toBe(controls.length);
  });
});
