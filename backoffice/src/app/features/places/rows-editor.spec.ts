import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { applyEach, disabled, form, required, validate } from '@angular/forms/signals';
import { findControl } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

interface Row {
  name: string;
  on: boolean;
  kind: string;
  free: string;
  amount: string;
  at: string;
  days: number[];
}

const row = (overrides: Partial<Row> = {}): Row => ({
  name: 'Uno',
  on: true,
  kind: 'b',
  free: 'x',
  amount: '2.5',
  at: '10:00',
  days: [1],
  ...overrides,
});

const COLUMNS: RowColumn[] = [
  { key: 'name', type: 'text', label: 'Nome' },
  { key: 'on', type: 'flag', label: 'Attivo' },
  {
    key: 'kind',
    type: 'select',
    label: 'Tipo',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
  { key: 'free', type: 'select', label: 'Libero' },
  { key: 'amount', type: 'number', label: 'Importo' },
  { key: 'at', type: 'time', label: 'Ora' },
  { key: 'days', type: 'days', label: 'Giorni' },
];

const canWrite = signal(true);
const locked = signal(false);

@Component({
  selector: 'fc-rows-host',
  imports: [RowsEditor],
  template: `<fc-rows-editor
    [rows]="form.rows"
    [columns]="columns"
    legend="Righe"
    addLabel="Aggiungi"
    [max]="max()"
    (add)="added = added + 1"
    (remove)="removed.push($event)"
  />`,
})
class Host {
  readonly columns = COLUMNS;
  readonly max = signal(3);
  added = 0;
  readonly removed: number[] = [];
  readonly model = signal<{ rows: Row[] }>({ rows: [row()] });
  readonly form = form(this.model, (path) => {
    validate(path.rows, (ctx) => (ctx.value().length === 0 ? { kind: 'empty' } : undefined));
    applyEach(path.rows, (item) => {
      required(item.name);
      disabled(item.days, { when: () => locked() });
    });
  });
}

async function setup(rows: Row[] = [row()]) {
  canWrite.set(true);
  locked.set(false);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: PlaceState,
        useValue: {
          canWrite,
          fieldError: (field: () => { errors(): unknown[] }) =>
            field().errors().length > 0 ? 'PROBLEM' : null,
        },
      },
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.model.set({ rows });
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  return { fixture, host: fixture.componentInstance, root, buttons };
}

afterEach(() => vi.restoreAllMocks());

