import { inject, Pipe, PipeTransform } from '@angular/core';
import { TranslateParams } from './dictionary';
import { I18nService } from './i18n.service';

/**
 * Template translation: `{{ 'common.retry' | t }}`, `{{ 'greeting' | t: { name } }}`.
 * Impure so that it re-evaluates on language change; the work is a signal read and a map lookup.
 */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: string, params?: TranslateParams): string {
    return this.i18n.t(key, params);
  }
}
