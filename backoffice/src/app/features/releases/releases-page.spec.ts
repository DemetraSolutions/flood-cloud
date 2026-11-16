import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Route } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { routes } from '../../app.routes';
import { I18nService } from '../../core/i18n/i18n.service';
import { Role } from '../../core/session/session.types';
import { RELEASES, releaseDownloadUrl } from './releases.data';

@Component({ template: 'forbidden' })
class Forbidden {}

/** Finds the route of the application with the given path, whatever its depth. */
function findRoute(list: readonly Route[], path: string): Route | undefined {
  for (const route of list) {
    if (route.path === path) {
      return route;
    }
    const found = findRoute(route.children ?? [], path);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

async function open(role: Role) {
  const releases = findRoute(routes, 'releases') as Route;
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter([releases, { path: 'forbidden', component: Forbidden }]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/releases');
  return harness;
}

describe('ReleasesPage', () => {
  it('is declared with a role guard and a title', () => {
    const route = findRoute(routes, 'releases') as Route;
    expect(route.title).toBe('RELEASES.TITLE');
    expect(route.canMatch).toHaveLength(1);
  });

  it.each(['PSA', 'D'] as const)('shows every release, newest first, to %s', async (role) => {
    const harness = await open(role);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    const versions = [...root.querySelectorAll('article > header > [role=heading]')];
    expect(versions).toHaveLength(RELEASES.length);
    expect(versions.every((v) => v.getAttribute('aria-level') === '2')).toBe(true);
    expect(versions.map((v) => v.id)).toEqual(RELEASES.map((r) => `release-${r.version}`));
    expect(versions[0].id).toBe('release-1.21.0');
  });

  it('links the archives of the downloadable versions only', async () => {
    const harness = await open('PSA');
    const links = [...(harness.routeNativeElement as HTMLElement).querySelectorAll('a.download')];
    const expected = RELEASES.filter((r) => r.downloadable).map((r) =>
      releaseDownloadUrl(r.version),
    );
    expect(links.map((a) => a.getAttribute('href'))).toEqual(expected);
    expect(expected).toHaveLength(8);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it.each(['SA', 'CA', 'PA', 'E'] as const)(
    'refuses %s and sends them to /forbidden',
    async (role) => {
      const harness = await open(role);
      expect(harness.routeNativeElement?.textContent).toContain('forbidden');
      expect(harness.routeNativeElement?.querySelector('h1')).toBeNull();
    },
  );
});
