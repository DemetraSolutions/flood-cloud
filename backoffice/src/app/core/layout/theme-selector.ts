import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';
import { Select } from '../../shared/ui/select/select';
import { isThemeChoice, THEME_CHOICES, ThemeService } from '../theme/theme.service';

/** Header control to choose between automatic, light and dark theme. */
@Component({
  selector: 'fc-theme-selector',
  imports: [Select],
  template: `<fc-select
    [label]="i18n.t('THEME.LABEL')"
    [options]="options()"
    [value]="theme.choice()"
    (valueChange)="choose($event)"
  />`,
})
export class ThemeSelector {
  protected readonly i18n = inject(I18nService);
  protected readonly theme = inject(ThemeService);

  protected readonly options = computed(() =>
    THEME_CHOICES.map((choice) => ({
      value: choice,
      label: this.i18n.t(`THEME.${choice.toUpperCase()}`),
    })),
  );

  protected choose(value: string): void {
    if (isThemeChoice(value)) {
      this.theme.select(value);
    }
  }
}
