import { TestBed } from '@angular/core/testing';
import { isThemeChoice, THEME_STORAGE_KEY, ThemeService } from './theme.service';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('ThemeService', () => {
  it('starts with the system theme and no data-theme attribute', () => {
    const service = TestBed.inject(ThemeService);
    expect(service.choice()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('restores the saved choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const service = TestBed.inject(ThemeService);
    expect(service.choice()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores an invalid saved choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(TestBed.inject(ThemeService).choice()).toBe('system');
  });

  it('applies and saves a choice, and clears the attribute for system', () => {
    const service = TestBed.inject(ThemeService);
    service.select('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    service.select('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('validates choices', () => {
    expect(isThemeChoice('dark')).toBe(true);
    expect(isThemeChoice('x')).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });
});
