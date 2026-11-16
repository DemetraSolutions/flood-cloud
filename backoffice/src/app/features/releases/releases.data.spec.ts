import { RELEASES, RELEASES_DOWNLOAD_BASE_URL, releaseDownloadUrl } from './releases.data';

/** Orders versions like semver: numeric core first, a pre-release before its final version. */
function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split(/-(.*)/s);
  const [coreB, preB] = b.split(/-(.*)/s);
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] !== partsB[i]) {
      return partsA[i] - partsB[i];
    }
  }
  return (preA === undefined ? 1 : 0) - (preB === undefined ? 1 : 0);
}

function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().startsWith(value);
}

describe('RELEASES', () => {
  it('has unique, well-formed versions', () => {
    const versions = RELEASES.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const version of versions) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9-]+)?$/);
    }
  });

  it('is sorted newest first, from 1.21.0 down to the first beta', () => {
    const versions = RELEASES.map((release) => release.version);
    expect(versions[0]).toBe('1.21.0');
    expect(versions.at(-1)).toBe('0.1.0-beta-3');
    expect(versions).toHaveLength(33);
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThan(0);
    }
  });

  it('has valid dates, never later for an older version, and hotfixes after the release', () => {
    const dated = RELEASES.filter((release) => release.date !== null);
    for (const release of RELEASES) {
      if (release.date !== null) {
        expect(isIsoDay(release.date)).toBe(true);
      }
      if (release.hotfix !== undefined) {
        expect(Number.isInteger(release.hotfix.number)).toBe(true);
        expect(isIsoDay(release.hotfix.date)).toBe(true);
        expect(release.date).not.toBeNull();
        expect(release.hotfix.date >= (release.date as string)).toBe(true);
      }
    }
    for (let i = 1; i < dated.length; i++) {
      expect((dated[i - 1].date as string) >= (dated[i].date as string)).toBe(true);
    }
    expect(RELEASES.filter((release) => release.date === null).map((r) => r.version)).toContain(
      '1.21.0',
    );
  });

  it('normalises the hotfixes of the legacy notes', () => {
    const hotfixes = RELEASES.filter((release) => release.hotfix !== undefined).map(
      (release) => [release.version, release.hotfix] as const,
    );
    expect(hotfixes).toEqual([
      ['1.19.0', { number: 7, date: '2026-06-09' }],
      ['1.18.1', { number: 6, date: '2026-01-13' }],
      ['1.18.0', { number: 6, date: '2025-06-03' }],
    ]);
  });

  it('has a non-empty text for every item and something to say for every release', () => {
    for (const release of RELEASES) {
      expect(release.features.length + release.fixes.length).toBeGreaterThan(0);
      for (const text of [...release.features, ...release.fixes, ...(release.notes ?? [])]) {
        expect(text).toBe(text.trim());
        expect(text).not.toBe('');
        expect(text).not.toContain('{Fix}');
      }
    }
  });

  it('keeps the notices of the versions that had a Note section', () => {
    const withNotes = RELEASES.filter((release) => release.notes !== undefined);
    expect(withNotes.map((release) => release.version)).toEqual(['1.16.0', '1.11.0', '1.5.0']);
    expect(withNotes[0].notes?.[0]).toContain('stessa versione aggiornata');
  });

  it('links an archive only for the versions the legacy linked, and not for 1.21.0', () => {
    expect(
      RELEASES.filter((release) => release.downloadable).map((release) => release.version),
    ).toEqual(['1.20.0', '1.19.0', '1.18.1', '1.18.0', '1.17.2', '1.17.1', '1.17.0', '1.16.0']);
  });

  it('no longer contains the typos of the legacy notes', () => {
    const text = JSON.stringify(RELEASES);
    for (const typo of ['Arrotondaminti', 'implementaizoni', 'Noifiche', 'Flad', 'satmpante']) {
      expect(text).not.toContain(typo);
    }
  });
});

describe('releaseDownloadUrl', () => {
  it('builds the external archive URL as the legacy did', () => {
    expect(RELEASES_DOWNLOAD_BASE_URL).toBe('https://www.demetrasolutions.com/APPS/RELEASES');
    expect(releaseDownloadUrl('1.20.0')).toBe(
      'https://www.demetrasolutions.com/APPS/RELEASES/Flood_1.20.0.zip',
    );
  });
});
