import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { Role } from '../../core/session/session.types';
import { RELEASES } from '../releases/releases.data';
import { Home } from './home';

async function render(role: Role | null) {
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  if (role !== null) {
    signIn({ role });
  }
  const fixture = TestBed.createComponent(Home);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('Home', () => {
  it.each(['PSA', 'D'] as const)('shows the latest release to %s', async (role) => {
    const root = await render(role);
    expect(root.querySelector('h1')?.textContent).toBe('HOME.TITLE');
    expect(root.querySelector('h2')?.textContent).toBe('RELEASES.LATEST');
    const cards = root.querySelectorAll('fc-release-notes');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('[role=heading]')?.id).toBe(`release-${RELEASES[0].version}`);
    expect(cards[0].querySelector('[role=heading]')?.getAttribute('aria-level')).toBe('3');
    expect(cards[0].querySelectorAll('li')).toHaveLength(
      RELEASES[0].features.length + RELEASES[0].fixes.length,
    );
    expect(root.querySelector('a[href="/releases"]')?.textContent).toBe('RELEASES.ALL');
  });

  it.each(['SA', 'CA', 'PA', 'E', null] as const)('shows no release to %s', async (role) => {
    const root = await render(role);
    expect(root.querySelector('h1')?.textContent).toBe('HOME.TITLE');
    expect(root.querySelector('fc-latest-release')).toBeNull();
    expect(root.textContent).not.toContain('RELEASES');
  });
});