describe('RowsEditor', () => {
  it('shows one control per column and row, labelled with the row number', async () => {
    const { fixture, root } = await setup([row(), row({ name: 'Due' })]);
    expect(root.querySelector('legend')?.textContent).toBe('Righe');
    const name = findControl(fixture, 'Nome 2') as HTMLInputElement;
    expect(name.value).toBe('Due');
    expect(name.type).toBe('text');
    expect(name.getAttribute('inputmode')).toBeNull();
    const amount = findControl(fixture, 'Importo 1') as HTMLInputElement;
    expect(amount.type).toBe('number');
    expect(amount.getAttribute('inputmode')).toBe('decimal');
    expect((findControl(fixture, 'Ora 1') as HTMLInputElement).type).toBe('time');
    expect((findControl(fixture, 'Attivo 1') as HTMLInputElement).checked).toBe(true);
    expect((findControl(fixture, 'Tipo 1') as HTMLSelectElement).value).toBe('b');
    expect(root.querySelector('fieldset.days legend')?.textContent).toBe('Giorni 1');
    expect((findControl(fixture, 'PLACES.DAY.1') as HTMLInputElement).checked).toBe(true);
    expect((findControl(fixture, 'PLACES.DAY.2') as HTMLInputElement).checked).toBe(false);
  });

  it('writes what the user types, picks and checks into the form', async () => {
    const { fixture, host } = await setup();
    const name = findControl(fixture, 'Nome 1');
    name.value = 'Nuovo';
    name.dispatchEvent(new Event('input'));
    const kind = findControl(fixture, 'Tipo 1');
    kind.value = 'a';
    kind.dispatchEvent(new Event('change'));
    const on = findControl(fixture, 'Attivo 1') as HTMLInputElement;
    on.checked = false;
    on.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(host.model().rows[0]).toMatchObject({ name: 'Nuovo', kind: 'a', on: false });
  });

  it('marks a cell as touched when its control loses the focus', async () => {
    const { fixture, host } = await setup();
    const cells = { name: 'Nome 1', on: 'Attivo 1', kind: 'Tipo 1' } as const;
    for (const [key, label] of Object.entries(cells)) {
      expect(host.form.rows[0][key as keyof typeof cells]().touched()).toBe(false);
      findControl(fixture, label).dispatchEvent(new Event('blur'));
    }
    await fixture.whenStable();
    for (const key of Object.keys(cells)) {
      expect(host.form.rows[0][key as keyof typeof cells]().touched()).toBe(true);
    }
  });

  it('keeps a stored value that is not among the options', async () => {
    const { fixture } = await setup([row({ kind: 'old' }), row({ kind: '' })]);
    const options = (label: string) =>
      [...(findControl(fixture, label) as HTMLSelectElement).options].map((o) => o.value);
    expect(options('Tipo 1')).toEqual(['a', 'b', 'old']);
    expect((findControl(fixture, 'Tipo 1') as HTMLSelectElement).value).toBe('old');
    expect(options('Tipo 2')).toEqual(['a', 'b']);
  });

  it('lists only the stored value for a select without options', async () => {
    const { fixture } = await setup([row({ free: 'x' })]);
    const select = findControl(fixture, 'Libero 1') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['x']);
  });

  it('adds the days in order and removes them', async () => {
    const { fixture, host } = await setup();
    const toggle = async (day: number, checked: boolean) => {
      const box = findControl(fixture, `PLACES.DAY.${day}`) as HTMLInputElement;
      box.checked = checked;
      box.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    await toggle(0, true);
    expect(host.model().rows[0].days).toEqual([0, 1]);
    await toggle(5, true);
    await toggle(3, true);
    expect(host.model().rows[0].days).toEqual([0, 1, 3, 5]);
    await toggle(1, false);
    expect(host.model().rows[0].days).toEqual([0, 3, 5]);
    await toggle(3, true);
    expect(host.model().rows[0].days).toEqual([0, 3, 5]);
    expect((findControl(fixture, 'PLACES.DAY.3') as HTMLInputElement).checked).toBe(true);
    expect((findControl(fixture, 'PLACES.DAY.1') as HTMLInputElement).checked).toBe(false);
  });

  it('emits add, which stops at the maximum', async () => {
    const { fixture, host, buttons } = await setup([row(), row()]);
    const add = () => buttons().find((b) => b.textContent?.trim() === 'Aggiungi')!;
    expect(add().disabled).toBe(false);
    add().click();
    expect(host.added).toBe(1);
    host.max.set(2);
    await fixture.whenStable();
    expect(add().disabled).toBe(true);
    host.max.set(1);
    await fixture.whenStable();
    expect(add().disabled).toBe(true);
  });

  it('emits the index of the row to remove, with an accessible name', async () => {
    const { host, buttons } = await setup([row(), row({ name: 'Due' })]);
    const remove = buttons().filter((b) => b.textContent?.trim() === 'PLACES.REMOVE');
    expect(remove).toHaveLength(2);
    expect(remove[1].getAttribute('aria-label')).toBe(
      'PLACES.REMOVE_ROW {"legend":"Righe","number":2}',
    );
    remove[1].click();
    remove[0].click();
    expect(host.removed).toEqual([1, 0]);
  });

  it('shows the problem of the whole list and of a row', async () => {
    const { fixture, host, root } = await setup([row({ name: '' })]);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain('PROBLEM');
    host.model.set({ rows: [] });
    await fixture.whenStable();
    expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe('PROBLEM');
  });

  it('has no add and remove buttons and disabled days for a user who cannot write', async () => {
    const { fixture, root, buttons } = await setup();
    canWrite.set(false);
    locked.set(true);
    await fixture.whenStable();
    expect(buttons()).toHaveLength(0);
    expect((findControl(fixture, 'PLACES.DAY.1') as HTMLInputElement).disabled).toBe(true);
    expect(root.querySelector('.row-actions')).toBeNull();
  });
});
