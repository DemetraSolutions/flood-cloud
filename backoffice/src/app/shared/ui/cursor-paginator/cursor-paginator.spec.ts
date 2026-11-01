import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { CursorPaginator } from './cursor-paginator';

@Component({
  imports: [CursorPaginator],
  template: `<fc-cursor-paginator
    [limit]="limit()"
    [nextCursor]="next()"
    [hasPrevious]="hasPrevious()"
    [loading]="loading()"
    (previousPage)="events.push('previous')"
    (nextPage)="events.push('next:' + $event)"
    (limitChange)="events.push('limit:' + $event)"
  />`,
})
class Host {
  readonly limit = signal(25);
  readonly next = signal<string | null>('abc');
  readonly hasPrevious = signal(true);
  readonly loading = signal(false);
  readonly events: string[] = [];
}

async function render() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const buttons = () => root.querySelectorAll<HTMLButtonElement>('button');
  return { fixture, host: fixture.componentInstance, root, buttons };
}

describe('CursorPaginator', () => {
  it('is a labelled navigation without page numbers', async () => {
    const { root, buttons } = await render();
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe('[PAGINATION.LABEL]');
    expect(buttons()[0].textContent).toContain('[PAGINATION.PREVIOUS]');
    expect(buttons()[1].textContent).toContain('[PAGINATION.NEXT]');
    expect(root.querySelector('select')?.value).toBe('25');
    expect([...root.querySelectorAll('option')].map((o) => o.value)).toEqual([
      '10',
      '25',
      '50',
      '100',
    ]);
  });

  it('emits previous, next with the cursor and limit changes', async () => {
    const { host, root, buttons } = await render();
    buttons()[0].click();
    buttons()[1].click();
    const select = root.querySelector('select')!;
    select.value = '50';
    select.dispatchEvent(new Event('change'));
    expect(host.events).toEqual(['previous', 'next:abc', 'limit:50']);
  });

  it('disables previous without history and next on the last page', async () => {
    const { fixture, host, buttons } = await render();
    host.hasPrevious.set(false);
    host.next.set(null);
    await fixture.whenStable();
    expect(buttons()[0].disabled).toBe(true);
    expect(buttons()[1].disabled).toBe(true);
  });

  it('disables everything while loading', async () => {
    const { fixture, host, root, buttons } = await render();
    host.loading.set(true);
    await fixture.whenStable();
    expect(buttons()[0].disabled).toBe(true);
    expect(buttons()[1].disabled).toBe(true);
    expect(root.querySelector('select')?.disabled).toBe(true);
  });
});
