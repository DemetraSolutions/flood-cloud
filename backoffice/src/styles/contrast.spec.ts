import { readFileSync } from 'node:fs';

/** Parses `oklch(L% C H [/ A])` into linear-light sRGB and returns the WCAG relative luminance. */
function luminance(oklch: string): number {
  const match = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/.exec(oklch);
  if (match === null) {
    throw new Error(`Not an oklch color: ${oklch}`);
  }
  const L = Number(match[1]) / 100;
  const C = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(`${process.cwd()}/src/styles/themes.css`, 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--color-[\w-]+):\s*(oklch\([^;]+\));/g)].map((m) => [m[1], m[2]]),
  );
}

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const light = tokens(blockAfter(':root {'));
const dark = tokens(blockAfter(":root:not([data-theme='light']) {"));
const darkOverride = tokens(blockAfter(":root[data-theme='dark'] {"));

/** [foreground, background, minimum ratio]. Text pairs need 4.5, non-text components 3. */
const PAIRS: [string, string, number][] = [
  ['--color-text', '--color-bg', 4.5],
  ['--color-text', '--color-surface', 4.5],
  ['--color-text', '--color-surface-muted', 4.5],
  ['--color-text-muted', '--color-bg', 4.5],
  ['--color-text-muted', '--color-surface', 4.5],
  ['--color-text-muted', '--color-surface-muted', 4.5],
  ['--color-primary', '--color-bg', 4.5],
  ['--color-primary', '--color-surface', 4.5],
  ['--color-on-primary', '--color-primary', 4.5],
  ['--color-on-primary', '--color-primary-hover', 4.5],
  ['--color-on-primary-soft', '--color-primary-soft', 4.5],
  ['--color-success', '--color-surface', 4.5],
  ['--color-on-success-soft', '--color-success-soft', 4.5],
  ['--color-warning', '--color-surface', 4.5],
  ['--color-on-warning-soft', '--color-warning-soft', 4.5],
  ['--color-danger', '--color-surface', 4.5],
  ['--color-on-danger', '--color-danger', 4.5],
  ['--color-on-danger', '--color-danger-hover', 4.5],
  ['--color-on-danger-soft', '--color-danger-soft', 4.5],
  ['--color-border-strong', '--color-surface', 3],
  ['--color-border-strong', '--color-bg', 3],
  ['--color-focus', '--color-bg', 3],
  ['--color-focus', '--color-surface', 3],
];

describe('theme tokens', () => {
  it('defines the same tokens in both themes', () => {
    expect(Object.keys(light).length).toBeGreaterThan(20);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('uses identical dark values for the media query and the explicit override', () => {
    expect(darkOverride).toEqual(dark);
  });

  describe.each([
    ['light', light],
    ['dark', dark],
  ])('%s theme contrast (WCAG 2.2 AA)', (_name, theme) => {
    it.each(PAIRS)('%s on %s reaches %d:1 or more', (foreground, background, minimum) => {
      expect(ratio(theme[foreground], theme[background])).toBeGreaterThanOrEqual(minimum);
    });
  });

  it('rejects colors that are not oklch', () => {
    expect(() => luminance('red')).toThrow('Not an oklch color');
  });
});
