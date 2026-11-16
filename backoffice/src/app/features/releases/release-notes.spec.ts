import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReleaseNotes } from './release-notes';
import { Release } from './releases.data';

const FULL: Release = {
  version: '1.19.0',
  date: '2026-03-20',
  hotfix: { number: 7, date: '2026-06-09' },
  downloadable: true,
  features: ['Prima novità', 'Seconda novità'],
  fixes: ['Una correzione'],
  notes: ['Prima nota', 'Seconda nota'],
};

async function render(release: Release, level?: number) {
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(ReleaseNotes);
  fixture.componentRef.setInput('release', release);
  if (level !== undefined) {
    fixture.componentRef.setInput('level', level);
  }
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('ReleaseNotes', () => {
  it('shows version, long dates, hotfix, lists and notices', async () => {
    const root = await render(FULL);
    const article = root.querySelector('article') as HTMLElement;
    const heading = root.querySelector('[role=heading]') as HTMLElement;
    expect(article.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.id).toBe('release-1.19.0');
    expect(heading.textContent).toContain('RELEASES.VERSION {"version":"1.19.0"}');
    expect(heading.getAttribute('aria-level')).toBe('2');
    const times = [...root.querySelectorAll('time')];
    expect(times[0].getAttribute('datetime')).toBe('2026-03-20');
    expect(times[0].textContent).toBe('20 marzo 2026');
    expect(times[1].getAttribute('datetime')).toBe('2026-06-09');
    expect(times[1].textContent).toContain('"number":7,"date":"9 giugno 2026"');
    const sections = [...root.querySelectorAll('section')];
    expect(sections.map((s) => s.querySelector('[role=heading]')?.textContent?.trim())).toEqual([
      'RELEASES.NOTES',
      'RELEASES.FEATURES',
      'RELEASES.FIXES',
    ]);
    for (const section of sections) {
      const title = section.querySelector('[role=heading]') as HTMLElement;
      expect(section.getAttribute('aria-labelledby')).toBe(title.id);
      expect(title.getAttribute('aria-level')).toBe('3');
    }
    expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Prima novità',
      'Seconda novità',
      'Una correzione',
    ]);
    expect([...root.querySelectorAll('.notes p')].map((p) => p.textContent)).toEqual([
      'Prima nota',
      'Seconda nota',
    ]);
  });

  it('links the archive on the external site, in a new tab, announced as such', async () => {
    const root = await render(FULL);
    const link = root.querySelector('a.download') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      'https://www.demetrasolutions.com/APPS/RELEASES/Flood_1.19.0.zip',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('RELEASES.DOWNLOAD {"version":"1.19.0"}');
    expect(link.querySelector('.visually-hidden')?.textContent).toBe('RELEASES.NEW_TAB');
  });

  it('honours the heading level', async () => {
    const root = await render(FULL, 3);
    expect(root.querySelector('[role=heading]')?.getAttribute('aria-level')).toBe('3');
    expect(root.querySelector('section [role=heading]')?.getAttribute('aria-level')).toBe('4');
  });

  it('omits what a release does not have: link, dates, hotfix, notices and empty lists', async () => {
    const root = await render({
      version: '0.1.0-beta-3',
      date: null,
      downloadable: false,
      features: [],
      fixes: ['Solo correzione'],
    });
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('time')).toBeNull();
    expect(root.querySelector('.notes')).toBeNull();
    expect(root.querySelectorAll('section')).toHaveLength(1);
    expect(root.querySelector('section [role=heading]')?.textContent).toContain('RELEASES.FIXES');
  });

  it('shows the features alone when there are no fixes', async () => {
    const root = await render({
      version: '1.17.1',
      date: '2025-02-05',
      downloadable: true,
      features: ['Piccole fix varie'],
      fixes: [],
    });
    expect(root.querySelectorAll('section')).toHaveLength(1);
    expect(root.querySelectorAll('time')).toHaveLength(1);
  });
});
