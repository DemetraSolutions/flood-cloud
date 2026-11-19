import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { CrossGroupFilterChange, CrossGroupFilters } from './cross-group-filters';

const G1 = '665f1c2e9b1d4a0012ab34a1';
const G2 = '665f1c2e9b1d4a0012ab34a2';
const D1 = '665f1c2e9b1d4a0012ab34d1';
const GROUPS = `${API}/v1/groups`;

@Component({
  imports: [CrossGroupFilters],
  template: `<fc-cross-group-filters
    [groupId]="groupId()"
    [dealerId]="dealerId()"
    (filterChange)="changes.push($event)"
  />`,
})
class Host {
  readonly groupId = signal<string | undefined>(undefined);
  readonly dealerId = signal<string | undefined>(undefined);
  readonly changes: CrossGroupFilterChange[] = [];
}

async function render(profile: Partial<Profile>) {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ groupId: null, group: null, ...profile });
  const fixture = TestBed.createComponent(Host);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  fixture.detectChanges();
  await view();
  const input = () => root.querySelector<HTMLInputElement>('input[role=combobox]')!;
  const options = () => [...root.querySelectorAll<HTMLElement>('[role=option]')];
  const dealers = async () => {
    for (const request of backend().match((r) => r.url === `${API}/v1/dealers`)) {
      request.flush({
        data: [{ id: D1, businessName: 'Dealer Uno' }],
        page: { limit: 200, next: null },
      });
    }
    await view();
  };
  /** Opens the group list and answers the search (the first groups, or the ones matching). */
  const open = async (data: { id: string; name: string }[] = [{ id: G1, name: 'Alfa' }]) => {
    input().dispatchEvent(new Event('focus'));
    await view();
    backend()
      .expectOne((r) => r.url === GROUPS)
      .flush({ data, page: { limit: 20, next: null } });
    await view();
  };
  return { host: fixture.componentInstance, root, view, input, options, dealers, open };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  backend().verify();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CrossGroupFilters', () => {
  it('searches the groups on the server: the first 20 by name on opening, then the typed text', async () => {
    const { input, options, view, host, dealers } = await render({
      role: 'PSA',
      permissions: ['dealers:read'],
    });
    await dealers();
    input().dispatchEvent(new Event('focus'));
    await view();
    const first = backend().expectOne((r) => r.url === GROUPS);
    expect(first.request.params.keys().sort()).toEqual(['limit', 'sort']);
    expect(first.request.params.get('limit')).toBe('20');
    expect(first.request.params.get('sort')).toBe('name');
    first.flush({ data: [{ id: G1, name: 'Alfa' }], page: { limit: 20, next: null } });
    await view();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Alfa']);
    input().value = 'be';
    input().dispatchEvent(new Event('input'));
    await view(250);
    const typed = backend().expectOne((r) => r.url === GROUPS);
    expect(typed.request.params.get('q')).toBe('be');
    expect(typed.request.params.has('dealerId')).toBe(false);
    typed.flush({ data: [{ id: G2, name: 'Beta' }], page: { limit: 20, next: null } });
    await view();
    options()[0].click();
    await view();
    expect(host.changes).toEqual([{ name: 'groupId', value: G2 }]);
  });

  it('keeps the name of the group chosen here without reading it again, and clears it', async () => {
    const { input, open, host, view, root } = await render({ role: 'D', permissions: [] });
    await open();
    root.querySelector<HTMLElement>('[role=option]')!.click();
    host.groupId.set(G1);
    await view();
    expect(input().value).toBe('Alfa');
    root
      .querySelector<HTMLButtonElement>('button[title="CROSS_GROUP.FILTER.CLEAR_GROUP"]')!
      .click();
    host.groupId.set(undefined);
    await view();
    // Clearing keeps the focus in the field, which opens the list again.
    backend()
      .expectOne((r) => r.url === GROUPS)
      .flush({ data: [], page: { limit: 20, next: null } });
    await view();
    expect(host.changes).toEqual([
      { name: 'groupId', value: G1 },
      { name: 'groupId', value: '' },
    ]);
  });

  it('reads the name of a group that comes from the URL, and shows its short id until then', async () => {
    const { host, input, view } = await render({ role: 'PSA', permissions: [] });
    host.groupId.set(G2);
    await view();
    expect(input().value).toBe('');
    backend()
      .expectOne(`${GROUPS}/${G2}`)
      .flush({ data: { name: 'Beta' } });
    await view();
    expect(input().value).toBe('Beta');
    host.groupId.set(G1);
    await view();
    backend()
      .expectOne(`${GROUPS}/${G1}`)
      .flush({ data: { name: '' } });
    await view();
    expect(input().value).toBe('…ab34a1');
  });

  it('shows the short id when the group cannot be read', async () => {
    const { host, input, view } = await render({ role: 'PSA', permissions: [] });
    host.groupId.set(G2);
    await view();
    backend()
      .expectOne(`${GROUPS}/${G2}`)
      .flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(input().value).toBe('…ab34a2');
  });

  it('offers the dealer filter only to a platform administrator who reads dealers', async () => {
    const { root, dealers } = await render({ role: 'PSA', permissions: ['dealers:read'] });
    await dealers();
    expect(root.querySelectorAll('select')).toHaveLength(1);
    expect([...root.querySelectorAll('option')].map((o) => o.textContent?.trim())).toEqual([
      'CROSS_GROUP.FILTER.ALL_DEALERS',
      'Dealer Uno',
    ]);
  });

  it.each([
    ['a dealer', { role: 'D' as const, permissions: ['dealers:read'] }],
    ['a platform administrator without dealers:read', { role: 'PSA' as const, permissions: [] }],
  ])('does not offer the dealer filter to %s', async (_name, profile) => {
    const { root } = await render(profile);
    expect(root.querySelectorAll('select')).toHaveLength(0);
  });

  it('reports the choice of a dealer, and a dealer that is in the URL but not in the list', async () => {
    const { root, host, view, dealers } = await render({
      role: 'PSA',
      permissions: ['dealers:read'],
    });
    host.dealerId.set('665f1c2e9b1d4a0012ab34fe');
    await dealers();
    const select = root.querySelector<HTMLSelectElement>('select')!;
    expect(select.selectedOptions[0].textContent?.trim()).toBe('…ab34fe');
    select.value = D1;
    select.dispatchEvent(new Event('change'));
    await view();
    expect(host.changes).toEqual([{ name: 'dealerId', value: D1 }]);
    host.dealerId.set(D1);
    await view();
    expect(select.selectedOptions[0].textContent?.trim()).toBe('Dealer Uno');
  });
});
