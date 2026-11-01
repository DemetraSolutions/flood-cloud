import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { I18nService } from '../i18n/i18n.service';
import { ThemeService } from '../theme/theme.service';
import { LanguageSelector } from './language-selector';
import { ThemeSelector } from './theme-selector';

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

function change(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

describe('ThemeSelector', () => {
  it('lists the three choices and applies the selected one', async () => {
    const fixture = TestBed.createComponent(ThemeSelector);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const select = root.querySelector('select')!;
    expect(root.querySelector('label')?.textContent).toBe('[THEME.LABEL]');
    expect([...select.options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['system', '[THEME.SYSTEM]'],
      ['light', '[THEME.LIGHT]'],
      ['dark', '[THEME.DARK]'],
    ]);
    change(select, 'dark');
    await fixture.whenStable();
    expect(TestBed.inject(ThemeService).choice()).toBe('dark');
  });

  it('ignores a value that is not a theme', async () => {
    const fixture = TestBed.createComponent(ThemeSelector);
    await fixture.whenStable();
    const select = (fixture.nativeElement as HTMLElement).querySelector('select')!;
    select.innerHTML += '<option value="neon">neon</option>';
    change(select, 'neon');
    expect(TestBed.inject(ThemeService).choice()).toBe('system');
  });
});

describe('LanguageSelector', () => {
  async function render(loaded = true) {
    const i18n = TestBed.inject(I18nService);
    if (loaded) {
      vi.spyOn(i18n, 'language').mockReturnValue('it');
    }
    const fixture = TestBed.createComponent(LanguageSelector);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { i18n, fixture, root, select: root.querySelector('select')! };
  }

  it('lists the supported languages with the current one selected', async () => {
    const { root, select } = await render();
    expect(root.querySelector('label')?.textContent).toBe('[LANGUAGE.LABEL]');
    expect([...select.options].map((o) => o.value)).toEqual(['it']);
    expect(select.value).toBe('it');
  });

  it('switches language through the service', async () => {
    const { i18n, select } = await render(false);
    const use = vi.spyOn(i18n, 'select').mockResolvedValue();
    change(select, 'it');
    expect(use).toHaveBeenCalledWith('it');
  });

  it('shows no selection while no language is loaded', async () => {
    const i18n = TestBed.inject(I18nService);
    const fixture = TestBed.createComponent(LanguageSelector);
    await fixture.whenStable();
    expect(i18n.language()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('select')?.value).toBe('it');
  });

  it('ignores unsupported values', async () => {
    const { i18n, select } = await render();
    const use = vi.spyOn(i18n, 'select').mockResolvedValue();
    select.innerHTML += '<option value="xx">xx</option>';
    change(select, 'xx');
    expect(use).not.toHaveBeenCalled();
  });

  it('logs and notifies the user when the dictionary cannot be loaded', async () => {
    const { i18n, select, fixture } = await render(false);
    const failure = new Error('network');
    vi.spyOn(i18n, 'select').mockRejectedValue(failure);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    change(select, 'it');
    await fixture.whenStable();
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith(failure);
    expect(TestBed.inject(ToastService).toasts().length).toBe(1);
  });
});
