import { Component, computed, inject } from '@angular/core';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { Select } from '../../shared/ui/select/select';
import { I18nService } from '../i18n/i18n.service';
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from '../i18n/language';

/**
 * Header control to switch language without reloading. It lists every supported language
 * (today only Italian), so adding a dictionary is enough to make it selectable.
 */
@Component({
  selector: 'fc-language-selector',
  imports: [Select],
  template: `<fc-select
    [label]="i18n.t('LANGUAGE.LABEL')"
    [options]="options()"
    [value]="i18n.language() ?? ''"
    (valueChange)="choose($event)"
  />`,
})
export class LanguageSelector {
  protected readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  protected readonly options = computed(() =>
    SUPPORTED_LANGUAGES.map((language) => ({
      value: language,
      label: this.i18n.t(`LANGUAGE.NAME.${language.toUpperCase()}`),
    })),
  );

  protected async choose(value: string): Promise<void> {
    if (!isSupportedLanguage(value)) {
      return;
    }
    try {
      await this.i18n.select(value);
    } catch (error) {
      console.error(error);
      this.toast.error(this.i18n.t('ERRORS.GENERIC.MESSAGE'));
    }
  }
}
