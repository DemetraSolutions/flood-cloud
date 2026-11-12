import {
  booleanAttribute,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { ISO_639_1, languageName } from './languages';
import { MAX_LANGUAGES } from './group.types';

interface LanguageOption {
  readonly code: string;
  readonly name: string;
}

/**
 * Multiple choice of languages (ISO 639-1) as a group of checkboxes with a filter, at most
 * {@link MAX_LANGUAGES}: once the limit is reached the unchecked ones are disabled. It follows
 * the Signal Forms value control contract (`value`, `disabled`), so it binds to a `string[]`
 * field. Names come from the runtime in the language of the interface.
 */
@Component({
  selector: 'fc-language-picker',
  imports: [TextField, TPipe],
  templateUrl: './language-picker.html',
  styleUrls: ['../../shared/ui/field.css', './language-picker.css'],
})
export class LanguagePicker {
  private readonly i18n = inject(I18nService);

  /** Legend of the group (already translated). */
  readonly label = input.required<string>();
  /** Codes of the selected languages (two-way). */
  readonly value = model<string[]>([]);
  /** Error message; empty or null when valid. */
  readonly error = input<string | null>(null);
  /** Disables the whole group. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the focus leaves a checkbox. */
  readonly blurred = output<void>();

  protected readonly errorId = uniqueId('fc-language-picker-error');
  protected readonly filter = signal('');
  protected readonly max = MAX_LANGUAGES;

  private readonly options = computed<LanguageOption[]>(() => {
    const locale = this.i18n.language() ?? DEFAULT_LANGUAGE;
    return ISO_639_1.map((code) => ({ code, name: languageName(code, locale) })).sort((a, b) =>
      a.name.localeCompare(b.name, locale),
    );
  });
  protected readonly shown = computed(() => {
    const text = this.filter().trim().toLowerCase();
    return this.options().filter(
      (option) =>
        text === '' || option.code.includes(text) || option.name.toLowerCase().includes(text),
    );
  });
  protected readonly full = computed(() => this.value().length >= MAX_LANGUAGES);

  protected isSelected(code: string): boolean {
    return this.value().includes(code);
  }

  protected toggle(code: string, checked: boolean): void {
    this.value.update((current) =>
      checked ? [...current, code] : current.filter((value) => value !== code),
    );
  }
}
