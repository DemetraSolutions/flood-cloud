import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { CrossGroupFilterChange, CrossGroupFilters } from './cross-group-filters';

const G1 = '665f1c2e9b1d4a0012ab34a1';
const G2 = '665f1c2e9b1d4a0012ab34a2';
const D1 = '665f1c2e9b1d4a0012ab34d1';

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
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  signIn({ groupId: null, group: null, ...profile });
  const fixture = TestBed.createComponent(Host);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  fixture.detectChanges();
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const answer = async () => {
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups`)
      .flush({
        data: [
          { id: G1, name: 'Alfa' },
          { id: G2, name: 'Beta' },
        ],
        page: { limit: 100, next: null },
      });
    for (const request of backend().match((r) => r.url === `${API}/v1/dealers`)) {
      request.flush({
        data: [{ id: D1, businessName: 'Dealer Uno' }],
        page: { limit: 200, next: null },
      });
    }
    await view();
  };
  const selects = () => [...root.querySelectorAll<HTMLSelectElement>('select')];
  const labels = () => [...root.querySelectorAll('label')].map((l) => l.textContent?.trim());
  return { fixture, view, answer, selects, labels, host: fixture.componentInstance };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CrossGroupFilters', () => {
  it('offers the groups and, to a platform administrator who reads dealers, the dealers', async () => {
    const { answer, selects, labels } = await render({
      role: 'PSA',
      permissions: ['dealers:read'],
    });
    await answer();
    expect(labels()).toEqual(['CROSS_GROUP.FILTER.GROUP', 'CROSS_GROUP.FILTER.DEALER']);
    expect([...selects()[0].options].map((o) => o.textContent?.trim())).toEqual([
      'CROSS_GROUP.FILTER.ALL_GROUPS',
      'Alfa',
      'Beta',
    ]);
    expect([...selects()[1].options].map((o) => o.textContent?.trim())).toEqual([
      'CROSS_GROUP.FILTER.ALL_DEALERS',
      'Dealer Uno',
    ]);
  });

  it.each([
    ['a dealer', { role: 'D' as const, permissions: ['dealers:read'] }],
    ['a platform administrator without dealers:read', { role: 'PSA' as const, permissions: [] }],
  ])('does not offer the dealer filter to %s', async (_name, profile) => {
    const { answer, labels } = await render(profile);
    await answer();
    expect(labels()).toEqual(['CROSS_GROUP.FILTER.GROUP']);
  });

  it('reports the choice of a group or a dealer, and clearing it with an empty value', async () => {
    const { answer, selects, view, host } = await render({
      role: 'PSA',
      permissions: ['dealers:read'],
    });
    await answer();
    const choose = async (index: number, value: string) => {
      selects()[index].value = value;
      selects()[index].dispatchEvent(new Event('change'));
      await view();
    };
    await choose(0, G2);
    await choose(1, D1);
    await choose(0, '');
    expect(host.changes).toEqual([
      { name: 'groupId', value: G2 },
      { name: 'dealerId', value: D1 },
      { name: 'groupId', value: '' },
    ]);
  });

  it('keeps a group or dealer that is in the URL but not in the lists, with its short id', async () => {
    const { answer, selects, host, view } = await render({
      role: 'PSA',
      permissions: ['dealers:read'],
    });
    host.groupId.set('665f1c2e9b1d4a0012ab34ff');
    host.dealerId.set('665f1c2e9b1d4a0012ab34fe');
    await answer();
    await view();
    expect(selects()[0].value).toBe('665f1c2e9b1d4a0012ab34ff');
    expect(selects()[0].selectedOptions[0].textContent?.trim()).toBe('…ab34ff');
    expect(selects()[1].value).toBe('665f1c2e9b1d4a0012ab34fe');
    host.groupId.set(G1);
    host.dealerId.set(D1);
    await view();
    expect(selects()[0].selectedOptions[0].textContent?.trim()).toBe('Alfa');
    expect(selects()[1].selectedOptions[0].textContent?.trim()).toBe('Dealer Uno');
  });
});
