import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ActivityDetail } from './activity-detail';
import { fakeEntry } from '../../../testing/activity';
import { ActivityEntry } from './activity-log.types';

function render(entry: ActivityEntry) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(ActivityDetail);
  fixture.componentRef.setInput('entry', entry);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

afterEach(() => vi.restoreAllMocks());

describe('ActivityDetail', () => {
  it('shows the general data of an entry', () => {
    const root = render(fakeEntry());
    const text = root.textContent ?? '';
    expect(text).toContain('mario');
    expect(text).toContain('ROLE_SHORT.SA');
    expect(text).toContain('ACTIVITY.ACTION.USER_UPDATED');
    expect(text).toContain('ACTIVITY.CATEGORY.DATA');
    expect(text).toContain('ACTIVITY.OUTCOME.SUCCESS');
    expect(text).toContain('665f1c2e9b1d4a0012ab34a1');
    expect(text).toContain('user 665f1c2e9b1d4a0012ab3401');
    expect(text).toContain('req-1');
    expect(text).toContain('10.0.0.1');
    expect(text).toMatch(/2026/);
    expect(root.querySelector('table')).toBeNull();
    expect(root.querySelector('pre')).toBeNull();
  });

  it('omits what the entry does not have and names non-user actors', () => {
    const root = render(
      fakeEntry({
        action: 'unknown.action',
        actor: { kind: 'system', id: null, role: null, username: null },
        groupId: null,
        resource: { type: 'session' },
        requestId: null,
        ip: null,
      }),
    );
    const text = root.textContent ?? '';
    expect(text).toContain('unknown.action');
    expect(text).toContain('ACTIVITY.ACTOR.SYSTEM');
    expect(text).not.toContain('ACTIVITY.COLUMN.GROUP');
    expect(text).not.toContain('ACTIVITY.COLUMN.REQUEST_ID');
    expect(text).not.toContain('ACTIVITY.DETAIL.IP');
    expect(root.querySelector('.muted')).toBeNull();
    expect(root.querySelector('dd.code')?.textContent?.trim()).toBe('session');
  });

  it('names a user actor without username by its id, or by nothing', () => {
    expect(
      render(fakeEntry({ actor: { kind: 'user', id: 'abc', role: null, username: null } }))
        .textContent,
    ).toContain('abc');
    TestBed.resetTestingModule();
    const root = render(
      fakeEntry({ actor: { kind: 'user', id: null, role: null, username: null }, resource: null }),
    );
    expect(root.querySelector('dd')?.nextElementSibling).not.toBeNull();
  });

  it('shows only the role of a hidden actor', () => {
    const root = render(
      fakeEntry({ actor: { kind: 'user', id: null, role: 'PSA', username: null }, ip: null }),
    );
    expect(root.textContent).toContain('ROLE.PSA');
    expect(root.querySelector('.muted')).toBeNull();
  });

  it('shows the changes with redacted values as "oscurato"', () => {
    const root = render(
      fakeEntry({
        changes: [
          { field: 'status', before: 'active', after: 'disabled' },
          { field: 'role', after: 'CA' },
          { field: 'password', redacted: true },
          { field: 'companyIds', before: ['a'], after: ['a', 'b'] },
        ],
      }),
    );
    const rows = [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['status', 'active', 'disabled'],
      ['role', '', 'CA'],
      ['password', 'ACTIVITY.REDACTED', 'ACTIVITY.REDACTED'],
      ['companyIds', '["a"]', '["a","b"]'],
    ]);
  });

  it('shows the metadata', () => {
    const root = render(fakeEntry({ metadata: { reason: 'bad', count: 3 } }));
    const text = root.textContent ?? '';
    expect(text).toContain('ACTIVITY.DETAIL.METADATA');
    expect(text).toContain('reason');
    expect(text).toContain('bad');
    expect(text).toContain('3');
  });

  it('shows a client error with the stack as plain text', () => {
    const stack = 'TypeError: x\n    at <img src=x onerror=alert(1)>';
    const root = render(
      fakeEntry({
        category: 'error',
        action: 'client.error',
        error: { name: 'TypeError', message: 'x is undefined', stack },
      }),
    );
    expect(root.querySelector('pre')?.textContent).toBe(stack);
    expect(root.querySelector('pre img')).toBeNull();
    expect(root.textContent).toContain('x is undefined');
  });

  it('shows an error without stack', () => {
    const root = render(fakeEntry({ error: { name: 'Error', message: 'm', stack: null } }));
    expect(root.textContent).toContain('ACTIVITY.DETAIL.ERROR_NAME');
    expect(root.querySelector('pre')).toBeNull();
  });
});
