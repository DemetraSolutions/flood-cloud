import { TestBed } from '@angular/core/testing';
import { ElementCount } from './group.types';
import { GroupCount } from './group-count';
import { I18nService } from '../../core/i18n/i18n.service';

function render(count: ElementCount) {
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(GroupCount);
  fixture.componentRef.setInput('count', count);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('GroupCount', () => {
  it('shows only the active number when nothing is in the trash', () => {
    const el = render({ active: 2, trashed: 0 });
    expect(el.querySelector('.active')?.textContent).toBe('2');
    expect(el.querySelector('.trashed')).toBeNull();
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe('GROUPS.COUNT.LABEL {"active":2,"trashed":0}');
  });

  it('adds the secondary note and the full label when some are trashed', () => {
    const el = render({ active: 2, trashed: 1 });
    expect(el.querySelector('.trashed')?.textContent?.trim()).toBe(
      'GROUPS.COUNT.TRASHED {"count":1}',
    );
    expect(el.getAttribute('aria-label')).toBe(
      'GROUPS.COUNT.LABEL_TRASHED {"active":2,"trashed":1}',
    );
  });
});
