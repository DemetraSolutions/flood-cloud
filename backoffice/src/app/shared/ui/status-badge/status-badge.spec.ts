import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BadgeTone, StatusBadge } from './status-badge';

@Component({
  imports: [StatusBadge],
  template: `<fc-status-badge [tone]="tone()">Attivo</fc-status-badge>`,
})
class Host {
  readonly tone = signal<BadgeTone>('neutral');
}

describe('StatusBadge', () => {
  it('shows the text and, except for neutral, an icon so that color is never the only signal', async () => {
    const fixture = TestBed.createComponent(Host);
    const badge = (fixture.nativeElement as HTMLElement).querySelector('fc-status-badge')!;
    await fixture.whenStable();
    expect(badge.textContent?.trim()).toBe('Attivo');
    expect(badge.getAttribute('data-tone')).toBe('neutral');
    expect(badge.querySelector('svg')).toBeNull();
    for (const tone of ['info', 'success', 'warning', 'danger'] as const) {
      fixture.componentInstance.tone.set(tone);
      await fixture.whenStable();
      expect(badge.getAttribute('data-tone')).toBe(tone);
      expect(badge.querySelector('svg')).not.toBeNull();
      expect(badge.textContent?.trim()).toBe('Attivo');
    }
  });
});
