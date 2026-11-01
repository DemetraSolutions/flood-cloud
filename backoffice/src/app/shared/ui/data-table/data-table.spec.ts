import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { DataTable } from './data-table';
import { TableColumn, TableSort } from './data-table.types';
import { CellTemplate, RowActionsTemplate } from './table-templates';

interface Row {
  id: string;
  name: string;
  qty: number;
}

const ROWS: Row[] = [
  { id: '1', name: 'Alfa', qty: 3 },
  { id: '2', name: 'Beta', qty: 5 },
];

@Component({
  imports: [DataTable, CellTemplate, RowActionsTemplate],
  template: `<fc-data-table
    caption="Prodotti"
    [columns]="columns"
    [rows]="rows()"
    [rowKey]="rowKey"
    [loading]="loading()"
    [sort]="sort()"
    rowHeader="name"
    [emptyTitle]="emptyTitle()"
    [emptyMessage]="emptyMessage()"
    (sortChange)="sorts.push($event)"
  >
    @if (custom()) {
      <ng-template fcCell="qty" let-row
        ><strong>{{ row.qty }} pz</strong></ng-template
      >
      <ng-template fcRowActions let-row
        ><button type="button">Modifica {{ row.name }}</button></ng-template
      >
    }
    <button fcEmptyAction type="button">Crea</button>
  </fc-data-table>`,
})
class Host {
  readonly columns: TableColumn<Row>[] = [
    { key: 'name', header: 'Nome', cell: (r) => r.name, sortable: true },
    { key: 'qty', header: 'Quantità', cell: (r) => String(r.qty), sortable: true, align: 'end' },
    { key: 'note', header: 'Note' },
  ];
  readonly rows = signal<Row[]>(ROWS);
  readonly loading = signal(false);
  readonly sort = signal<TableSort | null>(null);
  readonly custom = signal(false);
  readonly emptyTitle = signal<string | null>(null);
  readonly emptyMessage = signal<string | null>(null);
  readonly sorts: TableSort[] = [];
  readonly rowKey = (row: Row) => row.id;
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const settle = () => fixture.whenStable();
  return { fixture, host: fixture.componentInstance, root, settle };
}

describe('DataTable', () => {
  it('renders a named table with column headers, a row header and plain cells', async () => {
    const { root } = await render();
    expect(root.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Prodotti');
    expect(root.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0');
    expect(root.querySelector('caption')?.textContent?.trim()).toBe('Prodotti');
    const headers = [...root.querySelectorAll('thead th')];
    expect(headers.map((h) => h.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    const firstRow = root.querySelector('tbody tr')!;
    expect(firstRow.querySelector('th')?.getAttribute('scope')).toBe('row');
    expect(firstRow.querySelector('th')?.textContent?.trim()).toBe('Alfa');
    const cells = [...firstRow.querySelectorAll('td')];
    expect(cells[0].textContent?.trim()).toBe('3');
    expect(cells[0].getAttribute('data-align')).toBe('end');
    expect(cells[1].textContent?.trim()).toBe('');
    expect(root.querySelectorAll('tbody tr').length).toBe(2);
    expect(root.querySelector('table')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('puts a sort button only in sortable headers and reflects the sort in aria-sort', async () => {
    const { host, root, settle } = await render();
    const headers = () => [...root.querySelectorAll('thead th')];
    expect(headers().map((h) => !!h.querySelector('button'))).toEqual([true, true, false]);
    expect(headers().every((h) => !h.hasAttribute('aria-sort'))).toBe(true);

    host.sort.set({ key: 'name', direction: 'asc' });
    await settle();
    expect(headers()[0].getAttribute('aria-sort')).toBe('ascending');
    expect(headers()[1].hasAttribute('aria-sort')).toBe(false);

    host.sort.set({ key: 'name', direction: 'desc' });
    await settle();
    expect(headers()[0].getAttribute('aria-sort')).toBe('descending');
  });

  it('emits asc for a new column, then toggles direction', async () => {
    const { host, root, settle } = await render();
    const buttons = root.querySelectorAll<HTMLButtonElement>('thead button');
    buttons[1].click();
    host.sort.set({ key: 'qty', direction: 'asc' });
    await settle();
    buttons[1].click();
    host.sort.set({ key: 'qty', direction: 'desc' });
    await settle();
    buttons[1].click();
    expect(host.sorts).toEqual([
      { key: 'qty', direction: 'asc' },
      { key: 'qty', direction: 'desc' },
      { key: 'qty', direction: 'asc' },
    ]);
  });

  it('renders custom cells and row actions from templates', async () => {
    const { host, root, settle } = await render();
    host.custom.set(true);
    await settle();
    const firstRow = root.querySelector('tbody tr')!;
    expect(firstRow.querySelector('strong')?.textContent).toBe('3 pz');
    expect(firstRow.querySelector('td.actions button')?.textContent).toBe('Modifica Alfa');
    const lastHeader = [...root.querySelectorAll('thead th')].at(-1)!;
    expect(lastHeader.querySelector('.visually-hidden')?.textContent).toBe('[COMMON.ACTIONS]');
    expect(root.querySelector('td.actions')).not.toBeNull();
  });

  it('shows a busy skeleton while loading', async () => {
    const { host, root, settle } = await render();
    host.loading.set(true);
    await settle();
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('tbody fc-skeleton')).not.toBeNull();
    expect(root.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('shows the empty state with default texts and the projected action', async () => {
    const { host, root, settle } = await render();
    host.rows.set([]);
    await settle();
    expect(root.querySelector('tbody td')?.getAttribute('colspan')).toBe('3');
    expect(root.querySelector('.title')?.textContent).toBe('[TABLE.EMPTY.TITLE]');
    expect(root.querySelector('.message')?.textContent).toBe('[TABLE.EMPTY.MESSAGE]');
    expect(root.querySelector('tbody button')?.textContent).toBe('Crea');
  });

  it('uses custom empty texts and counts the actions column in the colspan', async () => {
    const { host, root, settle } = await render();
    host.custom.set(true);
    host.rows.set([]);
    host.emptyTitle.set('Nessun prodotto');
    host.emptyMessage.set('Aggiungine uno');
    await settle();
    expect(root.querySelector('.title')?.textContent).toBe('Nessun prodotto');
    expect(root.querySelector('.message')?.textContent).toBe('Aggiungine uno');
    expect(root.querySelector('tbody td')?.getAttribute('colspan')).toBe('4');
  });
});
