import { TestBed } from '@angular/core/testing';
import { Icon } from './icon';
import { ICONS, IconName } from './icons';

describe('Icon', () => {
  it.each(Object.keys(ICONS) as IconName[])('draws %s as a decorative svg', async (name) => {
    const fixture = TestBed.createComponent(Icon);
    fixture.componentRef.setInput('name', name);
    await fixture.whenStable();
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(ICONS[name]);
  });

  it('includes the icons required by the shell', () => {
    for (const name of ['menu', 'close', 'chevron-right', 'check', 'alert', 'info', 'error']) {
      expect(Object.keys(ICONS)).toContain(name);
    }
    for (const name of ['sun', 'moon', 'plus', 'search', 'logout']) {
      expect(Object.keys(ICONS)).toContain(name);
    }
  });
});
